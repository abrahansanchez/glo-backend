import test from "node:test";
import assert from "node:assert/strict";
import Appointment from "../../../../models/Appointment.js";
import { getUpcomingAppointments } from "../../../../controllers/appointmentController.js";
import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { SharedBookingAdapter } from "../../adapters/SharedBookingAdapter.js";
import { createBookingProposal } from "../../domain/BookingProposal.js";
import { interpretTurn } from "../../interpretation/TurnInterpreter.js";
import { matchServiceCatalogue } from "../../interpretation/extractors/ServiceExtractor.js";
import { buildServiceCatalogue } from "../../interpretation/buildServiceCatalogue.js";
import { reduceBooking } from "../../domain/BookingReducer.js";
import { additionalServicesNote } from "../../domain/AdditionalServices.js";
import { computeBookingRequestHash } from "../../../../services/booking/createIdempotentAppointment.js";
import { FakeSocket } from "../helpers/FakeSocket.js";

const catalogue = [{ canonical: "Haircut", aliases: ["corte de pelo"] }, { canonical: "Beard Trim", aliases: ["beard cut", "barba"] }];
const businessId = "507f1f77bcf86cd799439011";
const requests = { en: "I want a haircut and my beard cut.", es: "Quiero hacer una cita para un corte de pelo y de barba." };

for (const [language, transcript, followUp] of [
  ["en", "Hi, I wanna get a haircut and my beard cut.", "Saturday, please."],
  ["es", "Hola, quiero hacer cita para un corte de pelo y de barba.", "Para el sábado, por favor."],
]) {
  test(`${language} exact production compound wording preserves services through date follow-up`, async t => {
    const f = await fixture(t, language);
    await f.turn(transcript, "exact-services");
    assert.equal(f.app.session.proposal.service, "Haircut");
    assert.deepEqual(f.app.session.proposal.additionalServices, ["Beard Trim"]);
    await f.complete();
    await f.turn(followUp, "exact-follow-up");
    assert.equal(f.app.session.proposal.date, "2026-10-17");
    assert.equal(f.app.session.proposal.service, "Haircut");
    assert.deepEqual(f.app.session.proposal.additionalServices, ["Beard Trim"]);
    assert.equal(f.bookings.length, 0);
    assert.equal(f.sms.length, 0);
  });
}

for (const language of ["en", "es"]) {
  for (const compound of [true, false]) {
    test(`${language} ${compound ? "compound" : "single"} real session creates one authorized appointment`, async t => {
      const f = await fixture(t, language);
      const text = compound ? requests[language] : language === "en" ? "I want a haircut." : "Quiero un corte de pelo.";
      await f.turn(text, "services");
      const first = f.app.session.proposal;
      const operation = f.app.session.journal().find(e => e.event === "TURN_INTERPRETED")?.action;
      await f.complete();
      await f.turn(language === "en" ? "tomorrow" : "mañana", "date"); await f.complete();
      await f.turn("3 pm", "time"); await f.complete();
      await f.turn(language === "en" ? "my name is Synthetic" : "mi nombre es Synthetic", "name");
      const beforeConfirmation = f.bookings.length;
      await f.complete();
      const beforeYes = f.bookings.length;
      await f.turn(language === "en" ? "yes" : "sí", "affirm");
      await f.turn(language === "en" ? "yes" : "sí", "affirm");
      console.log(JSON.stringify({ fixture: language + (compound ? "_compound" : "_single"), operation,
        primary: first.service, additional: first.additionalServices || [], availability: f.availability.length,
        booking: f.bookings.length, sms: f.sms.length, commandHasNotes: Boolean(f.commands[0]?.notes), persistedHasNotes: Boolean(f.bookings[0]?.notes) }));
      assert.equal(first.service, "Haircut");
      assert.deepEqual(first.additionalServices || [], compound ? ["Beard Trim"] : []);
      assert.equal(beforeConfirmation, 0); assert.equal(beforeYes, 0);
      assert.equal(f.availability.length, 1); assert.equal(f.availability[0].service, "Haircut");
      assert.equal(f.bookings.length, 1); assert.equal(f.commands.length, 1); assert.equal(f.sms.length, 1);
      assert.equal(f.bookings[0].service, "Haircut");
      assert.equal((f.bookings[0].endAt - f.bookings[0].startAt) / 60000, 30);
      if (compound) {
        assert.equal(f.commands[0].notes, "Customer also requested Beard Trim.");
        assert.equal(f.bookings[0].notes, f.commands[0].notes);
        const replay = await f.bookingAdapter.createAppointment(f.commands[0]);
        assert.equal(replay.replayed, true); assert.equal(f.bookings.length, 1);
      } else { assert.equal("notes" in f.commands[0], false); assert.equal("notes" in f.bookings[0], false); }
      assert.equal(f.app.session.journal().filter(e => e.event === "CONFIRMATION_AUTHORITY_GRANTED").length, 1);
      const stored = new Appointment(f.bookings[0]);
      await stored.validate();
      const serialized = JSON.parse(JSON.stringify(stored));
      assert.equal(serialized.notes, compound ? "Customer also requested Beard Trim." : undefined);
      const oldFind = Appointment.find;
      Appointment.find = () => ({ sort: () => ({ lean: async () => [serialized] }) });
      try {
        let payload;
        await getUpcomingAppointments({ user: { _id: businessId } }, { json: value => { payload = value; }, status: () => { throw new Error("unexpected status"); } });
        assert.equal(payload.appointments[0].notes, serialized.notes);
      } finally { Appointment.find = oldFind; }
    });
  }
}

