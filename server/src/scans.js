// Scan handling: one row per shipment, every read kept as an event. Same rules as the phone app
// (sameShipment: an AWB read with extra/missing characters is the same parcel, counted once).
import { randomUUID } from 'node:crypto';
import { normAwb, sameShipment } from '../../shared/engine.js';

export const AWB_RE = /^[0-9A-Z]{6,30}$/;

// Must run inside a transaction. Returns 'new' | 'repeat' | 'seen' (event id already stored) | 'invalid'.
export async function applyScanEvent(c, dispatchId, ev, userId) {
  const awb = normAwb(ev.awb);
  if (!AWB_RE.test(awb)) return 'invalid';
  const t = new Date(ev.t);
  const ins = await c.query(
    `INSERT INTO scan_events (id, dispatch_id, awb_read, scanned_at, source, scanned_by)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
    [ev.id, dispatchId, awb, t, ev.src || 'camera', userId]);
  if (!ins.rowCount) return 'seen';

  const { rows } = await c.query('SELECT id, awb FROM scans WHERE dispatch_id = $1', [dispatchId]);
  const hit = rows.find(s => sameShipment(s.awb, awb));
  if (!hit) {
    const id = ev.scanId || randomUUID();
    await c.query(
      `INSERT INTO scans (id, dispatch_id, awb, first_scanned_at, source, scanned_by) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, dispatchId, awb, t, ev.src || 'camera', userId]);
    await c.query('UPDATE scan_events SET scan_id = $1 WHERE id = $2', [id, ev.id]);
    return 'new';
  }
  // keep the fuller read as the shipment's AWB (longer, or the one Excel did not cut to ...0)
  const better = (awb.length > hit.awb.length || (awb.length === hit.awb.length && /0$/.test(hit.awb) && !/0$/.test(awb)))
    && !rows.some(r => r.awb === awb);
  await c.query(
    `UPDATE scans SET times_scanned = times_scanned + 1, awb = $2, first_scanned_at = LEAST(first_scanned_at, $3) WHERE id = $1`,
    [hit.id, better ? awb : hit.awb, t]);
  await c.query('UPDATE scan_events SET scan_id = $1, is_repeat = TRUE WHERE id = $2', [hit.id, ev.id]);
  return 'repeat';
}

export async function deleteScan(c, dispatchId, scanId) {
  await c.query('UPDATE scan_events SET removed = TRUE WHERE scan_id = $1 AND dispatch_id = $2', [scanId, dispatchId]);
  const r = await c.query('DELETE FROM scans WHERE id = $1 AND dispatch_id = $2', [scanId, dispatchId]);
  return r.rowCount;
}
