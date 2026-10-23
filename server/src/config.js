import 'dotenv/config';

const prod = process.env.NODE_ENV === 'production';

// SSL to the database: hosted databases (Render, Supabase, Neon...) require it. Rules:
//   PGSSL=true/1/yes/require  -> on     PGSSL=false/0/no/disable -> off
//   not set: on in production for any database that is not on this machine, off otherwise
const dbHost = (() => { try { return new URL(process.env.DATABASE_URL || '').hostname; } catch { return ''; } })();
const dbIsLocal = /^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(dbHost);
const sslSetting = (process.env.PGSSL || '').trim().toLowerCase();
const useSsl = ['true', '1', 'yes', 'require'].includes(sslSetting)
  || (prod && !dbIsLocal && !['false', '0', 'no', 'disable'].includes(sslSetting));

export const config = {
  prod,
  port: Number(process.env.PORT || 4000),
  databaseUrl: process.env.DATABASE_URL,
  pgssl: useSsl,
  jwtSecret: process.env.JWT_SECRET || (prod ? '' : 'dev-only-secret-change-me'),
  geminiKey: process.env.GEMINI_API_KEY || '',
  adminUser: process.env.ADMIN_USERNAME || '',
  adminPass: process.env.ADMIN_PASSWORD || '',
  // websites allowed to call this API from a browser (the Netlify address), comma separated. Not needed when the API serves the app itself.
  corsOrigins: (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean)
};
if (!config.jwtSecret) throw new Error('JWT_SECRET must be set in production');
