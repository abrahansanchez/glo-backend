import { PHONE_DECISION_INSTRUCTIONS } from './PhoneContracts.js';
// Isolated text/function decision connection. Caller audio remains in V2's
// established transcription/VAD connection; no synthetic lab imports.
const STAGES = new Set(['BUSINESS_CONTEXT_READ', 'BUSINESS_CONTEXT_VALIDATE', 'MODEL_CONNECTION', 'MODEL_CONFIGURATION', 'MODEL_REQUEST', 'TOOL_ARGUMENT_VALIDATION', 'TOOL_DISPATCH', 'PLAN_VALIDATION', 'SPEECH_SUBMISSION', 'TOOL_RESULT_SUBMISSION']);
const CODES = new Set(['UNSUPPORTED_BUSINESS', 'UNSUPPORTED_CATALOGUE', 'INVALID_LABEL_CONFIGURATION', 'INVALID_BUSINESS_CLOCK', 'CATALOGUE_CHANGED', 'BUSINESS_TIMEZONE_CHANGED', 'TURN_LIMIT', 'CONNECTION_LIMIT', 'MODEL_REQUEST_LIMIT', 'TURN_REQUEST_LIMIT', 'REPLAY', 'STRUCTURE', 'STALE_BINDING', 'INVALID_PLAN', 'PHONE_MODEL_CLOSED', 'PHONE_MODEL_UNAVAILABLE', 'PHONE_MODEL_PROVIDER_ERROR', 'PHONE_MODEL_PROTOCOL_ERROR', 'PHONE_MODEL_CONFIGURATION_MISMATCH', 'PHONE_MODEL_CORRELATION_FAILURE', 'PHONE_MODEL_RESPONSE_FAILURE', 'PHONE_MODEL_UNEXPECTED_OUTPUT', 'PHONE_MODEL_SEND_FAILED', 'PHONE_MODEL_CONNECTION_FAILED', 'PHONE_MODEL_CONNECTION_CLOSED']);
const PROVIDER_CODES = new Set(['invalid_function_parameters', 'invalid_request_error', 'invalid_api_key', 'unknown_parameter', 'invalid_parameter', 'invalid_value', 'rate_limit_exceeded', 'server_error', 'internal_server_error', 'insufficient_quota']);
const PROVIDER_TYPES = new Set(['invalid_request_error', 'authentication_error', 'rate_limit_error', 'server_error']);
const CATALOGUE_FIELDS = new Set(['services', 'service.id', 'service.name']);
const CATALOGUE_CATEGORIES = new Set(['INVALID_LIST', 'EMPTY', 'TOO_LARGE', 'INVALID_ID', 'DUPLICATE_ID', 'MISSING_NAME', 'INVALID_NAME', 'DUPLICATE_NAME']);
export function phoneFailure(error, stage, provider = null) {
  const saved = error?.safeDiagnostic;
  const failureStage = STAGES.has(saved?.failureStage) ? saved.failureStage : STAGES.has(stage) ? stage : 'MODEL_CONNECTION';
  const code = saved?.failureCode || error?.code || error?.message;
  const raw = provider || saved || {};
  const param = raw.param || raw.providerParam;
  return Object.freeze({ failureStage, failureCategory: failureStage.startsWith('BUSINESS_') ? 'BUSINESS_CONTEXT' : failureStage,
    failureCode: CODES.has(code) ? code : 'UNCLASSIFIED',
    providerCode: PROVIDER_CODES.has(raw.code || raw.providerCode) ? (raw.code || raw.providerCode) : 'UNKNOWN',
    providerType: PROVIDER_TYPES.has(raw.type || raw.providerType) ? (raw.type || raw.providerType) : 'UNKNOWN',
    ...(CATALOGUE_FIELDS.has(error?.catalogueField || saved?.catalogueField) && CATALOGUE_CATEGORIES.has(error?.catalogueCategory || saved?.catalogueCategory)
      ? { catalogueField: error?.catalogueField || saved.catalogueField, catalogueCategory: error?.catalogueCategory || saved.catalogueCategory } : {}),
    providerParam: typeof param === 'string' && (/^session\.tools\[[0-5]\]\.parameters$/.test(param)
      || ['session', 'session.type', 'session.model', 'session.output_modalities', 'session.max_output_tokens', 'session.tools', 'session.tool_choice'].includes(param)) ? param : 'UNKNOWN' });
}
export class PhoneModelTransport {
  #socket; #active = null; #sequence = 0; #closed = false; #resolve; #reject; #onFailure;
  #stage = 'MODEL_CONNECTION';
  #observedOperation = 'constructDecisionConnection';
  #observedGuard = null;
  #diagnostics;
  #observe(method, ...args) { try { this.#diagnostics?.[method]?.(...args); } catch {} }
  constructor(socket, tools, model, onFailure = () => {}, diagnostics = null) {
    this.#diagnostics = diagnostics;
    this.#socket = socket;
    this.#onFailure = onFailure;
    this.ready = new Promise((resolve, reject) => { this.#resolve = resolve; this.#reject = reject; });
    this.ready.catch(() => {});
    socket.on('open', () => { try { this.#stage = 'MODEL_CONFIGURATION'; this.#send({ type: 'session.update', session: { type: 'realtime', model, output_modalities: ['text'],
      max_output_tokens: 512, tools, tool_choice: 'required', instructions: PHONE_DECISION_INSTRUCTIONS } }); } catch { this.#fail('PHONE_MODEL_SEND_FAILED'); } });
    socket.on('message', raw => {
      try {
        if (this.#closed) { this.#observe('secondary', 'EXPECTED_CLOSE'); return; }
        if (Buffer.byteLength(raw) > 262144) throw Error();
        this.#observedOperation = 'receiveDecisionResponse';
        this.#observedGuard = 'INVALID_PROVIDER_JSON';
        const p = JSON.parse(raw.toString());
        this.#observedGuard = null;
        if (p.type === 'error') { this.#observe('start', this.#stage === 'MODEL_CONFIGURATION' ? 'DECISION_CONFIGURATION' : 'MODEL_RESPONSE', 'receiveProviderError'); this.#fail('PHONE_MODEL_PROVIDER_ERROR', p.error); return; }
        if (/audio/.test(p.type || '') || /output_text\.(delta|done)$/.test(p.type || '')) { this.#observedGuard = 'UNEXPECTED_MODEL_OUTPUT'; this.#fail('PHONE_MODEL_UNEXPECTED_OUTPUT'); return; }
        if (p.type === 'session.updated') {
          if (JSON.stringify(p.session?.output_modalities) !== '["text"]' || p.session?.tool_choice !== 'required' || p.session?.max_output_tokens !== 512) { this.#observedGuard = 'CONFIGURATION_ACK_MISMATCH'; this.#fail('PHONE_MODEL_CONFIGURATION_MISMATCH'); return; }
          this.#stage = 'MODEL_REQUEST'; this.#resolve(); return;
        }
        if (p.type === 'response.created') {
          this.#observe('start', 'MODEL_RESPONSE', 'receiveDecisionResponse');
          if (!this.#active || this.#active.responseId || !/^[A-Za-z0-9_.:-]{1,128}$/.test(p.response?.id || '') || p.response?.metadata?.phoneRequestId !== this.#active.id) { this.#fail('PHONE_MODEL_CORRELATION_FAILURE'); return; }
          this.#active.responseId = p.response.id;
        }
        if (p.type === 'response.done') {
          this.#observedOperation = 'validateResponseCompletion';
          this.#observe('start', 'MODEL_RESPONSE', 'validateResponseCompletion');
          const r = p.response, a = this.#active;
          this.#observedGuard = r?.status !== 'completed' ? 'RESPONSE_NOT_COMPLETED' : !Array.isArray(r?.output) || !r.output.length ? 'FUNCTION_CALLS_MISSING' : r.output.length > 8 ? 'PROVIDER_OUTPUT_LIMIT' : null;
          if (!a || r.id !== a.responseId || r.status !== 'completed' || !Array.isArray(r.output) || !r.output.length || r.output.length > 8) { this.#fail('PHONE_MODEL_RESPONSE_FAILURE'); return; }
          this.#observe('start', 'MODEL_RESPONSE', 'validateFunctionCalls');
          this.#observedOperation = 'validateFunctionCalls';
          this.#observedGuard = 'FUNCTION_CALL_SHAPE';
          const calls = r.output.map(c => {
            if (c.type !== 'function_call' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(c.call_id) || typeof c.name !== 'string' || typeof c.arguments !== 'string' || Buffer.byteLength(c.arguments) > 16384) throw Error();
            return { callId: c.call_id, name: c.name, argumentsJson: c.arguments };
          });
          if (new Set(calls.map(c => c.callId)).size !== calls.length) throw Error();
          this.#observedGuard = null;
          this.#active = null; a.resolve({ calls });
        }
      } catch { this.#fail(); }
    });
    socket.on('error', () => this.#fail('PHONE_MODEL_CONNECTION_FAILED')); socket.on('close', () => this.#fail('PHONE_MODEL_CONNECTION_CLOSED'));
  }
  #send(packet) { if (this.#closed) throw Error('PHONE_MODEL_CLOSED'); this.#socket.send(JSON.stringify(packet)); }
  request({ callerText, context }) {
    if (this.#active || this.#closed) return Promise.reject(Error('PHONE_MODEL_UNAVAILABLE'));
    const id = 'phone-' + (++this.#sequence);
    this.#observe('update', { requestId: id });
    return new Promise((resolve, reject) => {
      this.#active = { id, resolve, reject };
      try {
        this.#observedOperation = 'submitDecisionContext';
        if (callerText !== null) { this.#send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: JSON.stringify({ callerText, applicationContext: context }) }] } }); this.#observe('contextSubmitted'); }
        this.#observedOperation = 'createDecisionRequest';
        this.#send({ type: 'response.create', response: { output_modalities: ['text'], max_output_tokens: 512, tool_choice: 'required', metadata: { phoneRequestId: id } } });
      } catch { this.#fail('PHONE_MODEL_SEND_FAILED'); }
    });
  }
  toolResult(callId, result, context) { this.#send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ result, applicationContext: context }) } }); this.#observe('contextSubmitted', true); }
  #fail(code = 'PHONE_MODEL_PROTOCOL_ERROR', provider = null) {
    if (this.#closed) { this.#observe('secondary', 'EXPECTED_CLOSE'); return; }
    const error = Object.assign(Error('PHONE_MODEL_STOPPED'), { safeDiagnostic: phoneFailure({ code }, this.#stage, provider) });
    const configuration = this.#stage === 'MODEL_CONFIGURATION', connection = ['PHONE_MODEL_CONNECTION_FAILED', 'PHONE_MODEL_CONNECTION_CLOSED'].includes(code);
    this.#observe('failure', error, { provider, guard: this.#observedGuard, limit: this.#observedGuard === 'PROVIDER_OUTPUT_LIMIT' ? 8 : null, stage: connection ? 'DECISION_CONNECTION' : configuration ? 'DECISION_CONFIGURATION' : code === 'PHONE_MODEL_SEND_FAILED' ? 'MODEL_REQUEST' : 'MODEL_RESPONSE',
      operation: connection ? 'closeDecisionConnection' : code === 'PHONE_MODEL_PROVIDER_ERROR' ? 'receiveProviderError' : configuration ? 'awaitDecisionConfiguration' : this.#observedOperation,
      terminationRequestedBy: { function: 'phoneFailureCallback', reasonCode: 'STRUCTURED_MODEL_PROTOCOL_FAILED' } });
    this.close(error); try { this.#onFailure(error); } catch { /* Cleanup owns no provider payload. */ }
  }
  close(error = Error('PHONE_MODEL_STOPPED')) {
    if (this.#closed) return; this.#closed = true;
    this.#observe('secondary', 'EXPECTED_CLOSE');
    this.#reject(error); this.#active?.reject(error); this.#active = null;
    try { this.#socket.close(1000, 'structured phone stopped'); } catch {}
  }
}
