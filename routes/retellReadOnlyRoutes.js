import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { ReadOnlyBusinessTools, readFailure } from '../services/voice/retell/ReadOnlyBusinessTools.js';

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const ownKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const toolNames = Object.freeze({ context: 'read_business_context', availability: 'check_bundle_availability' });
const reasons = new Set(['BUSINESS_UNAVAILABLE', 'INVALID_SCHEDULE', 'INVALID_CATALOGUE', 'BUSINESS_CHANGED',
  'UNKNOWN_SERVICE', 'UNSUPPORTED_BUNDLE', 'INVALID_SLOT', 'READ_STALE', 'CALL_NOT_AUTHORIZED', 'READ_DEADLINE']);

// Public Retell contract: HMAC-SHA256(exact raw bytes + timestamp), five-minute window.
// Key is injected by composition; this module never inspects credentials/environment.
export function verifyRetellSignature(raw, signature, signingKey, nowMs) {
  if (!Buffer.isBuffer(raw) || typeof signingKey !== 'string' || !signingKey.length || typeof signature !== 'string') return false;
  const parts = /^v=(\d{1,16}),d=([a-fA-F0-9]{64})$/.exec(signature);
  if (!parts || !Number.isFinite(nowMs) || !Number.isSafeInteger(Number(parts[1])) || Math.abs(nowMs - Number(parts[1])) > 300000) return false;
  const expected = createHmac('sha256', signingKey).update(raw).update(parts[1]).digest();
  return timingSafeEqual(expected, Buffer.from(parts[2], 'hex'));
}

