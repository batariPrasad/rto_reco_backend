// End-to-end API test against a real throwaway PostgreSQL (embedded-postgres, no Docker needed).
// Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';

const PG_PORT = 54000 + Math.floor(Math.random() * 900);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rto-pg-'));
let pg, server, base, pool;
const jars = {};   // name -> cookie

async function api(method, url, body, who) {
  const r = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', ...(who && jars[who] ? { Cookie: jars[who] } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const setCookie = r.headers.get('set-cookie');
  if (setCookie && who) jars[who] = setCookie.split(';')[0];
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}

before(async () => {
  pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'pw', port: PG_PORT, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('rto_test');
  process.env.DATABASE_URL = `postgres://postgres:pw@localhost:${PG_PORT}/rto_test`;
  process.env.JWT_SECRET = 'test-secret';
  process.env.GEMINI_API_KEY = '';              // never use the real key from server/.env in tests
  process.env.NODE_ENV = 'test';
  process.env.CORS_ORIGIN = 'https://app.example.netlify.app';
  const { migrate } = await import('../src/migrate.js');
  await migrate(() => {});
  ({ pool } = await import('../src/db.js'));
  const { hashPassword } = await import('../src/auth.js');
  const { buildApp } = await import('../src/app.js');
  await pool.query(`INSERT INTO users (username, password_hash, role) VALUES ('admin', $1, 'admin'), ('ravi', $2, 'scanner')`,
    [await hashPassword('admin-pass'), await hashPassword('ravi-pass')]);
  server = buildApp().listen(0);
  base = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  server && server.close();
  pool && await pool.end();
  pg && await pg.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const ev = (awb, extra = {}) => ({ id: randomUUID(), awb, t: Date.now(), src: 'camera', ...extra });

test('auth: wrong password rejected, right one signs in, protected routes need a cookie', async () => {
  assert.equal((await api('POST', '/api/auth/login', { username: 'ravi', password: 'nope' })).status, 401);
  assert.equal((await api('GET', '/api/dispatches')).status, 401);
  const r = await api('POST', '/api/auth/login', { username: 'Ravi', password: 'ravi-pass' }, 'ravi');
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, 'scanner');
  assert.equal((await api('GET', '/api/auth/me', undefined, 'ravi')).body.user.username, 'ravi');
  await api('POST', '/api/auth/login', { username: 'admin', password: 'admin-pass' }, 'admin');
});

test('roles: scanner cannot manage users, admin can', async () => {
  assert.equal((await api('GET', '/api/users', undefined, 'ravi')).status, 403);
  assert.equal((await api('GET', '/api/users', undefined, 'admin')).status, 200);
  const c = await api('POST', '/api/users', { username: 'asha', password: 'secret1', role: 'scanner' }, 'admin');
  assert.equal(c.status, 201);
  assert.equal((await api('POST', '/api/users', { username: 'asha', password: 'secret1' }, 'admin')).status, 409);
});

let D;
test('dispatch: create is idempotent', async () => {
  D = randomUUID();
  assert.equal((await api('POST', '/api/dispatches', { id: D, name: 'RTO 22 Oct' }, 'ravi')).status, 201);
  assert.equal((await api('POST', '/api/dispatches', { id: D, name: 'RTO 22 Oct' }, 'ravi')).status, 201);
  const list = (await api('GET', '/api/dispatches', undefined, 'ravi')).body;
  assert.equal(list.filter(d => d.id === D).length, 1);
});

test('scans: new, repeat, same shipment with extra characters, retry-safe, invalid', async () => {
  const e1 = ev('FMPC6539003539'), e2 = ev('FMPC6539003539'), e3 = ev('SF4118903092'), e4 = ev('SF4118903092GOM'), e5 = ev('x');
  const r = await api('POST', `/api/dispatches/${D}/scans`, { scans: [e1, e2, e3, e4, e5] }, 'ravi');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { new: 2, repeat: 2, seen: 0, invalid: 1 });

  const retry = await api('POST', `/api/dispatches/${D}/scans`, { scans: [e1, e2] }, 'ravi');   // phone re-sends after a dropped connection
  assert.deepEqual(retry.body, { new: 0, repeat: 0, seen: 2, invalid: 0 });

  const d = (await api('GET', `/api/dispatches/${D}`, undefined, 'ravi')).body;
  assert.equal(d.scans.length, 2);
  const sf = d.scans.find(s => s.awb.startsWith('SF'));
  assert.equal(sf.awb, 'SF4118903092GOM');           // the fuller read wins
  assert.equal(sf.times, 2);
  assert.equal(d.scans.find(s => s.awb === 'FMPC6539003539').times, 2);
  assert.equal(d.repeats.length, 2);
});