test("fixture independently grounds both service identities without authorizing an ambiguous choice", () => {
  for (const text of Object.values(requests)) assert.deepEqual(matchServiceCatalogue(text, { availableServices: catalogue }).candidates.map(c => c.canonical), ["Haircut", "Beard Trim"]);
});

for (const [language, correction] of [["en", "Actually, only the haircut."], ["es", "En realidad, solamente el corte de pelo."]]) {
  test(`${language} session correction removes additional services before authorization`, async t => {
    const f = await fixture(t, language);
    await f.turn(requests[language], "compound"); await f.complete();
    assert.deepEqual(f.app.session.proposal.additionalServices, ["Beard Trim"]);
    await f.turn(correction, "correction"); await f.complete();
    assert.equal(f.app.session.proposal.additionalServices, undefined);
    await f.turn(language === "en" ? "tomorrow" : "mañana", "date"); await f.complete();
    await f.turn("3 pm", "time"); await f.complete();
    await f.turn(language === "en" ? "my name is Synthetic" : "mi nombre es Synthetic", "name");
    assert.equal(f.bookings.length, 0); await f.complete();
    await f.turn(language === "en" ? "yes" : "sí", "yes");
    assert.equal(f.availability.length, 1); assert.equal(f.bookings.length, 1); assert.equal(f.sms.length, 1);
    assert.equal("notes" in f.bookings[0], false);
  });
}

for (const [text, primary, additional] of [
  [requests.en, "Haircut", ["Beard Trim"]], [requests.es, "Haircut", ["Beard Trim"]],
  ["beard cut and haircut", "Beard Trim", ["Haircut"]],
  ["barba y corte de pelo", "Beard Trim", ["Haircut"]],
  ["haircut and haircut", "Haircut", []],
  ["haircut and unsupported treatment", "Haircut", []],
]) {
  test(`catalogue mention order and deduplication case ${primary}/${text === requests.es ? "es" : text.length}`, async () => {
    const interpreted = await interpretTurn({ transcript: text, sourceTurnId: "synthetic", availableServices: catalogue,
      currentProposal: createBookingProposal({ proposalId: "unit" }) });
    assert.equal(interpreted.interpretation.service, primary);
    assert.deepEqual(interpreted.interpretation.additionalServices || [], additional);
    const reduced = reduceBooking(createBookingProposal({ proposalId: "unit" }), interpreted.interpretation);
    assert.equal(reduced.nextProposal.service, primary);
    assert.deepEqual(reduced.nextProposal.additionalServices || [], additional);
  });
}

