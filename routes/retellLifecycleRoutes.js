import express from 'express';
import { TextDecoder } from 'node:util';
import { verifyRetellSignature } from './retellReadOnlyRoutes.js';

// Only signed lifecycle callbacks; no public registration/binding creator.
export function createRetellLifecycleRouter({ lifecycle, signingKey, now = () => new Date(), transcripts }) {
  const router = express.Router();
  router.post('/events', express.raw({ type: 'application/json', limit: '128kb', inflate: false }), async (req, res) => {
    if (!verifyRetellSignature(req.body, req.get('x-retell-signature'), signingKey, +now()))
      return res.status(401).json({ reasonCode: 'AUTHENTICATION_FAILED' });
    let event;
    try { event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(req.body)); }
    catch { return res.status(400).json({ reasonCode: 'INVALID_EVENT' }); }
    try {
      // Duplicate/out-of-order/unknown events never create authority. Acknowledge
      // ignored events without logging their potentially sensitive call fields.
      await lifecycle.handleEvent(event);
      // Only verified callbacks reach this optional post-call storage path.
      // Ingestion never changes registration state or grants tool authority.
      await transcripts?.ingest(event);
      return res.status(204).end();
    } catch { return res.status(503).json({ reasonCode: 'LIFECYCLE_UNAVAILABLE' }); }
  });
  router.use((error, _req, res, _next) => res.status(error?.type === 'entity.too.large' ? 413 : 400).json({ reasonCode: 'INVALID_EVENT' }));
  return router;
}
