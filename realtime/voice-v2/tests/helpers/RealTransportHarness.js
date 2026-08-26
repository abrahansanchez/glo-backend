import { OpenAIRealtimeAdapter } from "../../adapters/OpenAIRealtimeAdapter.js";
import { TwilioMediaAdapter } from "../../adapters/TwilioMediaAdapter.js";
import { TransportEvent } from "../../adapters/transportMessages.js";

export class RealTransportHarness {
  constructor({ session, coordinator, openaiSocket, twilioSocket, schedule = (fn) => fn(), context = {} }) {
    this.session = session; this.coordinator = coordinator; this.openaiSocket = openaiSocket; this.twilioSocket = twilioSocket; this.schedule = schedule; this.context = context;
    this.events = []; this.turns = new Map(); this.requests = new Map(); this.responses = new Map(); this.marks = new Map(); this.turnSequence = 0; this.markSequence = 0; this.terminated = false; this.finalized = false;
    this.twilio = new TwilioMediaAdapter({ socket: twilioSocket, onEvent: (event) => this.#twilioEvent(event) });
    this.openai = new OpenAIRealtimeAdapter({ socketFactory: () => openaiSocket, onEvent: (event) => this.#openaiEvent(event) });
    this.openai.connect(); openaiSocket.open(); this.openai.configureSession({ instructions: "test-only injected instructions", voice: "alloy" });
  }

  requestResponse({ requestId, plan, response = {} }) {
    if (this.terminated) return Object.freeze({ accepted: false, reason: "CALL_TERMINATED" });
    const tracked = this.requests.get(requestId) || { requestId, plan, attempts: 0, retryScheduled: false };
    tracked.attempts += 1; this.requests.set(requestId, tracked);
    const providerRequestId = tracked.attempts === 1 ? requestId : `${requestId}-retry-${tracked.attempts - 1}`;
    tracked.providerRequestId = providerRequestId;
    const result = this.openai.createResponse({ requestId: providerRequestId, eventId: `${providerRequestId}-create`, response });
    if (result.accepted) this.requests.set(providerRequestId, tracked);
    return result;
  }

  supersede({ requestId, reason = "PROPOSAL_CHANGED" }) {
    const tracked = this.requests.get(requestId); const responseId = tracked?.responseId || null; const markId = responseId ? this.responses.get(responseId)?.markId : null;
    if (responseId && this.session.responseRegistry.get(responseId)) this.session.responseRegistry.invalidate(responseId, reason);
    if (markId && this.session.playbackRegistry.get(markId)) { this.session.playbackRegistry.stale(markId, reason); this.twilio.clearPlayback(); }
    if (tracked?.plan) this.session.confirmationAuthority.revokeProposal(tracked.plan.proposalVersion, reason);
    const result = this.openai.supersedeResponse({ requestId: tracked?.providerRequestId || requestId, responseId, reason });
    this.events.push(Object.freeze({ type: "LOCAL_RESPONSE_SUPERSEDED", requestId, responseId, markId, reason })); return result;
  }

  terminate(reason = "CALL_TERMINATED") {
    if (this.terminated) return false; this.terminated = true;
    for (const tracked of new Set(this.requests.values())) if (tracked.plan) this.session.confirmationAuthority.revokeProposal(tracked.plan.proposalVersion, reason);
    for (const [responseId, state] of this.responses) {
      if (this.session.responseRegistry.get(responseId)) this.session.responseRegistry.invalidate(responseId, reason);
      if (state.markId && this.session.playbackRegistry.get(state.markId)) this.session.playbackRegistry.stale(state.markId, reason);
      this.openai.supersedeResponse({ requestId: state.providerRequestId, responseId, reason });
    }
    if (this.twilio.identity.streamSid && !this.twilio.closed) { try { this.twilio.clearPlayback(); } catch {} }
    if (!this.finalized) { this.finalized = true; this.coordinator.completeCall(this.session, reason); }
    this.events.push(Object.freeze({ type: "CALL_TERMINATED", reason })); return true;
  }

  #twilioEvent(event) {
    this.events.push(event);
    if (event.type === TransportEvent.CALLER_AUDIO && !this.terminated) this.openai.appendCallerAudio({ payload: event.payload });
    if (event.type === TransportEvent.PLAYBACK_MARK_ACKNOWLEDGED) {
      const correlation = this.marks.get(event.markId);
      const playback = this.session.playbackRegistry.get(event.markId);
      if (!correlation || playback?.invalidated || this.terminated) return this.events.push(Object.freeze({ type: "STALE_PLAYBACK_EVENT_QUARANTINED", markId: event.markId }));
      this.session.playbackRegistry.acknowledge(event.markId);
      const grant = this.session.confirmationAuthority.grant({ proposalVersion: correlation.proposalVersion, responseId: correlation.responseId, markId: event.markId, responseRegistry: this.session.responseRegistry, playbackRegistry: this.session.playbackRegistry });
      this.events.push(Object.freeze({ type: grant.authorized ? "CONFIRMATION_AUTHORITY_GRANTED" : "CONFIRMATION_AUTHORITY_WITHHELD", ...correlation, markId: event.markId, reason: grant.reason }));
    }
    if ([TransportEvent.TWILIO_STREAM_STOPPED, TransportEvent.TWILIO_CONNECTION_CLOSED].includes(event.type)) this.terminate();
  }

  #openaiEvent(event) {
    this.events.push(event);
    if (event.type === TransportEvent.USER_TRANSCRIPT_COMPLETED && !this.terminated) {
      const identity = event.itemId || event.eventId; if (!identity || this.turns.has(identity)) return;
      const turnId = `v2-turn-${++this.turnSequence}`; this.turns.set(identity, turnId);
      Promise.resolve(this.coordinator.receiveFinalizedTurn(this.session, { turnId, transcript: event.transcript }, this.context));
    }
    if (event.type === TransportEvent.RESPONSE_CREATED) {
      const tracked = this.requests.get(event.requestId); if (!tracked) return;
      tracked.responseId = event.responseId;
      this.session.responseRegistry.register({ responseId: event.responseId, proposalVersion: tracked.plan.proposalVersion, purpose: tracked.plan.purpose }); this.session.responseRegistry.request(event.responseId);
      this.responses.set(event.responseId, { providerRequestId: event.requestId, plan: tracked.plan, audio: [], transcript: null, completed: false, markId: null });
    }
    if (event.type === TransportEvent.RESPONSE_AUDIO_DELTA) {
      const state = this.responses.get(event.responseId); if (!state) return;
      if (state.plan.critical) { state.audio.push(event.delta); this.events.push(Object.freeze({ type: TransportEvent.CRITICAL_AUDIO_BUFFERED, responseId: event.responseId, bytes: Buffer.from(event.delta, "base64").length })); }
      else this.twilio.submitAudio({ payload: event.delta });
    }
    if (event.type === TransportEvent.RESPONSE_TRANSCRIPT_COMPLETED) { const state = this.responses.get(event.responseId); if (state) state.transcript = event.transcript; }
    if (event.type === TransportEvent.RESPONSE_COMPLETED) this.#completeCritical(event.responseId);
    if ([TransportEvent.RESPONSE_FAILED, TransportEvent.RESPONSE_CANCELLED].includes(event.type)) this.#discard(event.responseId, event.type);
    if (event.type === TransportEvent.ACTIVE_RESPONSE_REJECTED && event.reason === "PROVIDER_ACTIVE_RESPONSE") this.#retryOnce(event.requestId);
    if ([TransportEvent.OPENAI_CONNECTION_CLOSED].includes(event.type)) this.terminate();
  }

  #completeCritical(responseId) {
    const state = this.responses.get(responseId); if (!state) return; state.completed = true;
    const current = state.plan.proposalVersion === this.session.proposal.proposalVersion; const entry = this.session.responseRegistry.get(responseId);
    const validation = state.transcript == null ? { valid: false, failedInvariant: "missing_transcript" } : this.coordinator.speechValidator(state.plan, state.transcript);
    this.session.responseRegistry.complete(responseId, { validationResult: validation });
    if (!state.plan.critical) return;
    if (!current || entry?.invalidated || !validation.valid || state.audio.length === 0) return this.#discard(responseId, !current ? "STALE_PROPOSAL" : validation.failedInvariant || "NO_AUDIO");
    const payload = Buffer.concat(state.audio.map((chunk) => Buffer.from(chunk, "base64"))).toString("base64"); const markId = `v2-mark-${++this.markSequence}`;
    this.twilio.submitAudio({ payload }); this.twilio.sendMark({ markId });
    this.session.playbackRegistry.register({ markId, responseId, proposalVersion: state.plan.proposalVersion }); this.session.playbackRegistry.submit(markId, Buffer.from(payload, "base64").length);
    state.markId = markId; const correlation = Object.freeze({ responseId, proposalVersion: state.plan.proposalVersion }); this.marks.set(markId, correlation);
    this.events.push(Object.freeze({ type: TransportEvent.CRITICAL_AUDIO_RELEASED, responseId, markId, bytes: Buffer.from(payload, "base64").length }));
  }

  #discard(responseId, reason) { const state = this.responses.get(responseId); if (state) state.audio = []; this.events.push(Object.freeze({ type: TransportEvent.CRITICAL_AUDIO_DISCARDED, responseId, reason })); }

  #retryOnce(providerRequestId) {
    const tracked = this.requests.get(providerRequestId); if (!tracked || tracked.retryScheduled || tracked.attempts >= 2 || this.terminated) return;
    tracked.retryScheduled = true; this.schedule(() => { tracked.retryScheduled = false; this.requestResponse({ requestId: tracked.requestId, plan: tracked.plan }); });
  }
}