test("production catalogue aliases ground only independently offered services", async () => {
  for (const text of Object.values(requests)) {
    const all = buildServiceCatalogue([{ name: "Haircut" }, { name: "Beard Trim" }]);
    const result = await interpretTurn({ transcript: text, sourceTurnId: "catalogue", availableServices: all, currentProposal: createBookingProposal({ proposalId: "catalogue" }) });
    assert.equal(result.interpretation.service, "Haircut"); assert.deepEqual(result.interpretation.additionalServices, ["Beard Trim"]);
    const missing = await interpretTurn({ transcript: text, sourceTurnId: "missing", availableServices: buildServiceCatalogue([{ name: "Haircut" }]), currentProposal: createBookingProposal({ proposalId: "missing" }) });
    assert.equal(missing.interpretation.service, "Haircut"); assert.equal(missing.interpretation.additionalServices, undefined);
  }
});

for (const correction of ["Actually, only the haircut.", "En realidad, solamente el corte de pelo.", "Actually, beard cut."]) {
  test(`explicit correction replaces the service set (${correction.length})`, async () => {
    const f = { currentProposal: createBookingProposal({ proposalId: "correction", service: "Haircut", additionalServices: ["Beard Trim"], date: "2026-10-13", time: "15:00", name: "Synthetic" }) };
    const interpreted = await interpretTurn({ ...f, transcript: correction, sourceTurnId: "correction", availableServices: catalogue });
    const reduced = reduceBooking(f.currentProposal, interpreted.interpretation);
    assert.equal(reduced.nextProposal.service, correction.includes("beard") ? "Beard Trim" : "Haircut");
    assert.equal(reduced.nextProposal.additionalServices, undefined);
    assert.equal(reduced.nextProposal.date, f.currentProposal.date); assert.equal(reduced.nextProposal.name, "Synthetic");
    assert.equal(reduced.nextProposal.proposalVersion, f.currentProposal.proposalVersion + 1);
  });
}

test("seven additional services and note/model bounds fail closed without truncation", async () => {
  const services = Array.from({ length: 9 }, (_, i) => ({ canonical: `Service ${String.fromCharCode(65 + i)}`, aliases: [] }));
  const eight = await interpretTurn({ transcript: services.slice(0, 8).map(s => s.canonical).join(" and "), sourceTurnId: "eight", availableServices: services });
  assert.equal(eight.interpretation.additionalServices.length, 7);
  const note = additionalServicesNote({ service: services[0].canonical, additionalServices: services.slice(1, 8).map(s => s.canonical) });
  assert.ok(note.length <= 1024);
  const nine = await interpretTurn({ transcript: services.map(s => s.canonical).join(" and "), sourceTurnId: "nine", availableServices: services });
  assert.equal(nine.interpretation.action, "CLARIFY");
  assert.equal(nine.interpretation.additionalServices, undefined); assert.equal(nine.interpretation.service, undefined);
  assert.throws(() => createBookingProposal({ proposalId: "overflow", service: "Primary", additionalServices: services.slice(1).map(s => s.canonical) }), /invalid_additional_services/);
  assert.throws(() => additionalServicesNote({ service: "Primary", additionalServices: ["x".repeat(129)] }), /invalid_additional_services/);
  const invalid = new Appointment({ barberId: businessId, clientName: "Synthetic", startAt: new Date(), endAt: new Date(), notes: "x".repeat(1025) });
  await assert.rejects(invalid.validate(), /longer than/);
});

test("notes are part of idempotent booking identity; missing notes preserve the single-service hash", () => {
  const command = { barberId: businessId, service: "Haircut", date: "2026-10-13", time: "15:00", timeZone: "America/New_York", clientName: "Synthetic", callerNumber: "+15550000000" };
  assert.notEqual(computeBookingRequestHash(command, 30), computeBookingRequestHash({ ...command, notes: "Customer also requested Beard Trim." }, 30));
});

