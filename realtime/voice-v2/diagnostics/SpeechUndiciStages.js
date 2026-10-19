import { channel } from "node:diagnostics_channel";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id = value => typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9_:./-]+$/.test(value) ? value : null;
const code = value => typeof value === "string" && /^[A-Z0-9_]{3,40}$/.test(value) ? value : null;
const key = Symbol.for("glo.voice-v2.speech-undici-stages");
const state = globalThis[key] ??= { active: new Map(), subscribed: false, requests: new WeakMap(), invocation: null, suppressed: false, boundCount: 0 };
const CHANNELS = [
  ["undici:request:create", "REQUEST_CREATED"],
  ["undici:client:sendHeaders", "REQUEST_HEADERS_SENT"],
  ["undici:request:bodySent", "REQUEST_BODY_SENT"],
  ["undici:request:headers", "RESPONSE_HEADERS_RECEIVED"],
  ["undici:request:error", "REQUEST_ERROR"],
];

// Undici 6.21.1 Request.headers is a flat name/value array. Inspect it only
// synchronously; no strong request/array/payload/socket reference is retained.
function correlation(request) {
  if (!Array.isArray(request?.headers) || request.headers.length > 256) return null;
  let found = null;
  for (let i = 0; i < request.headers.length; i += 2) {
    if (typeof request.headers[i] !== "string" || request.headers[i].toLowerCase() !== "x-client-request-id") continue;
    const value = request.headers[i + 1];
    if (found !== null || typeof value !== "string" || !UUID.test(value)) return null;
    found = value;
  }
  return found;
}
function subscribe() {
  if (state.subscribed) return;
  state.subscribed = true;
  for (const [name, phase] of CHANNELS) channel(name).subscribe(payload => {
    try {
      if (phase === "REQUEST_CREATED") {
        const entry = state.invocation;
        if (!entry || state.suppressed || correlation(payload?.request) !== entry.clientRequestId) return;
        entry.claim(payload.request);
        return;
      }
      const entry = state.requests.get(payload?.request);
      if (!entry || state.active.get(entry.clientRequestId) !== entry) return;
      // Never inspect sendHeaders.headers/socket, response headers or error text.
      const status = phase === "RESPONSE_HEADERS_RECEIVED" ? payload.response?.statusCode : null;
      const errorCode = phase === "REQUEST_ERROR" ? code(payload.error?.code) : null;
      entry.phase(phase, status, errorCode);
    } catch { /* diagnostics_channel subscribers must never throw. */ }
  });
}

function invoke(entry, operation) {
  if (state.invocation || state.suppressed) {
    // Nested Speech diagnostics fail closed; the outer request keeps ownership.
    if (entry && entry !== state.invocation) entry.finish();
    if (state.suppressed) return operation();
    state.suppressed = true;
    try { return operation(); } finally { state.suppressed = false; }
  }
  if (!entry || state.active.get(entry.clientRequestId) !== entry) return operation();
  state.invocation = entry;
  try { return operation(); }
  catch (error) { entry.finish(); throw error; }
  finally { state.invocation = null; }
}

// Returns the original fetch result/promise unchanged; never awaits it.
export function invokeSpeechUndiciStages(handle, operation) {
  return handle ? handle.invoke(operation) : invoke(null, operation);
}

export function beginSpeechUndiciStages({ clientRequestId, context = {}, observer, clock = () => performance.now(), signalAborted = false } = {}) {
  let release = null;
  try {
    if (typeof clientRequestId !== "string" || !UUID.test(clientRequestId) || typeof observer !== "function"
      || !id(context.callSid) || state.active.size >= 128 || state.active.has(clientRequestId)) return null;
    // The retained correlation data is exclusively the allowlisted projection.
    // Closures additionally own only timing/dedup state and observer cleanup;
    // never a strong request reference, raw headers, socket, signal, body or exception.
    let fields = Object.freeze({ event: "V2_SPEECH_UNDICI_STAGE", callSid: id(context.callSid),
      requestId: id(context.requestId), responseId: id(context.responseId), purpose: id(context.purpose),
      proposalVersion: Number.isSafeInteger(context.proposalVersion) && context.proposalVersion >= 0 ? context.proposalVersion : null,
      clientRequestId });
    context = null;
    let sink = observer; observer = null;
    const start = clock(); let elapsed = 0; let aborted = signalAborted === true; let closed = false;
    let claimed = false; let requestRef = null;
    const seen = new Set();
    const finish = () => {
      if (closed) return;
      if (claimed) {
        const request = requestRef?.deref();
        if (request) state.requests.delete(request);
        state.boundCount--;
      }
      requestRef = null;
      closed = true; state.active.delete(clientRequestId); sink = null; clock = null; fields = null; seen.clear();
    };
    release = finish;
    const phase = (value, status = null, errorCode = null) => {
      try {
        if (closed || seen.has(value)) return;
        seen.add(value);
        const now = clock();
        if (Number.isFinite(now) && Number.isFinite(start)) elapsed = Math.max(elapsed, Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, now - start)));
        const event = Object.freeze({ ...fields, phase: value, elapsedMs: elapsed, signalAborted: aborted,
          providerStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null, errorCode: code(errorCode) });
        const notify = sink;
        if (["RESPONSE_HEADERS_RECEIVED", "REQUEST_ERROR", "APPLICATION_ABORT_OBSERVED"].includes(value)) finish();
        try { Promise.resolve(notify?.(event)).catch(() => {}); } catch { /* Never await or retain observer results. */ }
      } catch { finish(); }
    };
    const claim = request => {
      if (closed || claimed || request === null || typeof request !== "object" || state.requests.has(request)) return;
      // Ownership is fixed before observer notification, including reentrant calls.
      claimed = true; requestRef = new WeakRef(request);
      state.requests.set(request, entry); state.boundCount++;
      phase("REQUEST_CREATED");
    };
    const entry = { callSid: fields.callSid, clientRequestId, phase, finish, claim };
    state.active.set(clientRequestId, entry); subscribe();
    const handle = Object.freeze({ settle: finish, abort: () => { aborted = true; phase("APPLICATION_ABORT_OBSERVED"); }, invoke: operation => invoke(entry, operation) });
    if (aborted) handle.abort();
    return handle;
  } catch { release?.(); return null; }
}

export function disposeSpeechUndiciStages(callSid) {
  try { for (const entry of state.active.values()) if (entry.callSid === callSid) entry.finish(); } catch {}
}

export function speechUndiciStageState() { return Object.freeze({ activeCount: state.active.size, capacity: 128, subscribed: state.subscribed,
  invocationActive: state.invocation !== null, nestedSuppressed: state.suppressed, boundRequestCount: state.boundCount }); }
