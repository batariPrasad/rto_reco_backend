import 'dotenv/config';

const prod = process.env.NODE_ENV === 'production';
export const config = {
  prod,
  port: Number(process.env.PORT || 4000),
  databaseUrl: process.env.DATABASE_URL,
  pgssl: process.env.PGSSL === 'true',
  jwtSecret: process.env.JWT_SECRET || (prod ? '' : 'dev-only-secret-change-me'),
  geminiKey: process.env.GEMINI_API_KEY || '',
  adminUser: process.env.ADMIN_USERNAME || '',
  adminPass: process.env.ADMIN_PASSWORD || '',
  // websites allowed to call this API from a browser (the Netlify address), comma separated. Not needed when the API serves the app itself.
  corsOrigins: (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean)
};
if (!config.jwtSecret) throw new Error('JWT_SECRET must be set in production');