test("additional service changes invalidate confirmation without changing the selected slot", () => {
  const before = createBookingProposal({ proposalId: "authority", service: "Haircut", date: "2026-10-13", time: "15:00", name: "Synthetic",
    availability: { proposalVersion: 1, slotKey: JSON.stringify(["Haircut", "2026-10-13", "15:00"]), status: "available" } });
  const changed = reduceBooking(before, { action: "MODIFY_SERVICE", service: "Haircut", additionalServices: ["Beard Trim"], sourceTurnId: "add", confidence: "explicit" });
  assert.equal(changed.nextProposal.proposalVersion, 2);
  assert.equal(changed.nextProposal.service, before.service);
  assert.equal(changed.nextProposal.confirmation.status, "none");
  assert.equal(changed.nextProposal.availability.status, "available");
  assert.equal(changed.effects.length, 0);
  assert.equal(changed.effects.some(e => e.type === "AUTHORIZE_BOOKING"), false);
  assert.deepEqual(changed.nextProposal.additionalServices, ["Beard Trim"]);
});

async function fixture(t, language, proposal = createBookingProposal({ proposalId: "compound-fixture" })) {
  const twilio = new FakeSocket(), openai = new FakeSocket(); openai.readyState = 0;
  const bookings = [], commands = [], availability = [], sms = [];
  const bookingAdapter = new SharedBookingAdapter({ dependencies: {
    findBarberById: async () => ({ availability: { timezone: "America/New_York" } }),
    getServiceDuration: (_barber, service) => service === "Haircut" ? 30 : 15,
    checkAvailability: async () => true,
    findByIdempotencyKey: async (_barber, key) => bookings.find(a => a.bookingCommand.idempotencyKey === key),
    createAppointment: async values => { const stored = { _id: "507f1f77bcf86cd799439012", ...values }; bookings.push(stored); return stored; },
  } });
  const app = initializeVoiceV2Session({ callSid: `CA-synthetic-${language}`, buildSha: "offline", callerNumber: "+15550000000",
    businessContext: { businessId, barberId: businessId, timeZone: "America/New_York" },
    twilioSocket: twilio, openaiSocketFactory: () => openai,
    proposal, scheduler: { schedule: () => ({}), cancel: () => {} },
    turnContext: { language, availableServices: catalogue, referenceDate: "2026-10-12" }, now: () => new Date("2026-10-12T16:00:00Z"),
    availabilityAdapter: { checkAvailability: async command => { availability.push(command); return { available: true, proposalVersion: command.proposalVersion, slotKey: command.slotKey }; } },
    bookingAdapter: { createAppointment: command => { commands.push(command); return bookingAdapter.createAppointment(command); } },
    smsAdapter: { sendAppointmentConfirmation: async command => { sms.push(command); return { success: true }; } },
    transcriptAdapter: { appendTurn: async () => ({ success: true }), finalizeCall: async () => ({ success: true }) }, emit: () => {},
  });
  t.after(() => app.terminate("TEST_DONE"));
  let responseSequence = 0;
  const creates = () => openai.sent.filter(e => e.type === "response.create");
  const lastPurpose = () => creates().at(-1)?.response.metadata.purpose;
  async function complete() {
    const create = creates().at(-1); if (!create) return;
    const instructions = JSON.parse(create.response.instructions);
    const transcript = instructions.speechContract.requiredMessage || ({ INITIAL_GREETING: "Hello", ASK_DATE: "What date would you like?", ASK_TIME: "What time would you like?", ASK_NAME: "What is your name?", CLARIFICATION: "Could you repeat that?" }[instructions.purpose]);
    if (!transcript) return;
    const id = `synthetic-response-${++responseSequence}`;
    openai.receive({ type: "response.created", response: { id, metadata: create.response.metadata } });
    openai.receive({ type: "response.output_audio.delta", response_id: id, delta: "AQID" });
    openai.receive({ type: "response.output_audio_transcript.done", response_id: id, transcript });
    openai.receive({ type: "response.done", response: { id, status: "completed" } }); await settle(app);
    const mark = twilio.sent.filter(e => e.event === "mark").at(-1);
    if (mark) { twilio.receive({ event: "mark", streamSid: "MZ-synthetic", mark: mark.mark }); await settle(app); }
  }
  async function turn(transcript, item_id) { openai.receive({ type: "conversation.item.input_audio_transcription.completed", item_id, transcript }); await settle(app); }
  openai.open(); twilio.receive({ event: "start", start: { callSid: app.session.callSid, streamSid: "MZ-synthetic" } });
  openai.receive({ type: "session.created" }); await settle(app); openai.receive({ type: "session.updated" }); await settle(app); await complete();
  return { app, turn, complete, lastPurpose, bookings, commands, availability, sms, bookingAdapter };
}
async function settle(app) { for (let i = 0; i < 15; i++) { await Promise.resolve(); await app.ready(); } }

