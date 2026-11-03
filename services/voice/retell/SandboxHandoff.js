import twilio from 'twilio';
import { validateTwilioTransportRequest } from '../../security/twilioTransportAuth.js';
import { resolveBusinessByCalledNumber } from '../../business/resolveBusinessByCalledNumber.js';
import { bridgeDurationSeconds } from './SandboxCallDuration.js';

const paths = Object.freeze({ fallback: '/api/voice/dial-fallback', screen: '/api/voice/retell-sandbox/screen',
  status: '/api/voice/retell-sandbox/status', complete: '/api/voice/retell-sandbox/complete' });
const callId = id => typeof id === 'string' && /^CA[a-f\d]{32}$/.test(id);
const xml = (failed = false) => { const r = new twilio.twiml.VoiceResponse(); if (failed) r.say('We are experiencing issues. Please try again later.'); r.hangup(); return r.toString(); };

// No environment/network dependency: only explicitly injected registration and
// durable repositories. Production never installs this object by default.
export function createRetellSandboxHandoff({ enabled = false, executionEnabled = false, businessId, budgetId,
  repository, budgets, lifecycle, twilioAuth = {}, resolveBusiness = resolveBusinessByCalledNumber,
  now = () => new Date(), audit = event => console.info(event) } = {}) {
  if (enabled !== true || executionEnabled !== true) return Object.freeze({ enabled: false, selected: () => false,
    observeIncoming: async () => {}, fallback: async () => null, webhook: async () => ({ status: 404, twiml: xml() }) });
  if (!/^[a-f\d]{24}$/.test(businessId || '') || !/^[A-Za-z0-9_-]{8,80}$/.test(budgetId || '') || !repository || !budgets || !lifecycle)
    throw Error('SANDBOX_CONFIGURATION_INVALID');
  const origin = new URL(twilioAuth.appBaseUrl);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password)
    throw Error('SANDBOX_CONFIGURATION_INVALID');
  const selected = id => String(id) === businessId;
  const emit = (parent, stage, reasonCode, extra = {}) => {
    try { audit({ event: 'RETELL_SANDBOX_HANDOFF', callSid: callId(parent) ? parent : null, stage, reasonCode, ...extra }); } catch {}
  };
  const reply = (parent, status, reasonCode, failed = false) => {
    emit(parent, 'FALLBACK_RESULT', reasonCode, { httpStatus: status, hasSip: false, hasFailureMessage: failed });
    return { status, twiml: xml(failed) };
  };
  const auth = (req, kind) => req.originalUrl === paths[kind] && validateTwilioTransportRequest({ ...twilioAuth,
    signature: req.headers?.['x-twilio-signature'], params: req.body, requestPath: paths[kind] }).valid;
  const retire = async parent => {
    const row = await repository.findByParentCallId(parent);
    if (row?.businessId === businessId) await lifecycle.supersede({ parentCallSid: parent, ownerEpoch: row.ownerEpoch });
    await budgets.end(budgetId, parent, now());
  };
  const current = async parent => {
    const [row, budget] = await Promise.all([repository.findByParentCallId(parent), budgets.find(budgetId, parent)]);
    return row && budget && row.businessId === businessId && budget.businessId === businessId
      && budget.parentCallSid === parent && budget.ownerEpoch === row.ownerEpoch && budget.status === 'BRIDGE_RESERVED'
      && ['REGISTERED', 'ACTIVE'].includes(row.status) && row.providerCallId && row.bridgeRequired === true
      && row.bridgeReservedAt && +new Date(row.expiresAt) > +now() && +new Date(row.bridgeExpiresAt) > +now()
      && +new Date(budget.bridgeExpiresAt) > +now() ? { row, budget } : null;
  };
  return Object.freeze({ enabled: true, selected,
    async observeIncoming(req, resolvedBusinessId) {
      if (!selected(resolvedBusinessId)) { emit(req.body?.CallSid, 'INCOMING_OBSERVATION', 'BUSINESS_NOT_SELECTED'); return; }
      // Failure cannot block human ringing; it leaves no usable registration for fallback.
      const result = await lifecycle.observeIncoming({ params: req.body, signature: req.headers?.['x-twilio-signature'] });
      const reasons = new Set(['UNTRUSTED_INCOMING_CALL','BUSINESS_NOT_ALLOWED','CALL_ALREADY_OWNED','REGISTRATION_UNAVAILABLE']);
      emit(req.body?.CallSid, 'INCOMING_OBSERVATION', result?.observed === true ? 'CALL_OBSERVED'
        : reasons.has(result?.reasonCode) ? result.reasonCode : 'OBSERVATION_NOT_ACCEPTED', {
        toPresent: typeof req.body?.To === 'string', calledPresent: typeof req.body?.Called === 'string',
        calledEqualsTo: typeof req.body?.Called === 'string' ? req.body.Called === req.body.To : null,
      });
    },
    async fallback(req) {
      let parent = req.body?.CallSid;
      let stage = 'BUSINESS_RESOLUTION';
      try {
        // An enabled sandbox performs its own enforced verification; an invalid
        // request must never fall through into the legacy AI owner.
        const business = await resolveBusiness(req.body.To);
        if (!selected(business?.businessId)) { emit(parent, stage, 'BUSINESS_NOT_SELECTED'); return null; }
        if (!auth(req, 'fallback')) return reply(parent, 403, 'FALLBACK_AUTHENTICATION_FAILED');
        if (!callId(parent)) return reply(parent, 400, 'INVALID_PARENT_CALL_ID');
        stage = 'DIAL_STATUS';
        if (req.body.DialCallStatus === 'completed') { await retire(parent); return reply(parent, 200, 'MOBILE_DIAL_COMPLETED'); }
        if (!['no-answer', 'busy', 'failed', 'canceled'].includes(req.body.DialCallStatus)) {
          await retire(parent); return reply(parent, 200, 'UNSUPPORTED_DIAL_STATUS', true);
        }
        stage = 'OBSERVATION_READ';
        const row = await repository.findByParentCallId(parent);
        if (!row) return reply(parent, 200, 'OBSERVATION_MISSING', true);
        if (row.businessId !== businessId) return reply(parent, 200, 'OBSERVATION_BUSINESS_MISMATCH', true);
        if (row.status !== 'OBSERVED') return reply(parent, 200, 'REGISTRATION_NOT_OBSERVED', true);
        if (!row.bridgeRequired) return reply(parent, 200, 'BRIDGE_NOT_REQUIRED', true);
        if (+new Date(row.expiresAt) <= +now()) return reply(parent, 200, 'REGISTRATION_EXPIRED', true);
        stage = 'BUDGET_CLAIM';
        const budget = await budgets.claim({ _id: budgetId, businessId, parentCallSid: parent, ownerEpoch: row.ownerEpoch,
          bridgeDurationSeconds: bridgeDurationSeconds(row),
          status: 'CLAIMED', setupExpiresAt: new Date(+now() + 30000) }, { attemptId: row.attemptId });
        // Duplicate requests never return the SIP TwiML again. No registration retry.
        if (!budget) return reply(parent, 200, 'BUDGET_CLAIM_NOT_ACQUIRED');
        stage = 'REGISTRATION';
        const registered = await lifecycle.register({ parentCallSid: parent, ownerEpoch: row.ownerEpoch });
        if (!registered.registered) throw Error('REGISTRATION_FAILED');
        stage = 'BINDING_READ';
        const bound = await repository.findByParentCallId(parent);
        if (bound?.providerCallId !== registered.callId || bound.ownerEpoch !== row.ownerEpoch || !/^[A-Za-z0-9_-]{1,128}$/.test(bound.providerCallId)) throw Error('BINDING_CHANGED');
        stage = 'BUDGET_RESERVATION';
        const reserved = await budgets.reserve(budgetId, parent, row.ownerEpoch, now(), bound.expiresAt);
        if (!reserved) throw Error('BUDGET_EXPIRED');
        if (bridgeDurationSeconds(reserved) !== bridgeDurationSeconds(bound)) throw Error('CALL_DURATION_MISMATCH');
        stage = 'BRIDGE_RESERVATION';
        if (!await repository.reserveBridge(bound, now(), reserved.bridgeExpiresAt)) throw Error('REGISTRATION_EXPIRED');
        stage = 'FINAL_OWNERSHIP_CHECK';
        const fresh = await current(parent); if (!fresh) throw Error('OWNER_CHANGED');
        stage = 'SIP_RENDERING';
        const response = new twilio.twiml.VoiceResponse();
        const dial = response.dial({ timeLimit: bridgeDurationSeconds(fresh.row), timeout: 20, answerOnBridge: true,
          action: `${origin.origin}${paths.complete}`, method: 'POST' });
        dial.sip({ url: `${origin.origin}${paths.screen}`, method: 'POST',
          statusCallback: `${origin.origin}${paths.status}`, statusCallbackMethod: 'POST',
          statusCallbackEvent: 'answered completed' }, `sip:${fresh.row.providerCallId}@sip.retellai.com`);
        response.hangup();
        emit(parent, 'FALLBACK_RESULT', 'SIP_BRIDGE_RETURNED', { httpStatus: 200, hasSip: true, hasFailureMessage: false });
        return { status: 200, twiml: response.toString() };
      } catch (error) {
        // Selected failures hang up with existing application-owned wording.
        // No custom AI fallback, provider retries or arbitrary exception logs.
        const safeReasons = new Set(['DEVELOPMENT_ALLOWANCE_EXHAUSTED','DEVELOPMENT_RUN_SCOPE_CONFLICT','DEVELOPMENT_CALL_SCOPE_CONFLICT']);
        emit(parent, stage, safeReasons.has(error?.safeReason) ? error.safeReason : 'HANDOFF_OPERATION_FAILED');
        try { if (callId(parent)) await retire(parent); } catch {}
        return { status: 200, twiml: xml(true) };
      }
    },
    async webhook(req, kind) {
      if (!['screen', 'status', 'complete'].includes(kind) || !auth(req, kind)) return { status: 403, twiml: xml() };
      let parent;
      try {
        parent = kind === 'complete' ? req.body.CallSid : req.body.ParentCallSid;
        const budget = await budgets.find(budgetId, parent);
        if (!callId(parent) || budget?.parentCallSid !== parent) return { status: 403, twiml: xml() };
        if (kind === 'complete') { await retire(parent); return { status: 200, twiml: xml() }; }
        if (!callId(req.body.CallSid)) return { status: 403, twiml: xml() };
        if (kind === 'screen') {
          const fresh = await current(parent);
          if (!fresh || !await budgets.screen(budgetId, parent, fresh.row.ownerEpoch, req.body.CallSid, now())) return { status: 200, twiml: xml() };
          // Final async ownership check after pinning the unique child leg.
          if (!await current(parent) || !await repository.screenBridge(fresh.row, now())) return { status: 200, twiml: xml() };
          if (!await current(parent)) return { status: 200, twiml: xml() };
          return { status: 200, twiml: new twilio.twiml.VoiceResponse().toString() };
        }
        if (budget.childCallSid !== req.body.CallSid) return { status: 403, twiml: xml() };
        if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(req.body.CallStatus)) await retire(parent);
        else if (!await current(parent)) await retire(parent);
        return { status: 200, twiml: xml() };
      } catch { try { if (callId(parent)) await retire(parent); } catch {} return { status: 503, twiml: xml() }; }
    },
  });
}
