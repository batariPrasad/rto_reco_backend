import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { q } from './db.js';
import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { dispatchRouter } from './routes/dispatches.js';
import { lookupRouter } from './routes/lookup.js';
import { geminiRouter } from './routes/gemini.js';

// Express 4 needs async route errors forwarded by hand; the routers wrap their handlers, this covers the rest.
export function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    strictTransportSecurity: config.prod,                // HSTS and https-upgrade only in production, so http://localhost and LAN tests still work
    contentSecurityPolicy: {
      directives: {
        upgradeInsecureRequests: config.prod ? [] : null,
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'], connectSrc: ["'self'"], workerSrc: ["'self'", 'blob:'], mediaSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"], frameAncestors: ["'none'"]
      }
    }
  }));
  app.use((req, res, next) => { res.setHeader('Permissions-Policy', 'camera=(self), microphone=()'); next(); });
  // browser access from the Netlify site (and the Vite dev server when not in production)
  const allowed = new Set([...config.corsOrigins, ...(config.prod ? [] : ['http://localhost:5173'])]);
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || allowed.has(origin)),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400
  }));
  app.use(cookieParser());
  app.use('/api/gemini', geminiRouter);                  // has its own larger JSON limit
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', async (req, res, next) => { try { await q('SELECT 1'); res.json({ ok: true }); } catch (e) { next(e); } });
  app.use('/api/auth', authRouter);
  app.use('/api/dispatches', dispatchRouter);
  app.use('/api', adminRouter);
  app.use('/api', lookupRouter);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // the built React app
  const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { setHeaders: (res, p) => { if (/sw\.js$|index\.html$/.test(p)) res.setHeader('Cache-Control', 'no-cache'); } }));
    app.get('/{*splat}', (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use((err, req, res, next) => {                      // eslint-disable-line no-unused-vars
    console.error(err);
    res.status(err.status || 500).json({ error: config.prod ? 'Server error' : String(err.message || err) });
  });
  return app;
}
