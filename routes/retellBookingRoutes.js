import express from 'express';
import { TextDecoder } from 'node:util';
import { verifyRetellSignature } from './retellReadOnlyRoutes.js';
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === expected.length && expected.every(k => Object.hasOwn(value, k));
const handle = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);
const reasons = new Set(['BUSINESS_CHANGED','UNKNOWN_SERVICE','INVALID_CATALOGUE','INVALID_SCHEDULE','BUSINESS_UNAVAILABLE',
  'UNAVAILABLE','INVALID_SLOT','CALL_NOT_AUTHORIZED','IDEMPOTENCY_CONFLICT','BOOKING_BUSY','PROPOSAL_EXPIRED','MISSING_CATALOGUE_FACTS']);
export function createRetellBookingRouter({ enabled = false, signingKey, allowedBusinessIds, repository, dependencies = {}, now = () => new Date() }) {
  const router = express.Router();
  let serviceClass;
  for (const [path, name] of [['prepare-booking','prepare_booking'], ['commit-booking','commit_booking']]) router.post(`/tools/${path}`,
    express.raw({ type: 'application/json', limit: '32kb', inflate: false }), async (req, res) => {
      if (!enabled) return res.status(404).json({ status: 'REJECTED', reasonCode: 'BOOKING_NOT_ENABLED' });
      if (!verifyRetellSignature(req.body, req.get('x-retell-signature'), signingKey, +now())) return res.status(401).json({ status: 'REJECTED', reasonCode: 'AUTHENTICATION_FAILED' });
      let request;
      try { request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(req.body)); } catch { return res.status(400).json({ status: 'REJECTED', reasonCode: 'INVALID_REQUEST' }); }
      if (!keys(request,['name','call','args']) || request.name !== name || !handle(request.call?.call_id) || !handle(request.call?.agent_id)
        || !Number.isSafeInteger(request.call.agent_version) || request.call.agent_version < 0 || request.call.call_status !== 'ongoing')
        return res.status(400).json({ status: 'REJECTED', reasonCode: 'INVALID_REQUEST' });
      const a = request.args;
      const valid = name === 'prepare_booking' ? keys(a,['serviceIds','date','time','businessRevision','clientName','contactNumber'])
        && Array.isArray(a.serviceIds) && a.serviceIds.length >= 1 && a.serviceIds.length <= 8 && a.serviceIds.every(handle)
        && new Set(a.serviceIds).size === a.serviceIds.length && typeof a.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.date)
        && typeof a.time === 'string' && /^\d{2}:\d{2}$/.test(a.time) && typeof a.businessRevision === 'string' && /^[a-f\d]{64}$/.test(a.businessRevision)
        && typeof a.clientName === 'string' && a.clientName.trim().length > 0 && a.clientName.length <= 128 && !/[\x00-\x1f]/.test(a.clientName)
        && typeof a.contactNumber === 'string' && /^\+[1-9]\d{7,14}$/.test(a.contactNumber)
        : keys(a,['proposalId','confirmation']) && typeof a.proposalId === 'string' && /^[a-f\d-]{36}$/.test(a.proposalId) && a.confirmation === 'AFFIRMATIVE';
      if (!valid) return res.status(400).json({ status: 'REJECTED', reasonCode: 'INVALID_ARGUMENTS' });
      const authorize = async () => {
        const b = await repository.findByProviderCallId(request.call.call_id);
        if (!b || b.status !== 'ACTIVE' || b.provider !== 'retell' || b.callId !== request.call.call_id || b.agentId !== request.call.agent_id
          || b.agentVersion !== request.call.agent_version || b.bookingAllowed !== true || !allowedBusinessIds.includes(b.businessId)
          || +new Date(b.expiresAt) <= +now()) throw Object.assign(Error('CALL_NOT_AUTHORIZED'), { reasonCode: 'CALL_NOT_AUTHORIZED' });
        return b;
      };
      try {
        const binding = await authorize();
        serviceClass ??= import('../services/voice/retell/BookingService.js').then(m => m.RetellBookingService);
        const Service = await serviceClass;
        const service = new Service({ ...dependencies, repository, authorize, now });
        const output = name === 'prepare_booking' ? await service.prepare(binding, a) : await service.commit(binding, a);
        return res.json(output);
      } catch (error) {
        const reasonCode = reasons.has(error?.reasonCode) ? error.reasonCode : 'BOOKING_UNAVAILABLE';
        return res.status(reasonCode === 'CALL_NOT_AUTHORIZED' ? 403 : reasonCode === 'BOOKING_UNAVAILABLE' ? 503 : 409)
          .json({ status: 'REJECTED', reasonCode, ...(error?.availability ? { availability: error.availability } : {}) });
      }
    });
  router.use((error, _req, res, next) => error ? res.status(error.type === 'entity.too.large' ? 413 : 400)
    .json({ status: 'REJECTED', reasonCode: 'INVALID_REQUEST' }) : next());
  return router;
}
