import { Router } from 'express';
import { z } from 'zod';
import { q, tx } from '../db.js';
import { requireAuth, requireAdmin } from '../auth.js';
import { applyScanEvent, deleteScan } from '../scans.js';
import { reconcile, normAwb } from '../../../shared/engine.js';

export const dispatchRouter = Router();
dispatchRouter.use(requireAuth);

const uuid = z.string().uuid();
const notFound = msg => Object.assign(new Error(msg), { status: 404 });
const lock = (c, id) => c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [id]);   // one writer per dispatch at a time
const exists = async (c, id) => (await c.query('SELECT 1 FROM dispatches WHERE id = $1', [id])).rowCount > 0;
const badId = (...ids) => ids.some(i => !uuid.safeParse(i).success);

// Express 4 does not catch rejected promises: wrap every handler.
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => {
  if (e.status === 404) return res.status(404).json({ error: e.message });
  next(e);
});

// ---------- list / create ----------
dispatchRouter.get('/', h(async (req, res) => {
  const { rows } = await q(`
    SELECT d.id, d.name, d.courier, d.dispatch_ref AS "dispatchRef", d.status, d.created_at AS "createdAt", d.updated_at AS "updatedAt",
           (SELECT count(*)::int FROM scans s WHERE s.dispatch_id = d.id) AS "scanCount",
           (SELECT count(*)::int FROM pod_rows r JOIN pod_sections ps ON ps.id = r.section_id WHERE r.dispatch_id = d.id AND ps.include) AS "podCount",
           u.username AS "createdBy"
    FROM dispatches d LEFT JOIN users u ON u.id = d.created_by
    ORDER BY d.created_at DESC LIMIT 200`);
  res.json(rows);
}));

dispatchRouter.post('/', h(async (req, res) => {
  const p = z.object({ id: uuid, name: z.string().trim().min(1).max(120), courier: z.string().max(60).optional() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'A name is required' });
  const { rows } = await q(
    `INSERT INTO dispatches (id, name, courier, created_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET name = dispatches.name RETURNING id, name, status, created_at AS "createdAt"`,   // a retried upload is a no-op
    [p.data.id, p.data.name, p.data.courier || null, req.user.id]);
  res.status(201).json(rows[0]);
}));