for (const [language, text, expected] of [
  ["en", "Actually, forget the beard. Just the haircut, please.", ["Haircut", []]],
  ["es", "Mejor solamente el corte de pelo; la barba no.", ["Haircut", []]],
  ["en", "A beard cut and a haircut, in that order please.", ["Beard Trim", ["Haircut"]]],
  ["es", "Un arreglo de barba y un corte de pelo, por favor.", ["Beard Trim", ["Haircut"]]],
]) {
  test(`natural service wording ${language}: ${text}`, async t => {
    const f = await fixture(t, language);
    await f.turn(requests[language], "before-correction"); await f.complete();
    await f.turn(text, "natural-correction");
    assert.equal(f.app.session.proposal.service, expected[0]);
    assert.deepEqual(f.app.session.proposal.additionalServices || [], expected[1]);
    assert.equal(f.bookings.length, 0); assert.equal(f.sms.length, 0);
  });
}

test("Spanish negated service correction preserves collected facts and creates no note or pre-confirmation effects", async t => {
  const original = createBookingProposal({ proposalId: "collected-correction", service: "Haircut", additionalServices: ["Beard Trim"],
    date: "2026-10-17", time: "15:00", name: "Synthetic",
    availability: { proposalVersion: 1, slotKey: JSON.stringify(["Haircut", "2026-10-17", "15:00"]), status: "available" } });
  const f = await fixture(t, "es", original);
  await f.turn("Mejor solamente el corte de pelo; la barba no.", "collected-correction");
  const corrected = f.app.session.proposal;
  assert.equal(corrected.service, "Haircut"); assert.deepEqual(corrected.additionalServices || [], []);
  for (const field of ["date", "time", "name"]) assert.equal(corrected[field], original[field]);
  assert.equal(additionalServicesNote(corrected), null);
  assert.equal(f.availability.length, 0); assert.equal(f.bookings.length, 0); assert.equal(f.sms.length, 0);
  assert.equal(f.lastPurpose(), "PRE_BOOKING_CONFIRMATION");
  await f.complete();
  assert.equal(f.bookings.length, 0); assert.equal(f.sms.length, 0);
  await f.turn("sí", "corrected-affirm");
  assert.equal(f.bookings.length, 1); assert.equal(f.sms.length, 1);
  assert.equal("notes" in f.commands[0], false); assert.equal("notes" in f.bookings[0], false);
});

for (const [text, expected] of [
  ["Solamente el corte; el color no.", ["Beard Trim"]],
  ["La barba no, por favor.", ["Color"]],
]) {
  test(`grounded negation removes only its named service: ${text}`, async () => {
    const current = createBookingProposal({ proposalId: "other-services", service: "Haircut", additionalServices: ["Beard Trim", "Color"],
      date: "2026-10-17", time: "15:00", name: "Synthetic" });
    const result = await interpretTurn({ transcript: text, sourceTurnId: "remove-one", currentProposal: current,
      availableServices: [...catalogue, { canonical: "Color", aliases: ["color"] }] });
    const reduced = reduceBooking(current, result.interpretation).nextProposal;
    assert.equal(reduced.service, "Haircut"); assert.deepEqual(reduced.additionalServices, expected);
    for (const field of ["date", "time", "name"]) assert.equal(reduced[field], current[field]);
    assert.equal(additionalServicesNote(reduced), `Customer also requested ${expected[0]}.`);
  });
}