test('scans: concurrent uploads of the same AWB are counted once', async () => {
  const awbs = Array.from({ length: 6 }, () => ev('515261298276'));
  await Promise.all(awbs.map(e => api('POST', `/api/dispatches/${D}/scans`, { scans: [e] }, 'ravi')));
  const d = (await api('GET', `/api/dispatches/${D}`, undefined, 'ravi')).body;
  const s = d.scans.filter(x => x.awb === '515261298276');
  assert.equal(s.length, 1);
  assert.equal(s[0].times, 6);
});

test('POD: save, read back, reconcile and save the result', async () => {
  const sections = [{
    key: 'S1', no: 1, page: 1, company: 'Pokonut', service: 'GOEX 250 GM SURFACE', header: 'Pokonut GOEX', declared: 4, include: true, manual: false, label: '1. Pokonut',
    rows: [
      { page: 1, serial: 1, awb: 'FMPC6539003539', partial: false, mark: '' },
      { page: 1, serial: 2, awb: 'SF4118903092GOM', partial: false, mark: '' },
      { page: 1, serial: 3, awb: '515257037933', partial: false, mark: '' },   // never scanned
      { page: 1, serial: 4, awb: '515261298276', partial: false, mark: 'D' }
    ]
  }, { key: 'S2', no: 2, page: 1, company: 'Other Co', service: '', header: '', declared: 1, include: false, manual: false, label: '2. Other Co',
       rows: [{ page: 1, serial: 1, awb: '999999999999', partial: false, mark: '' }] }];
  const put = await api('PUT', `/api/dispatches/${D}/pod`, { sections, meta: [{ page: 1, courier: 'Delhivery', dispatch_id: 'D123' }] }, 'ravi');
  assert.equal(put.status, 200);

  const d = (await api('GET', `/api/dispatches/${D}`, undefined, 'ravi')).body;
  assert.equal(d.sections.length, 2);
  assert.equal(d.sections[0].rows.length, 4);
  assert.equal(d.dispatch.dispatchRef, 'D123');

  const rec = await api('POST', `/api/dispatches/${D}/reconcile`, {}, 'ravi');
  assert.equal(rec.status, 200);
  const c = rec.body.summary.counts;
  assert.equal(c.matched, 2);                // FMPC… and SF… (POD lists the full SF…GOM read)
  assert.equal(c.damaged, 1);
  assert.equal(c.pod_not_scanned, 1);
  assert.equal(rec.body.summary.podPackages, 4);   // the other company's section is left out
  assert.equal((await api('GET', `/api/dispatches/${D}/reconciliations/${rec.body.id}`, undefined, 'ravi')).status, 200);
  assert.equal((await api('GET', `/api/dispatches/${D}`, undefined, 'ravi')).body.dispatch.status, 'reconciled');
});

test('delete scan and AWB lookup across dispatches', async () => {
  const d = (await api('GET', `/api/dispatches/${D}`, undefined, 'ravi')).body;
  const s = d.scans.find(x => x.awb === '515261298276');
  assert.equal((await api('DELETE', `/api/dispatches/${D}/scans/${s.id}`, undefined, 'ravi')).status, 200);
  assert.equal((await api('GET', `/api/dispatches/${D}`, undefined, 'ravi')).body.scans.length, 2);

  const hit = (await api('GET', '/api/awb/4118903092', undefined, 'ravi')).body;
  assert.equal(hit.scanned.length, 1);
  assert.equal(hit.onPod.length, 1);
  assert.equal((await api('GET', '/api/awb/12', undefined, 'ravi')).status, 400);
});

test('frontend on another site (Netlify): bearer token and CORS', async () => {
  const site = 'https://app.example.netlify.app';
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: site }, body: JSON.stringify({ username: 'ravi', password: 'ravi-pass' }) });
  const { token } = await login.json();
  assert.ok(token, 'login returns a token');
  assert.equal(login.headers.get('access-control-allow-origin'), site);

  // no cookie, token only
  assert.equal((await fetch(base + '/api/auth/me', { headers: { Authorization: 'Bearer ' + token, Origin: site } })).status, 200);
  assert.equal((await fetch(base + '/api/auth/me', { headers: { Authorization: 'Bearer nonsense' } })).status, 401);

  // browser preflight
  const pre = await fetch(base + '/api/dispatches', { method: 'OPTIONS', headers: { Origin: site, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers'), /authorization/i);

  // another website gets no permission
  const evil = await fetch(base + '/api/auth/me', { headers: { Authorization: 'Bearer ' + token, Origin: 'https://evil.example.com' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
});

test('bad input is rejected, not crashed on', async () => {
  assert.equal((await api('POST', '/api/dispatches', { id: 'not-a-uuid', name: 'x' }, 'ravi')).status, 400);
  assert.equal((await api('POST', `/api/dispatches/${randomUUID()}/scans`, { scans: [ev('FMPC6539003539')] }, 'ravi')).status, 404);
  assert.equal((await api('GET', '/api/dispatches/abc', undefined, 'ravi')).status, 400);
  assert.equal((await api('POST', '/api/gemini/generate', { model: 'x', body: {} }, 'ravi')).status, 503);   // no server key in the test
});
