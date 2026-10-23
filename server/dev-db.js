// Local PostgreSQL for development, no install and no Docker needed. Data is kept in server/.pgdata.
//   npm --prefix server run dev:db      (leave it running, then start the server in another terminal)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '.pgdata');
const port = Number(process.env.PGPORT || 5433);
const fresh = !fs.existsSync(path.join(dir, 'PG_VERSION'));

const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase('rto');
console.log(`PostgreSQL ready. DATABASE_URL=postgres://postgres:postgres@localhost:${port}/rto`);
const stop = async () => { await pg.stop(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