// ---------- read one ----------
export async function loadDispatch(id) {
  const d = (await q(`SELECT id, name, courier, dispatch_ref AS "dispatchRef", status, notes, pod_meta AS meta,
                      created_at AS "createdAt", updated_at AS "updatedAt" FROM dispatches WHERE id = $1`, [id])).rows[0];
  if (!d) return null;
  const scans = (await q(`SELECT s.id, s.awb, s.first_scanned_at AS t, s.source AS src, s.times_scanned AS times, u.username AS "by"
                          FROM scans s LEFT JOIN users u ON u.id = s.scanned_by WHERE s.dispatch_id = $1
                          ORDER BY s.first_scanned_at DESC, s.id`, [id])).rows.map(s => ({ ...s, t: new Date(s.t).getTime() }));
  const repeats = (await q(`SELECT e.awb_read AS awb, s.awb AS "of", e.scanned_at AS t, e.source AS src
                            FROM scan_events e JOIN scans s ON s.id = e.scan_id
                            WHERE e.dispatch_id = $1 AND e.is_repeat AND NOT e.removed ORDER BY e.scanned_at DESC`, [id])).rows
    .map(r => ({ ...r, t: new Date(r.t).getTime() }));
  const secs = (await q('SELECT * FROM pod_sections WHERE dispatch_id = $1 ORDER BY position', [id])).rows;
  const podRows = (await q('SELECT * FROM pod_rows WHERE dispatch_id = $1 ORDER BY position', [id])).rows;
  const sections = secs.map(s => ({
    key: s.key, no: s.no || 0, page: s.page, company: s.company || '', service: s.service || '', header: s.header || '',
    declared: s.declared, include: s.include, manual: s.manual, label: s.label || '',
    rows: podRows.filter(r => r.section_id === s.id).map(r => ({ page: r.page, serial: r.serial, awb: r.awb, partial: r.partial, mark: r.mark }))
  }));
  const history = (await q('SELECT id, created_at AS "createdAt", summary FROM reconciliations WHERE dispatch_id = $1 ORDER BY created_at DESC LIMIT 10', [id])).rows;
  return { dispatch: d, scans, repeats, sections, history };
}
dispatchRouter.get('/:id', h(async (req, res) => {
  if (badId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  const data = await loadDispatch(req.params.id);
  if (!data) return res.status(404).json({ error: 'Dispatch not found' });
  res.json(data);
}));

dispatchRouter.patch('/:id', h(async (req, res) => {
  const p = z.object({ name: z.string().trim().min(1).max(120).optional(), notes: z.string().max(2000).optional(),
    status: z.enum(['open', 'reconciled', 'closed']).optional() }).safeParse(req.body);
  if (!p.success || badId(req.params.id)) return res.status(400).json({ error: 'Invalid change' });
  const { name, notes, status } = p.data;
  const r = await q(`UPDATE dispatches SET name = COALESCE($2, name), notes = COALESCE($3, notes), status = COALESCE($4::text, status),
                     closed_at = CASE WHEN $4::text = 'closed' THEN now() WHEN $4::text IS NOT NULL THEN NULL ELSE closed_at END, updated_at = now()
                     WHERE id = $1`, [req.params.id, name ?? null, notes ?? null, status ?? null]);
  if (!r.rowCount) return res.status(404).json({ error: 'Dispatch not found' });
  res.json({ ok: true });
}));
dispatchRouter.delete('/:id', requireAdmin, h(async (req, res) => {
  if (badId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  await q('DELETE FROM dispatches WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- scans ----------
const scanEvent = z.object({ id: uuid, awb: z.string().min(1).max(60), t: z.number().int().positive(), src: z.string().max(20).optional(), scanId: uuid.optional() });
dispatchRouter.post('/:id/scans', h(async (req, res) => {
  const p = z.object({ scans: z.array(scanEvent).min(1).max(500) }).safeParse(req.body);
  if (!p.success || badId(req.params.id)) return res.status(400).json({ error: 'Invalid scans' });
  const counts = { new: 0, repeat: 0, seen: 0, invalid: 0 };
  await tx(async c => {
    await lock(c, req.params.id);
    if (!(await exists(c, req.params.id))) throw notFound('Dispatch not found');
    for (const ev of p.data.scans) counts[await applyScanEvent(c, req.params.id, ev, req.user.id)]++;
    await c.query('UPDATE dispatches SET updated_at = now() WHERE id = $1', [req.params.id]);
  });
  res.json(counts);
}));
dispatchRouter.delete('/:id/scans/:scanId', h(async (req, res) => {
  if (badId(req.params.id, req.params.scanId)) return res.status(400).json({ error: 'Bad id' });
  await tx(async c => { await lock(c, req.params.id); await deleteScan(c, req.params.id, req.params.scanId); });
  res.json({ ok: true });
}));

// ---------- POD (replaced as a whole each time it is read or edited) ----------
const podRow = z.object({
  page: z.number().int().nullable().optional(), serial: z.number().int().nullable().optional(),
  awb: z.string().max(60), partial: z.boolean().optional(), mark: z.enum(['', 'X', 'D']).optional()
});
const podSection = z.object({
  key: z.string().max(20), no: z.number().int().nullable().optional(), page: z.number().int().nullable().optional(),
  company: z.string().max(200).optional(), service: z.string().max(200).optional(), header: z.string().max(1000).optional(),
  declared: z.number().int().nullable().optional(), include: z.boolean().optional(), manual: z.boolean().optional(), label: z.string().max(300).optional(),
  rows: z.array(podRow).max(2000)
});
dispatchRouter.put('/:id/pod', h(async (req, res) => {
  const p = z.object({ sections: z.array(podSection).max(200), meta: z.array(z.record(z.string(), z.any())).max(100) }).safeParse(req.body);
  if (!p.success || badId(req.params.id)) return res.status(400).json({ error: 'Invalid POD data' });
  const id = req.params.id;
  await tx(async c => {
    await lock(c, id);
    if (!(await exists(c, id))) throw notFound('Dispatch not found');
    await c.query('DELETE FROM pod_sections WHERE dispatch_id = $1', [id]);     // rows go with it (cascade)
    let pos = 0;
    for (const s of p.data.sections) {
      const sid = (await c.query(
        `INSERT INTO pod_sections (dispatch_id, key, position, no, page, company, service, header, declared, include, manual, label)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [id, s.key, pos++, s.no ?? null, s.page ?? null, s.company || '', s.service || '', s.header || '', s.declared ?? null, !!s.include, !!s.manual, s.label || ''])).rows[0].id;
      let rp = 0;
      for (const r of s.rows)
        await c.query('INSERT INTO pod_rows (section_id, dispatch_id, position, page, serial, awb, partial, mark) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [sid, id, rp++, r.page ?? null, r.serial ?? null, normAwb(r.awb), !!r.partial, r.mark || '']);
    }
    const ref = (p.data.meta.find(m => m.dispatch_id) || {}).dispatch_id || null;
    const courier = (p.data.meta.find(m => m.courier) || {}).courier || null;
    await c.query('UPDATE dispatches SET pod_meta = $2, dispatch_ref = COALESCE($3, dispatch_ref), courier = COALESCE($4, courier), updated_at = now() WHERE id = $1',
      [id, JSON.stringify(p.data.meta), ref, courier]);
  });
  res.json({ ok: true });
}));

// ---------- reconcile + saved results ----------
export function summarize(result) {
  const c = {};
  [...result.rows, ...result.extras].forEach(r => { c[r.status] = (c[r.status] || 0) + 1; });
  return { podPackages: result.rows.length - (c.pod_duplicate || 0), scanned: result.scanCount, counts: c };
}
dispatchRouter.post('/:id/reconcile', h(async (req, res) => {
  if (badId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  const data = await loadDispatch(req.params.id);
  if (!data) return res.status(404).json({ error: 'Dispatch not found' });
  const pod = data.sections.filter(s => s.include)
    .flatMap(s => s.rows.map(r => ({ ...r, section: s.label + (s.service ? ' · ' + s.service : ''), sectionKey: s.key })));
  if (!pod.length) return res.status(400).json({ error: 'No POD rows selected yet. Read the POD and tick your company first.' });
  if (!data.scans.length) return res.status(400).json({ error: 'No scans in this dispatch yet.' });
  const result = reconcile(pod, data.scans.map(s => s.awb));
  result.scanCount = data.scans.length;
  const summary = summarize(result);
  const saved = (await q('INSERT INTO reconciliations (dispatch_id, created_by, summary, result) VALUES ($1, $2, $3, $4) RETURNING id, created_at AS "createdAt"',
    [req.params.id, req.user.id, JSON.stringify(summary), JSON.stringify(result)])).rows[0];
  await q(`UPDATE dispatches SET status = CASE WHEN status = 'closed' THEN status ELSE 'reconciled' END, updated_at = now() WHERE id = $1`, [req.params.id]);
  res.json({ id: saved.id, createdAt: saved.createdAt, summary, result });
}));
dispatchRouter.get('/:id/reconciliations/:rid', h(async (req, res) => {
  if (badId(req.params.id, req.params.rid)) return res.status(400).json({ error: 'Bad id' });
  const r = (await q('SELECT id, created_at AS "createdAt", summary, result FROM reconciliations WHERE id = $1 AND dispatch_id = $2', [req.params.rid, req.params.id])).rows[0];
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
}));
