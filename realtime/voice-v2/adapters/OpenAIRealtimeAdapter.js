import { bindSocket, parseJsonMessage, sendJson, transportEvent, TransportEvent } from "./transportMessages.js";

const ACTIVE_ERROR = /active response|conversation.*already.*response|response.*in progress/i;

export class OpenAIRealtimeAdapter {
  #socketFactory;
  #socket = null;
  #emit;
  #connected = false;
  #configured = false;
  #sequence = 0;
  #activeRequestId = null;
  #requests = new Map();
  #responses = new Map();
  #cancellations = new Map();
  #pending = [];

  constructor({ socketFactory, onEvent = () => {} }) {
    if (typeof socketFactory !== "function") throw new TypeError("socket_factory_required");
    this.#socketFactory = socketFactory; this.#emit = onEvent;
  }

  get connected() { return this.#connected; }
  get activeRequestId() { return this.#activeRequestId; }

  connect(options = {}) {
    if (this.#socket) throw new TypeError("openai_socket_already_created");
    this.#socket = this.#socketFactory(options);
    bindSocket(this.#socket, { open: () => { this.#connected = true; this.#publish(TransportEvent.OPENAI_CONNECTED); }, message: (raw) => this.#onMessage(raw), close: (details) => this.#onClose(details), error: (error) => this.#onError(error) });
    return this.#socket;
  }

  configureSession({ instructions, voice, turnDetection = {}, ...session } = {}) {
    this.#requireWritable();
    const message = { type: "session.update", session: { ...session, instructions, voice, input_audio_format: "g711_ulaw", output_audio_format: "g711_ulaw", turn_detection: { type: "server_vad", ...turnDetection, create_response: false, interrupt_response: false } } };
    sendJson(this.#socket, message); this.#configured = true; return message;
  }

  appendCallerAudio({ payload, eventId = this.#id("audio") }) { this.#requireConfigured(); return sendJson(this.#socket, { event_id: eventId, type: "input_audio_buffer.append", audio: payload }); }
  commitCallerAudio({ eventId = this.#id("commit") } = {}) { this.#requireConfigured(); return sendJson(this.#socket, { event_id: eventId, type: "input_audio_buffer.commit" }); }

  createResponse({ requestId = this.#id("request"), eventId = this.#id("create"), response = {} } = {}) {
    this.#requireConfigured();
    if (this.#activeRequestId) {
      const event = this.#publish(TransportEvent.ACTIVE_RESPONSE_REJECTED, { requestId, activeRequestId: this.#activeRequestId, reason: "LOCAL_ACTIVE_RESPONSE" });
      return Object.freeze({ accepted: false, reason: event.reason, event });
    }
    const record = { requestId, createEventId: eventId, responseId: null, status: "requested", stale: false };
    this.#requests.set(requestId, record); this.#pending.push(requestId); this.#activeRequestId = requestId;
    sendJson(this.#socket, { event_id: eventId, type: "response.create", response: { ...response, metadata: { ...(response.metadata || {}), v2RequestId: requestId } } });
    return Object.freeze({ accepted: true, requestId, eventId });
  }

  supersedeResponse({ requestId = this.#activeRequestId, responseId, reason = "PROPOSAL_CHANGED" } = {}) {
    const record = requestId ? this.#requests.get(requestId) : responseId ? this.#responses.get(responseId) : null;
    if (!record) return Object.freeze({ superseded: false, reason: "UNKNOWN_RESPONSE" });
    record.stale = true; record.status = "superseded"; record.reason = reason;
    if (this.#activeRequestId === record.requestId) this.#activeRequestId = null;
    const providerId = responseId || record.responseId;
    if (providerId) this.cancelResponse({ responseId: providerId });
    return Object.freeze({ superseded: true, requestId: record.requestId, responseId: providerId || null, cancellationPending: Boolean(providerId) });
  }

  cancelResponse({ responseId, eventId = this.#id("cancel") }) {
    this.#requireWritable(); if (!responseId) throw new TypeError("response_id_required");
    this.#cancellations.set(eventId, responseId);
    const event = this.#publish(TransportEvent.RESPONSE_CANCEL_REQUESTED, { responseId, eventId });
    sendJson(this.#socket, { event_id: eventId, type: "response.cancel", response_id: responseId }); return event;
  }

  close(code, reason) { if (!this.#socket) return; this.#socket.close?.(code, reason); }

  #onMessage(raw) {
    let message; try { message = parseJsonMessage(raw); } catch (error) { return this.#onError(error); }
    const type = message.type; const identity = providerIdentity(message);
    if (type === "session.updated") return this.#publish(TransportEvent.OPENAI_SESSION_CONFIGURED, identity);
    if (type === "input_audio_buffer.speech_started") return this.#publish(TransportEvent.CALLER_SPEECH_STARTED, identity);
    if (type === "input_audio_buffer.speech_stopped") return this.#publish(TransportEvent.CALLER_SPEECH_STOPPED, identity);
    if (isTranscriptDone(type)) return this.#publish(TransportEvent.USER_TRANSCRIPT_COMPLETED, { ...identity, transcript: message.transcript ?? "" });
    if (isTranscriptFailed(type)) return this.#publish(TransportEvent.USER_TRANSCRIPT_FAILED, { ...identity, error: normalizeError(message.error) });
    if (type === "response.created") return this.#created(message, identity);
    if (type === "response.audio.delta" || type === "response.output_audio.delta") return this.#responseEvent(TransportEvent.RESPONSE_AUDIO_DELTA, message, { ...identity, delta: message.delta });
    if (type === "response.audio.done" || type === "response.output_audio.done") return this.#responseEvent(TransportEvent.RESPONSE_AUDIO_COMPLETED, message, identity);
    if (type === "response.audio_transcript.done" || type === "response.output_audio_transcript.done") return this.#responseEvent(TransportEvent.RESPONSE_TRANSCRIPT_COMPLETED, message, { ...identity, transcript: message.transcript ?? "" });
    if (type === "response.done") return this.#done(message, identity);
    if (type === "error") return this.#providerError(message, identity);
  }

  #created(message, identity) {
    const responseId = message.response?.id || message.response_id;
    const requestId = message.response?.metadata?.v2RequestId || this.#pending.find((id) => !this.#requests.get(id)?.responseId);
    const record = this.#requests.get(requestId);
    if (!record) return this.#publish(TransportEvent.STALE_RESPONSE_EVENT_QUARANTINED, { ...identity, responseId, reason: "UNOWNED_RESPONSE" });
    if (record.responseId) return this.#publish(TransportEvent.STALE_RESPONSE_EVENT_QUARANTINED, { ...identity, requestId, responseId, reason: "DUPLICATE_RESPONSE_CREATED" });
    record.responseId = responseId; this.#responses.set(responseId, record);
    if (record.stale) { this.#publish(TransportEvent.STALE_RESPONSE_EVENT_QUARANTINED, { ...identity, requestId, responseId, reason: record.reason }); this.cancelResponse({ responseId }); return; }
    record.status = "active"; return this.#publish(TransportEvent.RESPONSE_CREATED, { ...identity, requestId, responseId });
  }

  #responseEvent(type, message, details) {
    const responseId = message.response_id || message.response?.id; const record = this.#responses.get(responseId);
    if (!record || record.stale) return this.#publish(TransportEvent.STALE_RESPONSE_EVENT_QUARANTINED, { ...details, responseId, requestId: record?.requestId || null, originalType: message.type });
    return this.#publish(type, { ...details, responseId, requestId: record.requestId });
  }

  #done(message, identity) {
    const responseId = message.response?.id || message.response_id; const record = this.#responses.get(responseId); const status = message.response?.status || message.status;
    if (!record || record.stale) {
      if (record?.stale && status === "cancelled") this.#publish(TransportEvent.RESPONSE_CANCELLED, { ...identity, responseId, requestId: record.requestId });
      return this.#publish(TransportEvent.STALE_RESPONSE_EVENT_QUARANTINED, { ...identity, responseId, requestId: record?.requestId || null, originalType: message.type });
    }
    if (this.#activeRequestId === record.requestId) this.#activeRequestId = null; record.status = status;
    if (status === "cancelled") return this.#publish(TransportEvent.RESPONSE_CANCELLED, { ...identity, responseId, requestId: record.requestId });
    if (status === "completed") return this.#publish(TransportEvent.RESPONSE_COMPLETED, { ...identity, responseId, requestId: record.requestId });
    return this.#publish(TransportEvent.RESPONSE_FAILED, { ...identity, responseId, requestId: record.requestId, status, error: normalizeError(message.response?.status_details?.error) });
  }

  #providerError(message, identity) {
    const error = normalizeError(message.error); const request = [...this.#requests.values()].find((item) => item.createEventId === message.error?.event_id || item.createEventId === message.event_id);
    if (request && ACTIVE_ERROR.test(`${message.error?.code || ""} ${error.message}`)) {
      if (this.#activeRequestId === request.requestId) this.#activeRequestId = null; request.status = "provider_rejected";
      return this.#publish(TransportEvent.ACTIVE_RESPONSE_REJECTED, { ...identity, requestId: request.requestId, reason: "PROVIDER_ACTIVE_RESPONSE", error });
    }
    const failedEventId = message.error?.event_id || message.event_id; const cancelledResponseId = this.#cancellations.get(failedEventId);
    if (cancelledResponseId) { this.#cancellations.delete(failedEventId); return this.#publish(TransportEvent.RESPONSE_CANCEL_FAILED, { ...identity, responseId: cancelledResponseId, error }); }
    return this.#publish(TransportEvent.OPENAI_TRANSPORT_ERROR, { ...identity, error });
  }

  #onClose(details) { if (!this.#connected && !this.#socket) return; this.#connected = false; this.#publish(TransportEvent.OPENAI_CONNECTION_CLOSED, { code: details?.code ?? null, reason: details?.reason?.toString?.() || null }); }
  #onError(error) { this.#publish(TransportEvent.OPENAI_TRANSPORT_ERROR, { error: normalizeError(error) }); }
  #requireWritable() { if (!this.#socket || this.#socket.readyState === 2 || this.#socket.readyState === 3) throw new TypeError("openai_transport_not_writable"); }
  #requireConfigured() { this.#requireWritable(); if (!this.#configured) throw new TypeError("openai_session_not_configured"); }
  #id(prefix) { this.#sequence += 1; return `v2-${prefix}-${this.#sequence}`; }
  #publish(type, details = {}) { const event = transportEvent(type, details); this.#emit(event); return event; }
}

function providerIdentity(message) { return { eventId: message.event_id ?? null, itemId: message.item_id || message.item?.id || null, providerType: message.type }; }
function isTranscriptDone(type) { return ["conversation.item.input_audio_transcription.completed", "conversation.item.input_audio_transcription.done"].includes(type); }
function isTranscriptFailed(type) { return ["conversation.item.input_audio_transcription.failed", "conversation.item.input_audio_transcription.error"].includes(type); }
function normalizeError(error) { return Object.freeze({ code: error?.code || null, name: error?.name || "Error", message: error?.message || String(error || "unknown_error") }); }
