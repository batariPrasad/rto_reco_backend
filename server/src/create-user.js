// usage: npm run create-user -- <username> <password> [admin|scanner] ["Full name"]
import { q, pool } from './db.js';
import { hashPassword } from './auth.js';

const [username, password, role = 'scanner', fullName = ''] = process.argv.slice(2);
if (!username || !password) { console.error('usage: npm run create-user -- <username> <password> [admin|scanner] ["Full name"]'); process.exit(1); }
const hash = await hashPassword(password);
await q(`INSERT INTO users (username, password_hash, role, full_name) VALUES ($1, $2, $3, $4)
         ON CONFLICT (username) DO UPDATE SET password_hash = $2, role = $3, full_name = COALESCE(NULLIF($4, ''), users.full_name), active = TRUE`,
  [username.toLowerCase(), hash, role, fullName]);
console.log('saved user ' + username + ' (' + role + ')');
await pool.end();
