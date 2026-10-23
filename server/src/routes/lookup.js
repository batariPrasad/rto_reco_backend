import { Router } from 'express';
import { q } from '../db.js';
import { requireAuth } from '../auth.js';
import { normAwb } from '../../../shared/engine.js';

export const lookupRouter = Router();
lookupRouter.use(requireAuth);

// Where has this AWB been scanned / listed on a POD? (handy for disputes and "did we get this back?")
lookupRouter.get('/awb/:awb', async (req, res) => {
  const awb = normAwb(req.params.awb);
  if (awb.length < 6) return res.status(400).json({ error: 'Type at least 6 characters' });
  const like = '%' + awb + '%';
  const scanned = (await q(
    `SELECT d.id AS "dispatchId", d.name, d.status, s.awb, s.first_scanned_at AS "scannedAt", s.times_scanned AS times, u.username AS "scannedBy"
     FROM scans s JOIN dispatches d ON d.id = s.dispatch_id LEFT JOIN users u ON u.id = s.scanned_by
     WHERE s.awb LIKE $1 ORDER BY s.first_scanned_at DESC LIMIT 50`, [like])).rows;
  const onPod = (await q(
    `SELECT d.id AS "dispatchId", d.name, d.status, r.awb, r.mark, r.partial, r.page, r.serial
     FROM pod_rows r JOIN dispatches d ON d.id = r.dispatch_id
     WHERE r.awb LIKE $1 ORDER BY d.created_at DESC LIMIT 50`, [like])).rows;
  res.json({ awb, scanned, onPod });
});
