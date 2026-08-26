import test from "node:test";
import assert from "node:assert/strict";
import { TwilioMediaAdapter } from "../../adapters/TwilioMediaAdapter.js";
import { FakeSocket } from "../helpers/FakeSocket.js";

const audio = Buffer.from([1, 2, 3]).toString("base64");
function setup() { const socket = new FakeSocket(); const events = []; const adapter = new TwilioMediaAdapter({ socket, onEvent: (event) => events.push(event) }); return { socket, events, adapter }; }
function start(state) { state.socket.receive({ event: "start", sequenceNumber: "1", start: { callSid: "CA1", streamSid: "MZ1" } }); }

test("parses start identity once and preserves provider correlation", () => {
  const state = setup(); start(state);
  assert.deepEqual(state.adapter.identity, { callSid: "CA1", streamSid: "MZ1" });
  assert.equal(state.events[0].type, "TWILIO_STREAM_STARTED"); assert.equal(state.events[0].provider.sequenceNumber, "1");
  state.socket.receive({ event: "start", start: { callSid: "CA2", streamSid: "MZ1" } });
  assert.equal(state.events.at(-1).error.message, "immutable_transport_identity"); assert.equal(state.adapter.identity.callSid, "CA1");
});

test("emits only valid inbound caller media and tracks bytes", () => {
  const state = setup(); start(state);
  state.socket.receive({ event: "media", streamSid: "MZ1", media: { track: "outbound", payload: audio } });
  state.socket.receive({ event: "media", streamSid: "MZ1", media: { track: "inbound", payload: audio, timestamp: "20", chunk: "2" } });
  assert.equal(state.events.filter((event) => event.type === "CALLER_AUDIO").length, 1); assert.equal(state.adapter.metrics.inboundBytes, 3);
  state.socket.receive({ event: "media", streamSid: "MZ1", media: { track: "inbound", payload: "%%%" } });
  assert.equal(state.events.at(-1).type, "TWILIO_TRANSPORT_ERROR");
});

test("serializes outbound PCMU media, mark, and clear with stream identity", () => {
  const state = setup(); start(state); state.adapter.submitAudio({ payload: audio }); state.adapter.sendMark({ markId: "mark-1" }); state.adapter.clearPlayback();
  assert.deepEqual(state.socket.sent, [
    { event: "media", streamSid: "MZ1", media: { payload: audio } },
    { event: "mark", streamSid: "MZ1", mark: { name: "mark-1" } },
    { event: "clear", streamSid: "MZ1" },
  ]); assert.equal(state.adapter.metrics.outboundBytes, 3);
});

test("normalizes mark acknowledgement, stop, close, error, and late mark", () => {
  const state = setup(); start(state); state.socket.receive({ event: "mark", streamSid: "MZ1", mark: { name: "mark-1" } });
  assert.equal(state.events.at(-1).type, "PLAYBACK_MARK_ACKNOWLEDGED"); assert.equal(state.events.at(-1).markId, "mark-1");
  state.socket.receive({ event: "stop", streamSid: "MZ1" }); assert.equal(state.events.at(-1).type, "TWILIO_STREAM_STOPPED");
  assert.throws(() => state.adapter.sendMark({ markId: "late" }), /not_active/);
  const closed = setup(); start(closed); closed.socket.emit("close", { code: 1006, reason: "lost" }); assert.equal(closed.events.at(-1).type, "TWILIO_CONNECTION_CLOSED");
  const failed = setup(); failed.socket.fail(new Error("boom")); assert.equal(failed.events.at(-1).type, "TWILIO_TRANSPORT_ERROR");
});

test("rejects operations before start and closes at most once", () => {
  const state = setup(); assert.throws(() => state.adapter.submitAudio({ payload: audio }), /not_active/);
  start(state); state.adapter.close(1000, "done"); state.adapter.close(1000, "again"); assert.equal(state.socket.closeCalls.length, 1);
});
