import { randomUUID } from 'node:crypto';
import { validateTwilioTransportRequest } from '../../security/twilioTransportAuth.js';
import { resolveBusinessByCalledNumber } from '../../business/resolveBusinessByCalledNumber.js';

const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const result = reasonCode => Object.freeze({ registered: false, reasonCode, telephonyHandoffEnabled: false });

// Internal application service only. No registration HTTP endpoint, environment
// lookup, network implementation, TwiML handoff or fallback/takeover modification.
export function createRetellCallRegistration({ enabled = false, repository, provider,
  agentsByBusiness = {}, twilio = {}, resolveBusiness = resolveBusinessByCalledNumber,
  now = () => new Date(), deadlineMs = 3000, lifetimeMs = 600000, requireBridge = false, bookingAllowed = false,
  bridgeDurationSeconds = 120 } = {}) {
  if (enabled !== true) return Object.freeze({ observeIncoming: async () => result('NOT_ENABLED'),
    register: async () => result('NOT_ENABLED'), handleEvent: async () => false,
    supersede: async () => false });
  const agents = structuredClone(agentsByBusiness);
  if (!repository || typeof provider?.registerPhoneCall !== 'function'
    || !Number.isInteger(deadlineMs) || deadlineMs < 10 || deadlineMs > 10000
    || !Number.isInteger(lifetimeMs) || lifetimeMs < 1000 || lifetimeMs > 1800000 || ![120, 300].includes(bridgeDurationSeconds)
    || !Object.keys(agents).length || Object.entries(agents).some(([business, a]) => !/^[a-f\d]{24}$/.test(business)
      || !id(a?.agentId) || !Number.isSafeInteger(a.agentVersion) || a.agentVersion < 0
      || !['en', 'es'].includes(a.language))) throw Error('REGISTRATION_CONFIGURATION_INVALID');
  return Object.freeze({
    async observeIncoming({ params, signature } = {}) {
      // Hard enforcement independent of the legacy middleware's off/observe mode.
      const auth = validateTwilioTransportRequest({ ...twilio, requestPath: '/api/voice/incoming', params, signature });
      if (!auth.valid || !params || !/^CA[a-f\d]{32}$/.test(params.CallSid || '')
        || typeof params.To !== 'string' || (params.Called && params.Called !== params.To)) return result('UNTRUSTED_INCOMING_CALL');
      try {
        const business = await resolveBusiness(params.To);
        const agent = business && agents[business.businessId];
        if (!agent) return result('BUSINESS_NOT_ALLOWED');
        const row = await repository.observe({ _id: params.CallSid, businessId: business.businessId, ...agent,
          ownerEpoch: 1, revision: 1, attemptId: randomUUID(), status: 'OBSERVED', expiresAt: new Date(+now() + lifetimeMs),
          ...(typeof params.From === 'string' && /^\+[1-9]\d{7,14}$/.test(params.From) ? { trustedCallerNumber: params.From } : {}),
          ...(bookingAllowed === true ? { bookingAllowed: true } : {}),
          ...(requireBridge ? { bridgeRequired: true, bridgeDurationSeconds } : {}) });
        if (row.businessId !== business.businessId || row.agentId !== agent.agentId || row.agentVersion !== agent.agentVersion
          || row.language !== agent.language || row.status !== 'OBSERVED' || +new Date(row.expiresAt) <= +now()) return result('CALL_ALREADY_OWNED');
        return Object.freeze({ observed: true, parentCallSid: row._id, ownerEpoch: row.ownerEpoch });
      } catch { return result('REGISTRATION_UNAVAILABLE'); }
    },
    async register({ parentCallSid, ownerEpoch } = {}) {
      if (!/^CA[a-f\d]{32}$/.test(parentCallSid || '') || !Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1) return result('INVALID_OWNER');
      let row;
      try { row = await repository.claim(parentCallSid, ownerEpoch, now()); }
      catch { return result('PERSISTENCE_FAILED'); }
      if (!row) return result('CALL_NOT_CLAIMABLE');
      // Durable consumption happens before invoking even the injectable boundary.
      const controller = new AbortController();
      let timer;
      try {
        const response = await Promise.race([
          Promise.resolve().then(() => provider.registerPhoneCall({ agent_id: row.agentId, agent_version: row.agentVersion,
            direction: 'inbound', metadata: { glo_registration_attempt: row.attemptId } }, { signal: controller.signal })),
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('REGISTRATION_DEADLINE')); }, deadlineMs); }),
        ]);
        if (!id(response?.call_id) || response.agent_id !== row.agentId || response.agent_version !== row.agentVersion
          || response.call_status !== 'registered') throw Error('REGISTRATION_RESPONSE_INVALID');
        const bound = await repository.bind(row, response.call_id, now());
        if (!bound) return result('OWNER_CHANGED_OR_ENDED');
        return Object.freeze({ registered: true, callId: bound.providerCallId, telephonyHandoffEnabled: false });
      } catch {
        // Errors can be post-dispatch. Never assume registration did not happen,
        // never retry, and never activate a callback-only/late provider result.
        try { await repository.fail(row, 'UNKNOWN'); } catch {}
        return result('REGISTRATION_OUTCOME_UNKNOWN');
      } finally { clearTimeout(timer); controller.abort(); }
    },
    async supersede({ parentCallSid, ownerEpoch } = {}) {
      if (!/^CA[a-f\d]{32}$/.test(parentCallSid || '') || !Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1) return false;
      return Boolean(await repository.supersede(parentCallSid, ownerEpoch));
    },
    async handleEvent(event) {
      const call = event?.call, attemptId = call?.metadata?.glo_registration_attempt;
      if (!['call_started', 'call_ended'].includes(event?.event) || !id(call?.call_id) || !id(call?.agent_id)
        || (call.agent_version !== undefined && (!Number.isSafeInteger(call.agent_version) || call.agent_version < 0))
        || (attemptId !== undefined && !/^[a-f\d-]{36}$/.test(attemptId))
        // The official ended example still carries call_status=registered.
        // A verified terminal event wins; do not let a nonterminal status snapshot
        // suppress revocation. Starts, conversely, must explicitly be ongoing.
        || (event.event === 'call_started' ? call.call_status !== 'ongoing'
          : !['registered', 'not_connected', 'ongoing', 'ended', 'error'].includes(call.call_status))) return false;
      return Boolean(await repository.event({ attemptId, callId: call.call_id, agentId: call.agent_id,
        agentVersion: call.agent_version, ended: event.event === 'call_ended' }, now()));
    },
  });
}
