import assert from "node:assert/strict";
import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { createBookingProposal, deriveSlotKey } from "../../domain/BookingProposal.js";
import { planResponse, ResponsePurpose } from "../../planning/ResponsePlanner.js";
import { FakeSocket } from "./FakeSocket.js";

// Synthetic fixtures only. Every external operation is replaced at an adapter boundary.
export const BOOKING_ES = "Necesito un corte de pelo el jueves a las diez de la manana";
export const BOOKING_EN = "I need a Haircut Thursday at 10 AM";
export async function fixture(t, { id = "synthetic-session", language = "es", complete = false, diagnosticObserver = null } = {}) {
  const twilio = new FakeSocket(); const socket = new FakeSocket();
  const logs = []; const persisted = []; const effects = { availability: [], booking: [], sms: [] };
  const facts = { service: "Haircut", date: "2026-09-24", time: "10:00", name: "Synthetic" };
  const proposal = complete ? createBookingProposal({ proposalId: id, proposalVersion: 1, ...facts,
    availability: { proposalVersion: 1, slotKey: deriveSlotKey(facts), status: "available" } })
    : createBookingProposal({ proposalId: id });
  const app = initializeVoiceV2Session({
    callSid: id, callerNumber: "synthetic-caller", buildSha: "synthetic-proof", proposal,
    businessContext: { businessId: "synthetic-business", barberId: "synthetic-barber", businessName: "Synthetic", timeZone: "America/New_York", preferredLanguage: language },
    twilioSocket: twilio, openaiSocketFactory: () => socket,
    openaiSession: { model: "offline", input_audio_transcription: { model: "offline", language } },
    turnContext: { language, availableServices: [{ canonical: "Haircut", aliases: ["haircut", "corte", "corte de pelo"] }], referenceDate: "2026-09-22" },
    now: () => new Date("2026-09-22T12:00:00.000Z"),
    timingOptions: { monotonicNow: () => 10, wallNow: () => "2026-09-22T12:00:00.000Z" },
    speechAdapter: { synthesize: async () => ({ audio: Buffer.alloc(160, 0xff), format: "audio/pcmu" }) },
    availabilityAdapter: {
      checkAvailability: async (request) => { effects.availability.push(request); return { available: true, slotKey: request.slotKey }; },
      getAlternatives: async () => ({ alternatives: [] }), searchAvailableTimes: async () => ({ alternatives: [] }),
    },
    bookingAdapter: { createAppointment: async (request) => { effects.booking.push(request); return { success: true, appointmentId: "synthetic-appointment" }; } },
    smsAdapter: { sendAppointmentConfirmation: async (request) => { effects.sms.push(request); return { success: true, submitted: true }; } },
    transcriptAdapter: { appendTurn: async (turn) => { persisted.push(turn); return { success: true }; }, finalizeCall: async () => ({ success: true }) },
    callControlAdapter: { terminateCall: async () => ({ success: true }) },
    localRecoveryAudioAdapter: { prepare() {}, getAudio: () => { throw new Error("SYNTHETIC_RECOVERY_UNAVAILABLE"); } },
    emit: (entry) => { logs.push(entry); if (entry.event === "V2_TURN_ORDER_DIAGNOSTIC") return diagnosticObserver?.(entry); },
  });
  const f = { app, socket, twilio, logs, persisted, effects, streamSid: `stream-${id}`, language };
  t.after(async () => { await finish(f); });
  twilio.receive({ event: "start", start: { callSid: id, streamSid: f.streamSid } });
  socket.open(); socket.receive({ type: "session.created" }); await settle(f);
  socket.receive({ type: "session.updated" }); await settle(f);
  const request = socket.sent.find((entry) => entry.type === "response.create");
  assert.ok(request, "synthetic greeting was requested");
  socket.receive({ type: "response.created", response: { id: "synthetic-greeting", metadata: request.response.metadata } });
  socket.receive({ type: "response.output_audio.delta", response_id: "synthetic-greeting", delta: "AQID" });
  socket.receive({ type: "response.output_audio_transcript.done", response_id: "synthetic-greeting", transcript: "Welcome." });
  socket.receive({ type: "response.done", response: { id: "synthetic-greeting", status: "completed" } });
  await settle(f); await acknowledge(f);
  return f;
}
export async function settle(f) { for (let i = 0; i < 12; i++) { await Promise.resolve(); await f.app.ready(); } }
export async function event(f, type, itemId, extra = {}) {
  f.socket.receive({ type, item_id: itemId, event_id: `event-${++eventSequence}`, ...extra }); await settle(f);
}
let eventSequence = 0;
export const start = (f, id, extra) => event(f, "input_audio_buffer.speech_started", id, extra);
export const stop = (f, id) => event(f, "input_audio_buffer.speech_stopped", id);
export const finalized = (f, id, transcript) => event(f, "conversation.item.input_audio_transcription.completed", id, { transcript });
export async function ordinary(f, id, transcript) { await start(f, id); await stop(f, id); await finalized(f, id, transcript); }
export function journal(f, kind) { return f.app.session.journal().filter((entry) => entry.event === kind); }
export function interpretedItems(f) {
  const identities = new Map(journal(f, "TURN_ACCEPTED").map((entry) => [entry.turnId, entry.providerId]));
  return journal(f, "TURN_INTERPRETED").map((entry) => identities.get(entry.turnId));
}
export function callerWrites(f) { return f.persisted.filter((entry) => entry.role === "caller"); }
export function noBusinessEffects(f) { assert.equal(f.effects.availability.length, 0); assert.equal(f.effects.booking.length, 0); assert.equal(f.effects.sms.length, 0); }
export async function finish(f) { if (!f.app.lifecycle.terminated) await f.app.terminate("SYNTHETIC_TEST_COMPLETE"); await settle(f); }
export function boundary(f, id) { return f.logs.find((entry) => entry.traceEvent === "CONSENT_BOUNDARY" && entry.itemId === id); }
export async function acknowledge(f) {
  const mark = f.twilio.sent.filter((entry) => entry.event === "mark").at(-1); assert.ok(mark);
  f.twilio.receive({ event: "mark", streamSid: f.streamSid, mark: mark.mark }); await settle(f);
}
export async function confirmation(f) {
  await f.app.requestResponse(planResponse({ proposal: f.app.session.proposal, purpose: ResponsePurpose.PRE_BOOKING_CONFIRMATION, language: f.language }));
  await settle(f); await acknowledge(f);
  assert.equal(f.app.session.floorOwner.snapshot.state, "AWAIT_CONSENT");
}
