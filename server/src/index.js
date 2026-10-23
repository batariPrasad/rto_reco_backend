import { config } from './config.js';
import { pool, q } from './db.js';
import { migrate } from './migrate.js';
import { hashPassword } from './auth.js';
import { buildApp } from './app.js';

if (!config.databaseUrl) { console.error('DATABASE_URL is not set (see .env.example)'); process.exit(1); }

await migrate();
// first run: create the admin from ADMIN_USERNAME / ADMIN_PASSWORD
if (config.adminUser && config.adminPass && !(await q('SELECT 1 FROM users LIMIT 1')).rowCount) {
  await q('INSERT INTO users (username, password_hash, role, full_name) VALUES ($1, $2, $3, $4)',
    [config.adminUser.toLowerCase(), await hashPassword(config.adminPass), 'admin', 'Admin']);
  console.log('created admin user ' + config.adminUser);
}
const server = buildApp().listen(config.port, () => console.log('RTO Reco server on :' + config.port));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => pool.end().then(() => process.exit(0))));
