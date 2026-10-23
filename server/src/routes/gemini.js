// Gemini proxy: the API key stays on the server; only signed-in users can use it.
import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { requireAuth } from '../auth.js';

export const geminiRouter = Router();
const BASE = 'https://generativelanguage.googleapis.com/v1beta/';
const MODEL_OK = /^[A-Za-z0-9.\-]{3,60}$/;

geminiRouter.use(requireAuth);
geminiRouter.use(rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));

geminiRouter.get('/status', (req, res) => res.json({ configured: !!config.geminiKey }));

geminiRouter.get('/models', async (req, res) => {
  if (!config.geminiKey) return res.status(503).json({ error: { message: 'GEMINI_API_KEY is not set on the server.' } });
  const r = await fetch(BASE + 'models?pageSize=200', { headers: { 'x-goog-api-key': config.geminiKey } });
  res.status(r.status).type('json').send(await r.text());
});

geminiRouter.post('/generate', express.json({ limit: '12mb' }), async (req, res) => {
  if (!config.geminiKey) return res.status(503).json({ error: { message: 'GEMINI_API_KEY is not set on the server.' } });
  const { model, body } = req.body || {};
  if (!MODEL_OK.test(model || '') || !body || !Array.isArray(body.contents)) return res.status(400).json({ error: { message: 'model and body are required' } });
  const r = await fetch(BASE + 'models/' + encodeURIComponent(model) + ':generateContent', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiKey }, body: JSON.stringify(body)
  });
  res.status(r.status).type('json').send(await r.text());
});
