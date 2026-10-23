import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db.js';
import { requireAuth, requireAdmin, hashPassword } from '../auth.js';

export const adminRouter = Router();
adminRouter.use(requireAuth);

// settings are readable by everyone signed in (company name etc.), writable by admins
adminRouter.get('/settings', async (req, res) => {
  const { rows } = await q('SELECT key, value FROM settings');
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});
adminRouter.put('/settings', requireAdmin, async (req, res) => {
  const p = z.record(z.enum(['company_name', 'company_addr', 'ignore_prefixes', 'gemini_model']), z.string().max(500)).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Invalid settings' });
  for (const [k, v] of Object.entries(p.data))
    await q('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [k, v]);
  const { rows } = await q('SELECT key, value FROM settings');
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});

adminRouter.get('/users', requireAdmin, async (req, res) => {
  const { rows } = await q('SELECT id, username, full_name AS "fullName", role, active, created_at AS "createdAt" FROM users ORDER BY id');
  res.json(rows);
});
adminRouter.post('/users', requireAdmin, async (req, res) => {
  const p = z.object({
    username: z.string().trim().min(2).max(40), password: z.string().min(6).max(100),
    fullName: z.string().max(80).optional(), role: z.enum(['admin', 'scanner']).default('scanner')
  }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Username (2+ chars), password (6+ chars) and role are required' });
  try {
    const { rows } = await q(
      'INSERT INTO users (username, password_hash, full_name, role) VALUES ($1, $2, $3, $4) RETURNING id, username, full_name AS "fullName", role, active',
      [p.data.username.toLowerCase(), await hashPassword(p.data.password), p.data.fullName || null, p.data.role]);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That username is taken' });
    throw e;
  }
});
adminRouter.patch('/users/:id', requireAdmin, async (req, res) => {
  const p = z.object({ password: z.string().min(6).max(100).optional(), role: z.enum(['admin', 'scanner']).optional(), active: z.boolean().optional() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Invalid change' });
  const id = Number(req.params.id);
  if (id === req.user.id && (p.data.active === false || (p.data.role && p.data.role !== 'admin'))) return res.status(400).json({ error: 'You cannot disable or demote yourself' });
  if (p.data.password) await q('UPDATE users SET password_hash = $2 WHERE id = $1', [id, await hashPassword(p.data.password)]);
  if (p.data.role) await q('UPDATE users SET role = $2 WHERE id = $1', [id, p.data.role]);
  if (p.data.active != null) await q('UPDATE users SET active = $2 WHERE id = $1', [id, p.data.active]);
  res.json({ ok: true });
});
