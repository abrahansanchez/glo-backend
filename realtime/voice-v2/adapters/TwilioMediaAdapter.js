import { bindSocket, parseJsonMessage, sendJson, transportEvent, TransportEvent } from "./transportMessages.js";

export class TwilioMediaAdapter {
  #socket;
  #emit;
  #closed = false;
  #callSid = null;
  #streamSid = null;
  #inboundBytes = 0;
  #outboundBytes = 0;
  #sequence = 0;

  constructor({ socket, onEvent = () => {} }) {
    if (!socket) throw new TypeError("socket_required");
    this.#socket = socket; this.#emit = onEvent;
    bindSocket(socket, { message: (raw) => this.#onMessage(raw), close: (details) => this.#onClose(details), error: (error) => this.#onError(error) });
  }

  get identity() { return Object.freeze({ callSid: this.#callSid, streamSid: this.#streamSid }); }
  get metrics() { return Object.freeze({ inboundBytes: this.#inboundBytes, outboundBytes: this.#outboundBytes, sequence: this.#sequence }); }
  get closed() { return this.#closed; }

  submitAudio({ payload }) {
    this.#requireStream(); validateBase64(payload);
    this.#outboundBytes += Buffer.from(payload, "base64").length;
    return sendJson(this.#socket, { event: "media", streamSid: this.#streamSid, media: { payload } });
  }

  sendMark({ markId }) {
    this.#requireStream(); if (!markId) throw new TypeError("mark_id_required");
    return sendJson(this.#socket, { event: "mark", streamSid: this.#streamSid, mark: { name: markId } });
  }

  clearPlayback() { this.#requireStream(); return sendJson(this.#socket, { event: "clear", streamSid: this.#streamSid }); }

  close(code, reason) {
    if (this.#closed) return;
    this.#closed = true; this.#socket.close?.(code, reason);
  }

  #onMessage(raw) {
    let message;
    try { message = parseJsonMessage(raw); } catch (error) { return this.#onError(error); }
    this.#sequence += 1;
    const provider = Object.freeze({ sequenceNumber: message.sequenceNumber ?? null, transportSequence: this.#sequence });
    if (message.event === "start") {
      const callSid = message.start?.callSid; const streamSid = message.start?.streamSid || message.streamSid;
      if (!callSid || !streamSid) return this.#onError(new TypeError("invalid_twilio_start"));
      if ((this.#callSid && this.#callSid !== callSid) || (this.#streamSid && this.#streamSid !== streamSid)) return this.#onError(new TypeError("immutable_transport_identity"));
      this.#callSid = callSid; this.#streamSid = streamSid;
      return this.#publish(TransportEvent.TWILIO_STREAM_STARTED, { callSid, streamSid, provider });
    }
    if (message.event === "media") {
      if (message.media?.track && message.media.track !== "inbound") return;
      try { this.#requireIdentity(message.streamSid); validateBase64(message.media?.payload); } catch (error) { return this.#onError(error); }
      const bytes = Buffer.from(message.media.payload, "base64").length; this.#inboundBytes += bytes;
      return this.#publish(TransportEvent.CALLER_AUDIO, { callSid: this.#callSid, streamSid: this.#streamSid, payload: message.media.payload, bytes, timestamp: message.media.timestamp ?? null, chunk: message.media.chunk ?? null, provider });
    }
    if (message.event === "mark") {
      try { this.#requireIdentity(message.streamSid); } catch (error) { return this.#onError(error); }
      return this.#publish(TransportEvent.PLAYBACK_MARK_ACKNOWLEDGED, { callSid: this.#callSid, streamSid: this.#streamSid, markId: message.mark?.name ?? null, provider });
    }
    if (message.event === "stop") {
      try { this.#requireIdentity(message.streamSid); } catch (error) { return this.#onError(error); }
      this.#closed = true; return this.#publish(TransportEvent.TWILIO_STREAM_STOPPED, { callSid: this.#callSid, streamSid: this.#streamSid, provider });
    }
    this.#onError(new TypeError("unsupported_twilio_event"));
  }

  #requireIdentity(streamSid) { this.#requireStream(); if (streamSid && streamSid !== this.#streamSid) throw new TypeError("immutable_transport_identity"); }
  #requireStream() { if (this.#closed || !this.#streamSid) throw new TypeError("twilio_stream_not_active"); }
  #onClose(details) { if (this.#closed) return; this.#closed = true; this.#publish(TransportEvent.TWILIO_CONNECTION_CLOSED, { callSid: this.#callSid, streamSid: this.#streamSid, code: details?.code ?? null, reason: details?.reason?.toString?.() || null }); }
  #onError(error) { this.#publish(TransportEvent.TWILIO_TRANSPORT_ERROR, { callSid: this.#callSid, streamSid: this.#streamSid, error: normalizeError(error) }); }
  #publish(type, details) { const event = transportEvent(type, details); this.#emit(event); return event; }
}

function validateBase64(value) {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) throw new TypeError("invalid_base64_audio");
}
function normalizeError(error) { return Object.freeze({ name: error?.name || "Error", message: error?.message || String(error) }); }
