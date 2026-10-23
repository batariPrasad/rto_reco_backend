import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { q } from '../db.js';
import { checkPassword, issue, clearCookie, requireAuth } from '../auth.js';

export const authRouter = Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

const pub = u => ({ id: u.id, username: u.username, fullName: u.full_name, role: u.role });

authRouter.post('/login', limiter, async (req, res) => {
  const p = z.object({ username: z.string().min(1), password: z.string().min(1) }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Enter username and password' });
  const { rows } = await q('SELECT * FROM users WHERE username = $1', [p.data.username.trim().toLowerCase()]);
  const u = rows[0];
  if (!u || !u.active || !(await checkPassword(p.data.password, u.password_hash))) return res.status(401).json({ error: 'Wrong username or password' });
  const token = issue(res, u);
  res.json({ user: pub(u), token });
});
authRouter.post('/logout', (req, res) => { clearCookie(res); res.json({ ok: true }); });
authRouter.get('/me', requireAuth, (req, res) => res.json({ user: pub(req.user) }));