// Mounted disabled by server.js before JSON parsing. All dependencies, including
// a trusted server-owned call binding repository, are mandatory when enabled.
export function createRetellReadOnlyRouter({ enabled = false, allowedBusinessIds = [], signingKey,
  callBindings, businessRepository, appointmentRepository, now = () => new Date(),
  deadlineMs = 3000, audit = () => {} } = {}) {
  const router = express.Router();
  if (enabled !== true) { router.use((_req, res) => res.status(404).json({ reasonCode: 'NOT_ENABLED' })); return router; }
  if (!Array.isArray(allowedBusinessIds) || !allowedBusinessIds.length || allowedBusinessIds.length > 16
    || allowedBusinessIds.some(id => typeof id !== 'string' || !/^[a-f\d]{24}$/.test(id))
    || typeof signingKey !== 'string' || !signingKey.length || typeof callBindings?.findByProviderCallId !== 'function'
    || !Number.isInteger(deadlineMs) || deadlineMs < 10 || deadlineMs > 3000)
    throw readFailure('READ_CONFIGURATION_INVALID');
  const allowed = new Set(allowedBusinessIds);
  new ReadOnlyBusinessTools({ businessRepository, appointmentRepository, now });
  let inFlight = 0;
  router.use(express.raw({ type: 'application/json', limit: '128kb', inflate: false }));
  for (const [path, name] of Object.entries(toolNames)) router.post(`/tools/${path}`, async (req, res) => {
    let auditContext = {};
    const emit = (status, reasonCode) => { try { audit({ event: 'RETELL_READ_ONLY_TOOL', tool: name, ...auditContext, status, reasonCode }); } catch {} };
    const fail = (httpStatus, reasonCode) => { emit('REJECTED', reasonCode); return res.status(httpStatus).json({ status: 'REJECTED', reasonCode }); };
    if (!verifyRetellSignature(req.body, req.get('x-retell-signature'), signingKey, new Date(now()).getTime())) return fail(401, 'AUTHENTICATION_FAILED');
    let request;
    try { request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(req.body)); }
    catch { return fail(400, 'INVALID_REQUEST'); }
    if (!ownKeys(request, ['name', 'call', 'args']) || request.name !== name || !request.call
      || !identifier(request.call.call_id) || !identifier(request.call.agent_id)
      || !Number.isSafeInteger(request.call.agent_version) || request.call.agent_version < 0
      || request.call.call_status !== 'ongoing') return fail(400, 'INVALID_REQUEST');
    const args = request.args;
    if (path === 'context' ? !ownKeys(args, []) : !ownKeys(args, ['serviceIds', 'date', 'time', 'businessRevision'])
      || !Array.isArray(args.serviceIds) || args.serviceIds.length < 1 || args.serviceIds.length > 8
      || args.serviceIds.some(id => !identifier(id)) || new Set(args.serviceIds).size !== args.serviceIds.length
      || typeof args.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)
      || typeof args.time !== 'string' || !/^\d{2}:\d{2}$/.test(args.time)
      || typeof args.businessRevision !== 'string' || !/^[a-f0-9]{64}$/.test(args.businessRevision))
      return fail(400, 'INVALID_ARGUMENTS');
    if (inFlight >= 32) return fail(429, 'READ_CAPACITY');
    inFlight++;
    const controller = new AbortController();
    const closed = () => controller.abort();
    res.on('close', closed);
    let timer;
    const assertCurrent = () => { if (controller.signal.aborted) throw readFailure('READ_DEADLINE'); };
    const binding = async () => {
      assertCurrent();
      const b = await callBindings.findByProviderCallId(request.call.call_id);
      assertCurrent();
      if (!b || b.provider !== 'retell' || b.mode !== 'READ_ONLY' || b.status !== 'ACTIVE'
        || b.callId !== request.call.call_id || b.agentId !== request.call.agent_id || b.agentVersion !== request.call.agent_version
        || !allowed.has(b.businessId) || !['en', 'es'].includes(b.language)
        || !identifier(b.parentCallSid) || !Number.isSafeInteger(b.revision) || b.revision < 1
        || !Number.isFinite(new Date(b.expiresAt).getTime()) || new Date(b.expiresAt).getTime() <= new Date(now()).getTime())
        throw readFailure('CALL_NOT_AUTHORIZED');
      return { provider: b.provider, mode: b.mode, status: b.status, callId: b.callId,
        businessId: b.businessId, agentId: b.agentId, agentVersion: b.agentVersion,
        language: b.language, parentCallSid: b.parentCallSid, revision: b.revision,
        expiresAt: new Date(b.expiresAt).toISOString() };
    };
    try {
      const work = async () => {
        const b = await binding();
        auditContext = { callId: b.callId, parentCallSid: b.parentCallSid, bindingRevision: b.revision };
        const service = new ReadOnlyBusinessTools({ businessRepository, appointmentRepository, now, signal: controller.signal });
        const result = path === 'context' ? await service.context(b) : await service.availability(b, args);
        const currentContext = await service.context(b);
        if (currentContext.businessRevision !== result.businessRevision) throw readFailure('BUSINESS_CHANGED');
        const latest = await binding();
        if (JSON.stringify(latest) !== JSON.stringify(b)) throw readFailure('CALL_NOT_AUTHORIZED');
        assertCurrent();
        if (path === 'availability' && result.data) {
          const snapshot = { data: currentContext.data, window: currentContext.data.window };
          const future = slot => service.parseSlot(slot.date, slot.time, snapshot)?.valueOf() > service.instant().getTime();
          if (result.data.available && !future(result.data.requestedSlot)) throw readFailure('READ_STALE');
          result.data.alternatives = result.data.alternatives.filter(future);
        }
        return result;
      };
      // A repository that ignores cancellation retains its capacity slot until settled.
      // Deadlines stop further reads/release; they cannot cancel an underlying DB read.
      const task = work().finally(() => { inFlight--; });
      const result = await Promise.race([task, new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(readFailure('READ_DEADLINE')); }, deadlineMs);
      })]);
      if (!res.destroyed) { emit(result.status, result.reasonCode ?? result.data?.reasonCode ?? null); res.json(result); }
    } catch (error) {
      const reason = reasons.has(error?.readReason) ? error.readReason : 'READ_UNAVAILABLE';
      if (!res.destroyed) fail(reason === 'CALL_NOT_AUTHORIZED' ? 403 : reason === 'READ_DEADLINE' || reason === 'READ_UNAVAILABLE' ? 503 : 409, reason);
    } finally {
      clearTimeout(timer); controller.abort(); res.off('close', closed);
    }
  });
  router.use((_req, res) => res.status(404).json({ reasonCode: 'UNKNOWN_TOOL' }));
  router.use((error, _req, res, _next) => res.status(error?.type === 'entity.too.large' ? 413 : 400).json({ reasonCode: 'INVALID_REQUEST' }));
  return router;
}
