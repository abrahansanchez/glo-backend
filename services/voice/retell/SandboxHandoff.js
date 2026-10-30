import twilio from 'twilio';
import { validateTwilioTransportRequest } from '../../security/twilioTransportAuth.js';
import { resolveBusinessByCalledNumber } from '../../business/resolveBusinessByCalledNumber.js';

const paths = Object.freeze({ fallback: '/api/voice/dial-fallback', screen: '/api/voice/retell-sandbox/screen',
  status: '/api/voice/retell-sandbox/status', complete: '/api/voice/retell-sandbox/complete' });
const callId = id => typeof id === 'string' && /^CA[a-f\d]{32}$/.test(id);
const xml = (failed = false) => { const r = new twilio.twiml.VoiceResponse(); if (failed) r.say('We are experiencing issues. Please try again later.'); r.hangup(); return r.toString(); };

// No environment/network dependency: only explicitly injected registration and
// durable repositories. Production never installs this object by default.
export function createRetellSandboxHandoff({ enabled = false, executionEnabled = false, businessId, budgetId,
  repository, budgets, lifecycle, twilioAuth = {}, resolveBusiness = resolveBusinessByCalledNumber,
  now = () => new Date() } = {}) {
  if (enabled !== true || executionEnabled !== true) return Object.freeze({ enabled: false, selected: () => false,
    observeIncoming: async () => {}, fallback: async () => null, webhook: async () => ({ status: 404, twiml: xml() }) });
  if (!/^[a-f\d]{24}$/.test(businessId || '') || !/^[A-Za-z0-9_-]{8,80}$/.test(budgetId || '') || !repository || !budgets || !lifecycle)
    throw Error('SANDBOX_CONFIGURATION_INVALID');
  const origin = new URL(twilioAuth.appBaseUrl);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password)
    throw Error('SANDBOX_CONFIGURATION_INVALID');
  const selected = id => String(id) === businessId;
  const auth = (req, kind) => req.originalUrl === paths[kind] && validateTwilioTransportRequest({ ...twilioAuth,
    signature: req.headers?.['x-twilio-signature'], params: req.body, requestPath: paths[kind] }).valid;
  const retire = async parent => {
    const row = await repository.findByParentCallId(parent);
    if (row?.businessId === businessId) await lifecycle.supersede({ parentCallSid: parent, ownerEpoch: row.ownerEpoch });
    await budgets.end(budgetId, parent, now());
  };
  const current = async parent => {
    const [row, budget] = await Promise.all([repository.findByParentCallId(parent), budgets.find(budgetId)]);
    return row && budget && row.businessId === businessId && budget.businessId === businessId
      && budget.parentCallSid === parent && budget.ownerEpoch === row.ownerEpoch && budget.status === 'BRIDGE_RESERVED'
      && ['REGISTERED', 'ACTIVE'].includes(row.status) && row.providerCallId && row.bridgeRequired === true
      && row.bridgeReservedAt && +new Date(row.expiresAt) > +now() && +new Date(row.bridgeExpiresAt) > +now()
      && +new Date(budget.bridgeExpiresAt) > +now() ? { row, budget } : null;
  };
  return Object.freeze({ enabled: true, selected,
    async observeIncoming(req, resolvedBusinessId) {
      if (!selected(resolvedBusinessId)) return;
      // Failure cannot block human ringing; it leaves no usable registration for fallback.
      await lifecycle.observeIncoming({ params: req.body, signature: req.headers?.['x-twilio-signature'] });
    },
    async fallback(req) {
      let parent = req.body?.CallSid;
      try {
        // An enabled sandbox performs its own enforced verification; an invalid
        // request must never fall through into the legacy AI owner.
        const business = await resolveBusiness(req.body.To);
        if (!selected(business?.businessId)) return null;
        if (!auth(req, 'fallback')) return { status: 403, twiml: xml() };
        if (!callId(parent)) return { status: 400, twiml: xml() };
        if (req.body.DialCallStatus === 'completed') { await retire(parent); return { status: 200, twiml: xml() }; }
        if (!['no-answer', 'busy', 'failed', 'canceled'].includes(req.body.DialCallStatus)) {
          await retire(parent); return { status: 200, twiml: xml(true) };
        }
        const row = await repository.findByParentCallId(parent);
        if (!row || row.businessId !== businessId || row.status !== 'OBSERVED' || !row.bridgeRequired || +new Date(row.expiresAt) <= +now())
          return { status: 200, twiml: xml(true) };
        const budget = await budgets.claim({ _id: budgetId, businessId, parentCallSid: parent, ownerEpoch: row.ownerEpoch,
          status: 'CLAIMED', setupExpiresAt: new Date(+now() + 30000) });
        // Duplicate requests never return the SIP TwiML again. No registration retry.
        if (!budget) return { status: 200, twiml: xml() };
        const registered = await lifecycle.register({ parentCallSid: parent, ownerEpoch: row.ownerEpoch });
        if (!registered.registered) throw Error('REGISTRATION_FAILED');
        const bound = await repository.findByParentCallId(parent);
        if (bound?.providerCallId !== registered.callId || bound.ownerEpoch !== row.ownerEpoch || !/^[A-Za-z0-9_-]{1,128}$/.test(bound.providerCallId)) throw Error('BINDING_CHANGED');
        if (!await budgets.reserve(budgetId, parent, row.ownerEpoch, now())) throw Error('BUDGET_EXPIRED');
        if (!await repository.reserveBridge(bound, now())) throw Error('REGISTRATION_EXPIRED');
        const fresh = await current(parent); if (!fresh) throw Error('OWNER_CHANGED');
        const response = new twilio.twiml.VoiceResponse();
        const dial = response.dial({ timeLimit: 120, timeout: 20, answerOnBridge: true,
          action: `${origin.origin}${paths.complete}`, method: 'POST' });
        dial.sip({ url: `${origin.origin}${paths.screen}`, method: 'POST',
          statusCallback: `${origin.origin}${paths.status}`, statusCallbackMethod: 'POST',
          statusCallbackEvent: 'answered completed' }, `sip:${fresh.row.providerCallId}@sip.retellai.com`);
        response.hangup();
        return { status: 200, twiml: response.toString() };
      } catch {
        // Selected failures hang up with existing application-owned wording.
        // No custom AI fallback, provider retries or arbitrary exception logs.
        try { if (callId(parent)) await retire(parent); } catch {}
        return { status: 200, twiml: xml(true) };
      }
    },
    async webhook(req, kind) {
      if (!['screen', 'status', 'complete'].includes(kind) || !auth(req, kind)) return { status: 403, twiml: xml() };
      let parent;
      try {
        const budget = await budgets.find(budgetId);
        parent = kind === 'complete' ? req.body.CallSid : req.body.ParentCallSid;
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
