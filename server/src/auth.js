import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { q } from './db.js';

const COOKIE = 'rto_token';
const MAX_AGE = 30 * 24 * 3600 * 1000;   // warehouse phones stay signed in for 30 days

export const hashPassword = p => bcrypt.hash(p, 10);
export const checkPassword = (p, h) => bcrypt.compare(p, h);

// Returns the token. A cookie is set too (used when the app is served from the same address as the API);
// when the app is on another site (Netlify) the browser sends the token in an Authorization header instead,
// because phones block cross-site cookies.
export function issue(res, user) {
  const token = jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: '30d' });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.prod, maxAge: MAX_AGE, path: '/' });
  return token;
}
export const clearCookie = res => res.clearCookie(COOKIE, { path: '/' });

export async function requireAuth(req, res, next) {
  try {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const token = m ? m[1] : req.cookies[COOKIE];
    if (!token) return res.status(401).json({ error: 'Sign in required' });
    const { sub } = jwt.verify(token, config.jwtSecret);
    const { rows } = await q('SELECT id, username, full_name, role, active FROM users WHERE id = $1', [sub]);
    if (!rows[0] || !rows[0].active) return res.status(401).json({ error: 'Account disabled' });
    req.user = rows[0];
    next();
  } catch (e) {
    res.status(401).json({ error: 'Sign in required' });
  }
}
export function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}
