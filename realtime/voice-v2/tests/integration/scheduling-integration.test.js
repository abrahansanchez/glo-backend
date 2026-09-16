import test from "node:test";
import assert from "node:assert/strict";
import moment from "moment-timezone";

import Appointment from "../../../../models/Appointment.js";
import { initializeVoiceV2Session } from "../../initializeVoiceV2Session.js";
import { SharedBookingAdapter } from "../../adapters/SharedBookingAdapter.js";
import { V1AvailabilityAdapter } from "../../adapters/V1AvailabilityAdapter.js";
import { createBookingProposal, deriveSlotKey } from "../../domain/BookingProposal.js";
import { ResponsePurpose } from "../../planning/ResponsePlanner.js";
import { FakeSocket } from "../helpers/FakeSocket.js";

const BUSINESS = Object.freeze({ businessId: "business-scheduling", barberId: "barber-scheduling", timeZone: "America/New_York" });
const REFERENCE_DATE = new Date("2026-10-12T16:00:00Z");

test("real shared scheduling helpers search beyond a closed day and retain timezone and service duration", async () => {
  const originalFindOne = Appointment.findOne;
  const originalMomentNow = moment.now;
  moment.now = () => REFERENCE_DATE.getTime();
  Appointment.findOne = async () => null;
  try {
    const adapter = realAdapter(schedulingBarber());
    const request = searchRequest({ requestedDate: "2026-10-15", proposalVersion: 2 });
    const result = await adapter.searchAvailableTimes(request);

    assert.equal(result.proposalVersion, request.proposalVersion);
    assert.equal(result.proposalSlotKey, request.proposalSlotKey);
    assert.equal(result.reason, "BUSINESS_CLOSED");
    assert.equal(result.metadata.durationMinutes, 45);
    assert.equal(result.metadata.timeZone, "America/New_York");
    assert.ok(result.alternatives.length > 0);
    assert.equal(result.alternatives[0].date, "2026-10-16");
    assert.equal(result.alternatives[0].time, "09:00");
  } finally {
    Appointment.findOne = originalFindOne;
    moment.now = originalMomentNow;
  }
});

test("real later search returns only later eligible slots and V1 conflict queries include the configured buffer", async () => {
  const originalFindOne = Appointment.findOne;
  const originalMomentNow = moment.now;
  moment.now = () => REFERENCE_DATE.getTime();
  const queries = [];
  Appointment.findOne = async (query) => {
    queries.push(query);
    return queries.length === 1 ? { _id: "existing-conflict" } : null;
  };
  try {
    const adapter = realAdapter(schedulingBarber());
    const request = searchRequest({ searchType: "LATER", requestedDate: "2026-10-16", afterTime: "09:00", proposalVersion: 2 });
    const result = await adapter.searchAvailableTimes(request);

    assert.ok(result.alternatives.length > 0);
    assert.ok(result.alternatives.every((slot) => `${slot.date}T${slot.time}` > "2026-10-16T09:00"));
    assert.equal(result.alternatives[0].time, "10:00", "the conflicting buffered 9:30 slot must be excluded");
    assert.equal(moment(queries[0].$or[0].startAt.$gte).tz("America/New_York").format("HH:mm"), "09:20");
    assert.equal(moment(queries[0].$or[0].startAt.$lt).tz("America/New_York").format("HH:mm"), "10:25");
  } finally {
    Appointment.findOne = originalFindOne;
    moment.now = originalMomentNow;
  }
});

test("real shared scheduling treats a blackout as closed and searches within the existing bounded helper policy", async () => {
  const originalFindOne = Appointment.findOne;
  const originalMomentNow = moment.now;
  moment.now = () => REFERENCE_DATE.getTime();
  Appointment.findOne = async () => null;
  try {
    const adapter = realAdapter(schedulingBarber());
    const request = searchRequest({ requestedDate: "2026-10-17", proposalVersion: 2 });
    const result = await adapter.searchAvailableTimes(request);

    assert.equal(result.reason, "BUSINESS_CLOSED");
    assert.ok(result.alternatives.length > 0);
    assert.ok(result.alternatives.every((slot) => slot.date !== "2026-10-17"));
    assert.equal(result.alternatives[0].date, "2026-10-19");
  } finally {
    Appointment.findOne = originalFindOne;
    moment.now = originalMomentNow;
  }
});

test("real shared scheduling honors opening and closing boundaries", async () => {
  await withSchedulingDatabase([], async () => {
    const barber = schedulingBarber({ durationMinutes: 30, hours: { fri: open("09:00", "10:30") }, blackoutDates: [] });
    const result = await realAdapter(barber).searchAvailableTimes(searchRequest({ requestedDate: "2026-10-16" }));

    assert.deepEqual(result.alternatives.map(({ time }) => time), ["09:00", "09:30", "10:00"]);
    assert.equal(result.alternatives[0].time, "09:00", "opening time must be eligible");
    assert.equal(result.alternatives.at(-1).time, "10:00", "the final service must end exactly at closing");
  });
});

test("real shared scheduling rejects a service that would extend past closing", async () => {
  await withSchedulingDatabase([], async () => {
    const barber = schedulingBarber({ durationMinutes: 45, hours: { ...closedWeek(), fri: open("09:00", "10:00") }, blackoutDates: [] });
    const result = await realAdapter(barber).searchAvailableTimes(searchRequest({ requestedDate: "2026-10-16" }));

    assert.deepEqual(result.alternatives.map(({ time }) => time), ["09:00"]);
    assert.equal(result.metadata.durationMinutes, 45);
    assert.ok(!result.alternatives.some(({ time }) => time === "09:30"));
  });
});

test("real shared scheduling applies realistic overlap fixtures and configured buffers", async () => {
  const existing = [{ _id: "existing-appointment", startAt: new Date("2026-10-16T13:40:00Z"), endAt: new Date("2026-10-16T14:10:00Z") }];
  await withSchedulingDatabase(existing, async ({ queries }) => {
    const barber = schedulingBarber({ hours: { fri: open("09:00", "12:00") }, blackoutDates: [] });
    const result = await realAdapter(barber).searchAvailableTimes(searchRequest({ searchType: "LATER", requestedDate: "2026-10-16", afterTime: "09:00" }));

    assert.equal(result.alternatives[0].time, "10:30", "buffered overlap must exclude 9:30 and 10:00");
    assert.ok(queries.some((query) => moment(query.$or[0].startAt.$gte).tz(BUSINESS.timeZone).format("HH:mm") === "09:20"));
    assert.ok(queries.some((query) => moment(query.$or[0].startAt.$lt).tz(BUSINESS.timeZone).format("HH:mm") === "10:25"));
  });
});

test("real shared bounded search returns no availability when every opening in the seven-day horizon conflicts", async () => {
  const dates = ["16", "17", "18", "19", "20", "21", "22"].map((day) => ({
    _id: `occupied-${day}`,
    startAt: new Date(`2026-10-${day}T13:00:00Z`),
    endAt: new Date(`2026-10-${day}T13:30:00Z`),
  }));
  await withSchedulingDatabase(dates, async () => {
    const everyDay = Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((day) => [day, open("09:00", "09:30")]));
    const barber = schedulingBarber({ durationMinutes: 30, bufferMinutes: 0, hours: everyDay, blackoutDates: [] });
    const result = await realAdapter(barber).searchAvailableTimes(searchRequest({ requestedDate: "2026-10-16" }));

    assert.deepEqual(result.alternatives, []);
    assert.equal(result.reason, "UNAVAILABLE");
  });
});

for (const [language, transcript] of [["en", "What do you have Thursday?"], ["es", "¿Qué tienes disponible el jueves?"]]) {
  test(`${language} relative-date production interpretation reaches real shared scheduling`, async () => {
    await withSchedulingDatabase([], async () => {
      const calls = [];
      const availabilityAdapter = recordingAvailability(realAdapter(schedulingBarber()), calls);
      const f = fixture({ language, availabilityAdapter });
      await start(f);
      await caller(f, `real-relative-${language}`, transcript);
      await waitFor(() => calls.length === 1 && lastPurpose(f.openai) === ResponsePurpose.SCHEDULING_ALTERNATIVES, f.app);

      assert.equal(calls[0].service, "Haircut");
      assert.equal(calls[0].requestedDate, "2026-10-15");
      assert.equal("time" in calls[0], false);
      assert.equal(f.app.session.proposal.time, null);
      assert.equal(JSON.parse(lastCreate(f.openai).response.instructions).language, language);
      await f.app.terminate("TEST_DONE");
    });
  });
}

for (const [language, transcript] of [["en", "What do you have Thursday?"], ["es", "¿Qué tienes disponible el jueves?"]]) {
  test(`${language} date availability request executes the scheduling port and offers only verified results`, async () => {
    const alternatives = [{ date: "2026-10-16", time: "09:00", slotKey: deriveSlotKey({ service: "Haircut", date: "2026-10-16", time: "09:00" }) }];
    const f = fixture({ language, searchResults: [alternatives] });
    await start(f);
    await caller(f, `date-${language}`, transcript);
    await waitFor(() => f.searchCalls.length === 1, f.app);
    await waitFor(() => lastPurpose(f.openai), f.app);

    assert.equal(f.searchCalls[0].searchType, "DATE");
    assert.equal(f.searchCalls[0].service, "Haircut");
    assert.equal(f.searchCalls[0].requestedDate, "2026-10-15");
    assert.equal(f.searchCalls[0].afterTime, null);
    assert.equal("time" in f.searchCalls[0], false, "date-only search must not manufacture a time");
    assert.equal(f.searchCalls[0].proposalVersion, f.app.session.proposal.proposalVersion);
    assert.equal(f.app.session.proposal.time, null);
    assert.equal(f.searchCalls[0].timeZone, BUSINESS.timeZone);
    assert.equal(lastPurpose(f.openai), "SCHEDULING_ALTERNATIVES");
    const serialized = JSON.parse(lastCreate(f.openai).response.instructions);
    assert.deepEqual(serialized.expectedFacts.alternatives, alternatives.map(({ date, time }) => ({ date, time })));
    assert.equal(serialized.language, language);
    await f.app.terminate("TEST_DONE");
  });
}

test("an empty verified scheduling result produces explicit no-availability speech without inventing a time", async () => {
  const f = fixture({ searchResults: [[]] });
  await start(f);
  await caller(f, "none", "What do you have Thursday?");
  await waitFor(() => lastPurpose(f.openai));

  assert.equal(lastPurpose(f.openai), "NO_AVAILABLE_TIMES");
  const serialized = JSON.parse(lastCreate(f.openai).response.instructions);
  assert.deepEqual(serialized.expectedFacts.alternatives, []);
  assert.equal(serialized.expectedFacts.requestedDate, "2026-10-15");
  assert.equal(serialized.expectedFacts.availabilityReason, "UNAVAILABLE");
  assert.equal(serialized.speechContract.availabilityClaimsAllowed, true);
  await deliverLastResponse(f, "I couldn't find an available time for Thursday. Would you like another day?");
  assert.equal(f.app.lifecycle.terminated, false);
  assert.equal(f.app.session.watchdog.pendingCount, 1, "caller-silence ownership must bound the next turn");
  await f.app.terminate("TEST_DONE");
});

test("later options are proposal-bound and selecting one performs the required availability recheck", async () => {
  const alternatives = [{ date: "2026-10-16", time: "10:30", slotKey: deriveSlotKey({ service: "Haircut", date: "2026-10-16", time: "10:30" }) }];
  const f = fixture({ proposal: selectedSlotProposal(), searchResults: [alternatives], selectedAvailable: true });
  await start(f);
  await caller(f, "later", "What about a little later?");
  await waitFor(() => f.searchCalls.length === 1 && lastPurpose(f.openai));

  assert.equal(f.searchCalls[0].searchType, "LATER");
  assert.equal(f.searchCalls[0].afterTime, "10:00");
  assert.ok(f.searchCalls[0].proposalVersion > 1);
  assert.equal(f.app.session.proposal.time, null, "the superseded time cannot retain confirmation authority");
  assert.equal(lastPurpose(f.openai), "SCHEDULING_ALTERNATIVES");
  await deliverLastResponse(f, "I have 10:30 AM. Which works?");
  await caller(f, "select", "the first one");
  await waitFor(() => f.checkCalls.length === 1);

  assert.equal(f.checkCalls[0].date, "2026-10-16");
  assert.equal(f.checkCalls[0].time, "10:30");
  assert.equal(f.app.session.proposal.time, "10:30");
  assert.equal(f.app.session.proposal.availability.status, "available");
  await f.app.terminate("TEST_DONE");
});

test("selected time then delivered alternatives then another later request preserves context and asks which reference to use", async () => {
  const alternatives = [
    { date: "2026-10-16", time: "10:30", slotKey: deriveSlotKey({ service: "Haircut", date: "2026-10-16", time: "10:30" }) },
    { date: "2026-10-16", time: "11:00", slotKey: deriveSlotKey({ service: "Haircut", date: "2026-10-16", time: "11:00" }) },
  ];
  const afterEleven = [
    { date: "2026-10-16", time: "11:30", slotKey: deriveSlotKey({ service: "Haircut", date: "2026-10-16", time: "11:30" }) },
  ];
  const f = fixture({ proposal: selectedSlotProposal(), searchResults: [alternatives, afterEleven] });
  await start(f);
  await caller(f, "first-later", "What about a little later?");
  await waitFor(() => f.searchCalls.length === 1 && lastPurpose(f.openai) === ResponsePurpose.SCHEDULING_ALTERNATIVES);
  assert.deepEqual(f.app.session.proposal.availability.schedulingReference, {
    proposalVersion: f.app.session.proposal.proposalVersion,
    service: "Haircut",
    requestedDate: "2026-10-16",
    afterTime: "10:00",
    searchType: "LATER",
  });
  await deliverLastResponse(f, "I have 10:30 AM or 11:00 AM. Which works?");

  const version = f.app.session.proposal.proposalVersion;
  await caller(f, "second-later", "Anything later?");
  await waitFor(() => lastPurpose(f.openai) === ResponsePurpose.CLARIFY_LATER_REFERENCE, f.app);

  assert.equal(f.searchCalls.length, 1, "ambiguous offered choices must not select a reference silently");
  assert.equal(f.app.session.proposal.proposalVersion, version);
  assert.equal(f.app.session.proposal.time, null);
  assert.equal(f.app.session.proposal.confirmation.status, "none");
  const serialized = JSON.parse(lastCreate(f.openai).response.instructions);
  assert.deepEqual(serialized.expectedFacts.alternatives, alternatives.map(({ date, time }) => ({ date, time })));
  assert.equal(serialized.expectedFacts.afterTime, "10:00");
  await deliverLastResponse(f, "Which offered time should I search after, or what time should I use?");

  await caller(f, "explicit-later-reference", "later than 11");
  await waitFor(() => f.searchCalls.length === 2 && lastPurpose(f.openai) === ResponsePurpose.SCHEDULING_ALTERNATIVES, f.app);
  assert.equal(f.app.session.journal().filter((entry) => entry.event === "TURN_INTERPRETED").at(-1).action, "REQUEST_LATER_TIME");
  assert.equal(f.searchCalls[1].afterTime, "11:00");
  assert.equal(f.searchCalls[1].searchType, "LATER");
  assert.equal(f.app.session.proposal.time, null);
  assert.equal(f.app.session.proposal.confirmation.status, "none");
  assert.ok(f.app.session.proposal.availability.alternatives.every((slot) => `${slot.date}T${slot.time}` > "2026-10-16T11:00"));
  assert.equal(f.bookingCalls.length, 0);
  assert.equal(f.smsCalls.length, 0);
  await f.app.terminate("TEST_DONE");
});

test("ordinal answer to later-reference clarification searches after the referenced option instead of selecting it", async () => {
  const alternatives = [
    { date: "2026-10-16", time: "10:30", slotKey: deriveSlotKey({ service: "Haircut", date: "2026-10-16", time: "10:30" }) },
    { date: "2026-10-16", time: "11:00", slotKey: deriveSlotKey({ service: "Haircut", date: "2026-10-16", time: "11:00" }) },
  ];
  const afterSecond = [{ date: "2026-10-16", time: "11:30", slotKey: deriveSlotKey({ service: "Haircut", date: "2026-10-16", time: "11:30" }) }];
  const f = fixture({ proposal: selectedSlotProposal(), searchResults: [alternatives, afterSecond] });
  await start(f);
  await caller(f, "ordinal-first-later", "Anything later?");
  await waitFor(() => f.searchCalls.length === 1 && lastPurpose(f.openai) === ResponsePurpose.SCHEDULING_ALTERNATIVES, f.app);
  await deliverLastResponse(f, "I have 10:30 AM or 11:00 AM. Which works?");
  await caller(f, "ordinal-ambiguous-later", "Anything later?");
  await waitFor(() => lastPurpose(f.openai) === ResponsePurpose.CLARIFY_LATER_REFERENCE, f.app);
  await deliverLastResponse(f, "Which of those times should I search after?");

  await caller(f, "ordinal-reference", "the second one");
  await waitFor(() => f.searchCalls.length === 2 && lastPurpose(f.openai) === ResponsePurpose.SCHEDULING_ALTERNATIVES, f.app);

  const interpreted = f.app.session.journal().filter((entry) => entry.event === "TURN_INTERPRETED").at(-1);
  assert.equal(interpreted.action, "REQUEST_LATER_TIME");
  assert.equal(f.searchCalls[1].afterTime, "11:00");
  assert.equal(f.app.session.proposal.time, null, "ordinal reference cannot select the referenced slot for booking");
  assert.equal(f.app.session.proposal.confirmation.status, "none");
  assert.equal(f.checkCalls.length, 0, "reference answer must not perform selected-slot availability checking");
  assert.equal(f.bookingCalls.length, 0);
  assert.equal(f.smsCalls.length, 0);
  await f.app.terminate("TEST_DONE");
});

for (const [language, firstTurn, referenceTurn] of [
  ["en", "Anything later?", "later than 11"],
  ["es", "Algo mas tarde?", "despues de las once"],
]) {
  test(`${language} ambiguous later clarification establishes a real shared-helper search cursor`, async () => {
    await withSchedulingDatabase([], async () => {
      const calls = [];
      const barber = schedulingBarber({ durationMinutes: 30, hours: { fri: open("09:00", "12:00") }, blackoutDates: [] });
      const f = fixture({
        language,
        proposal: selectedSlotProposal({ time: "10:00", name: "Roberto" }),
        availabilityAdapter: recordingAvailability(realAdapter(barber), calls),
      });
      await start(f);
      await caller(f, `${language}-real-first-later`, firstTurn);
      await waitFor(() => calls.length === 1 && lastPurpose(f.openai) === ResponsePurpose.SCHEDULING_ALTERNATIVES, f.app);
      await deliverLastResponse(f, language === "es" ? "Tengo 10:30, 11:00 u 11:30. ¿Cuál prefieres?" : "I have 10:30, 11:00, or 11:30. Which works?");
      await caller(f, `${language}-real-ambiguous-later`, firstTurn);
      await waitFor(() => lastPurpose(f.openai) === ResponsePurpose.CLARIFY_LATER_REFERENCE, f.app);
      await deliverLastResponse(f, language === "es" ? "¿Después de cuál hora debo buscar?" : "Which time should I search after?");

      await caller(f, `${language}-real-reference`, referenceTurn);
      await waitFor(() => calls.length === 2 && lastPurpose(f.openai) === ResponsePurpose.SCHEDULING_ALTERNATIVES, f.app);

      assert.equal(f.app.session.journal().filter((entry) => entry.event === "TURN_INTERPRETED").at(-1).action, "REQUEST_LATER_TIME");
      assert.equal(calls[1].afterTime, "11:00");
      assert.equal(calls[1].searchType, "LATER");
      assert.equal(f.app.session.proposal.time, null);
      assert.equal(f.app.session.proposal.confirmation.status, "none");
      assert.ok(f.app.session.proposal.availability.alternatives.length > 0);
      assert.ok(f.app.session.proposal.availability.alternatives.every((slot) => `${slot.date}T${slot.time}` > "2026-10-16T11:00"));
      assert.equal(f.bookingCalls.length, 0);
      assert.equal(f.smsCalls.length, 0);
      assert.equal(f.app.session.journal().filter((entry) => entry.event === "CONFIRMATION_AUTHORITY_GRANTED").length, 0);

      if (language === "en") {
        await deliverLastResponse(f, "I have Friday at 11:30 AM. Which works?");
        await caller(f, "en-select-after-reference", "the first one");
        await waitFor(() => lastPurpose(f.openai) === ResponsePurpose.PRE_BOOKING_CONFIRMATION, f.app);
        assert.equal(f.app.session.proposal.time, "11:30");
        assert.equal(f.app.session.proposal.availability.status, "available");
        assert.equal(f.bookingCalls.length, 0);
        assert.equal(f.smsCalls.length, 0);
        await deliverLastResponse(f, "Roberto, should I confirm your Haircut for Friday at 11:30 AM?");
        assert.equal(f.app.session.journal().filter((entry) => entry.event === "CONFIRMATION_AUTHORITY_GRANTED").length, 1);
        assert.equal(f.bookingCalls.length, 0, "selection and delivered confirmation still require a fresh affirmative");
        assert.equal(f.smsCalls.length, 0);
      }
      await f.app.terminate("TEST_DONE");
    });
  });
}

test("repeated later requests use a unique offered same-day slot only as a search cursor, never booking authority", async () => {
  await withSchedulingDatabase([], async () => {
    const calls = [];
    const barber = schedulingBarber({
      durationMinutes: 30,
      hours: { ...closedWeek(), fri: open("09:00", "10:00") },
      blackoutDates: [{ date: new Date("2026-10-23T12:00:00Z") }],
    });
    const f = fixture({
      proposal: selectedSlotProposal({ time: "09:00" }),
      availabilityAdapter: recordingAvailability(realAdapter(barber), calls),
    });
    await start(f);
    await caller(f, "real-first-later", "Anything later?");
    await waitFor(() => calls.length === 1 && lastPurpose(f.openai) === ResponsePurpose.SCHEDULING_ALTERNATIVES, f.app);
    assert.deepEqual(f.app.session.proposal.availability.alternatives.map(({ time }) => time), ["09:30"]);
    await deliverLastResponse(f, "I have 9:30 AM. Would you like that time?");

    await caller(f, "real-second-later", "Anything later?");
    await waitFor(() => calls.length === 2 && lastPurpose(f.openai) === ResponsePurpose.NO_AVAILABLE_TIMES, f.app);

    assert.equal(calls[1].afterTime, "09:30");
    assert.equal(calls[1].requestedDate, "2026-10-16");
    assert.equal(f.app.session.proposal.time, null, "the unique option is a search cursor, not a selected booking time");
    assert.equal(f.app.session.proposal.confirmation.status, "none");
    assert.equal(f.bookingCalls.length, 0);
    assert.equal(f.smsCalls.length, 0);
    await f.app.terminate("TEST_DONE");
  });
});

test("a correction while scheduling lookup is pending makes the old result stale and only current options may be spoken", async () => {
  const first = deferred();
  const stale = [{ date: "2026-10-15", time: "09:00", slotKey: deriveSlotKey({ service: "Haircut", date: "2026-10-15", time: "09:00" }) }];
  const current = [{ date: "2026-10-16", time: "11:00", slotKey: deriveSlotKey({ service: "Haircut", date: "2026-10-16", time: "11:00" }) }];
  const f = fixture({ searchResults: [first.promise, current] });
  await start(f);
  f.openai.receive(transcriptEvent("old-date", "What do you have Thursday?"));
  await waitFor(() => f.searchCalls.length === 1);
  f.openai.receive(transcriptEvent("new-date", "What do you have Friday?"));
  await waitFor(() => f.app.session.proposal.date === "2026-10-16");
  assert.equal(f.app.session.proposal.date, "2026-10-16");

  first.resolve(stale);
  await waitFor(() => f.searchCalls.length === 2);
  await waitFor(() => lastPurpose(f.openai), f.app);
  assert.equal(f.app.session.proposal.availability.alternatives[0].time, "11:00");
  assert.equal(creates(f.openai, "SCHEDULING_ALTERNATIVES").length, 1);
  assert.ok(f.app.session.journal().some((entry) => entry.event === "SCHEDULING_RESULT_REJECTED" && entry.reason === "STALE_PROPOSAL_VERSION"));
  await f.app.terminate("TEST_DONE");
});

for (const mode of ["error", "timeout"]) {
  test(`scheduling lookup ${mode} is distinct from no availability and terminates through bounded recovery`, async () => {
    const scheduler = controlledScheduler();
    const searchCalls = [];
    const availabilityAdapter = {
      searchAvailableTimes: async (request) => {
        searchCalls.push(request);
        if (mode === "timeout") return new Promise(() => {});
        return { proposalVersion: request.proposalVersion, proposalSlotKey: request.proposalSlotKey, searchType: request.searchType, requestedDate: request.requestedDate, afterTime: request.afterTime, alternatives: [], reason: "PERSISTENCE_ERROR" };
      },
      checkAvailability: async () => ({ available: false, reason: "UNAVAILABLE" }),
      getAlternatives: async () => ({ alternatives: [], reason: null }),
    };
    const f = fixture({ availabilityAdapter, scheduler: scheduler.options });
    await start(f);
    f.openai.receive(transcriptEvent(`${mode}-lookup`, "What do you have Thursday?"));
    await waitFor(() => searchCalls.length === 1);
    if (mode === "timeout") await scheduler.fire(15000);
    await waitFor(() => lastPurpose(f.openai) === ResponsePurpose.ERROR_RECOVERY);

    assert.equal(f.app.session.proposal.terminal, false, "lookup failure cannot become booking failure");
    assert.equal(creates(f.openai, "NO_AVAILABLE_TIMES").length, 0);
    const serialized = JSON.parse(lastCreate(f.openai).response.instructions);
    assert.equal(serialized.speechContract.terminalRecovery, true);
    await deliverLastResponse(f, "I'm sorry, I can't continue this call. Please call again later. Goodbye.");
    assert.equal(f.app.lifecycle.terminated, true);
    assert.equal(f.twilio.closeCalls.length, 1);
    assert.equal(f.finalized.length, 1);
  });
}

test("production-composed closed day converges through verified selection, fresh confirmation, booking, and cleanup", async () => {
  const originalFindOne = Appointment.findOne;
  const originalMomentNow = moment.now;
  moment.now = () => REFERENCE_DATE.getTime();
  Appointment.findOne = async () => null;
  try {
    const barber = schedulingBarber();
    const appointments = [];
    const bookingAdapter = new SharedBookingAdapter({ dependencies: inMemoryBookingDependencies(barber, appointments) });
    const f = fixture({ proposal: namedServiceProposal(), availabilityAdapter: realAdapter(barber), bookingAdapter });
    await start(f);
    await caller(f, "closed-day", "What do you have Thursday?");
    await waitFor(() => lastPurpose(f.openai) === "SCHEDULING_ALTERNATIVES");

    const offered = JSON.parse(lastCreate(f.openai).response.instructions);
    assert.equal(offered.expectedFacts.requestedDate, "2026-10-15");
    assert.equal(offered.expectedFacts.availabilityReason, "BUSINESS_CLOSED");
    assert.ok(offered.expectedFacts.alternatives.length > 0);
    assert.equal(offered.expectedFacts.alternatives[0].date, "2026-10-16");
    await deliverLastResponse(f, "Thursday is closed. I have Friday at 9:00 AM. Which works?");

    await caller(f, "select-verified", "the first one");
    await waitFor(() => lastPurpose(f.openai) === ResponsePurpose.PRE_BOOKING_CONFIRMATION);
    assert.equal(f.app.session.proposal.date, "2026-10-16");
    assert.equal(f.app.session.proposal.time, "09:00");
    assert.equal(f.app.session.proposal.availability.status, "available", "selection must be rechecked before confirmation");

    await deliverLastResponse(f, "Roberto, should I confirm your Haircut for Friday at 9:00 AM?");
    assert.equal(f.app.session.journal().filter((entry) => entry.event === "CONFIRMATION_AUTHORITY_GRANTED").length, 1);
    assert.equal(appointments.length, 0, "delivered confirmation alone cannot book");
    assert.equal(f.smsCalls.length, 0, "delivered confirmation alone cannot send SMS");
    f.openai.receive(transcriptEvent("fresh-yes", "yes"));
    await waitFor(() => appointments.length === 1 && f.smsCalls.length === 1 && lastPurpose(f.openai) === ResponsePurpose.BOOKING_SUCCESS);
    assert.equal(f.app.session.proposal.terminal.outcome, "BOOKED");

    const stored = appointments[0];
    assert.equal(stored.barberId, BUSINESS.barberId);
    assert.equal(stored.service, "Haircut");
    assert.equal(stored.clientName, "Roberto");
    assert.equal(stored.clientPhone, "+18135550100");
    assert.equal(moment(stored.startAt).tz(BUSINESS.timeZone).format("YYYY-MM-DD HH:mm"), "2026-10-16 09:00");
    assert.equal((stored.endAt.getTime() - stored.startAt.getTime()) / 60000, 45);

    await deliverLastResponse(f, "Your Haircut appointment is booked for Friday at 9:00 AM. Goodbye.");
    assert.equal(f.app.lifecycle.terminated, true);
    assert.equal(appointments.length, 1);
    assert.equal(f.smsCalls.length, 1);
    assert.equal(f.finalized.length, 1);
    assert.equal(f.twilio.closeCalls.length, 1);
    assert.deepEqual(f.hangupCalls, [{ callSid: "CA-scheduling-en" }]);
    assert.equal(f.app.session.watchdog.pendingCount, 0);
  } finally {
    Appointment.findOne = originalFindOne;
    moment.now = originalMomentNow;
  }
});

test("CA712 natural path selects a spoken offered time, collects a bare name, and completes exactly once", async () => {
  const originalFindOne = Appointment.findOne;
  const originalMomentNow = moment.now;
  moment.now = () => REFERENCE_DATE.getTime();
  Appointment.findOne = async () => null;
  try {
    const barber = ca712Barber();
    const appointments = [];
    const availabilityCalls = [];
    const sharedAvailability = realAdapter(barber);
    const availabilityAdapter = {
      checkAvailability: (request) => { availabilityCalls.push(request); return sharedAvailability.checkAvailability(request); },
      getAlternatives: (request) => sharedAvailability.getAlternatives(request),
      searchAvailableTimes: (request) => sharedAvailability.searchAvailableTimes(request),
    };
    const bookingAdapter = new SharedBookingAdapter({ dependencies: inMemoryBookingDependencies(barber, appointments) });
    const f = fixture({
      callSid: "CA712fb437d8fc2839b540dd206a4ef626",
      proposal: createBookingProposal({ proposalId: "ca712-natural" }),
      availabilityAdapter,
      bookingAdapter,
    });
    const assertNoSideEffects = (checkpoint) => {
      assert.equal(appointments.length, 0, `${checkpoint}: appointment count`);
      assert.equal(f.smsCalls.length, 0, `${checkpoint}: SMS count`);
    };

    await start(f);
    assertNoSideEffects("greeting");

    await caller(f, "ca712-request", "I'd like a haircut this Friday.");
    assert.equal(lastPurpose(f.openai), ResponsePurpose.ASK_TIME);
    await deliverLastResponse(f, "What time would you like on Friday?");
    assertNoSideEffects("time requested");

    await caller(f, "ca712-time", "9 a.m.");
    await waitFor(() => lastPurpose(f.openai) === ResponsePurpose.OFFER_ALTERNATIVES, f.app);
    const offered = JSON.parse(lastCreate(f.openai).response.instructions).expectedFacts.alternatives;
    assert.deepEqual(offered, [
      { date: "2026-10-17", time: "10:00" },
      { date: "2026-10-17", time: "10:30" },
      { date: "2026-10-17", time: "11:00" },
    ]);
    await deliverLastResponse(f, "Friday is closed. Saturday has 10:00, 10:30, or 11:00 AM. Which works?");
    assertNoSideEffects("alternatives delivered");
    const offeredProposalVersion = f.app.session.proposal.proposalVersion;
    assert.equal(f.app.session.proposal.availability.proposalVersion, offeredProposalVersion);
    assert.equal(f.app.session.proposal.availability.slotKey, deriveSlotKey(f.app.session.proposal));

    await caller(f, "ca712-spoken-selection", "Ten o'clock a.m.");
    await waitFor(() => lastPurpose(f.openai) === ResponsePurpose.ASK_NAME, f.app);
    assert.equal(f.app.session.proposal.date, "2026-10-17");
    assert.equal(f.app.session.proposal.time, "10:00");
    assert.equal(f.app.session.proposal.proposalVersion, offeredProposalVersion + 1);
    assert.equal(f.app.session.proposal.availability.proposalVersion, f.app.session.proposal.proposalVersion);
    assert.equal(f.app.session.proposal.availability.slotKey, deriveSlotKey({ service: "Haircut", date: "2026-10-17", time: "10:00" }));
    assert.equal(f.app.session.proposal.availability.status, "available");
    assert.deepEqual(availabilityCalls.map(({ date, time }) => ({ date, time })), [
      { date: "2026-10-16", time: "09:00" },
      { date: "2026-10-17", time: "10:00" },
    ]);
    assert.equal(availabilityCalls[1].slotKey, f.app.session.proposal.availability.slotKey);
    await deliverLastResponse(f, "What name should I use for the appointment?");
    assertNoSideEffects("name requested");

    f.openai.receive({ type: "input_audio_buffer.speech_started", event_id: "ca712-name-speech" });
    await settle(f.app);
    await caller(f, "ca712-name", "Navije");
    assert.equal(f.app.session.proposal.name, "Navije");
    assert.equal(lastPurpose(f.openai), ResponsePurpose.PRE_BOOKING_CONFIRMATION);
    assertNoSideEffects("name collected");

    await deliverLastResponse(f, "Navije, should I confirm your Haircut for Saturday at 10:00 AM?");
    assert.equal(f.app.session.journal().filter(({ event }) => event === "CONFIRMATION_AUTHORITY_GRANTED").length, 1);
    assertNoSideEffects("confirmation acknowledged");

    await caller(f, "ca712-fresh-yes", "yes");
    await waitFor(() => appointments.length === 1 && f.smsCalls.length === 1 && lastPurpose(f.openai) === ResponsePurpose.BOOKING_SUCCESS, f.app);
    assert.equal(f.app.session.proposal.terminal.outcome, "BOOKED");
    const stored = appointments[0];
    assert.equal(stored.barberId, BUSINESS.barberId);
    assert.equal(stored.service, "Haircut");
    assert.equal(stored.clientName, "Navije");
    assert.equal(moment(stored.startAt).tz(BUSINESS.timeZone).format("YYYY-MM-DD HH:mm"), "2026-10-17 10:00");
    assert.equal((stored.endAt.getTime() - stored.startAt.getTime()) / 60000, 30);

    await deliverLastResponse(f, "Your Haircut appointment is booked for Saturday at 10:00 AM. Goodbye.");
    assert.equal(f.app.lifecycle.terminated, true);
    assert.equal(appointments.length, 1);
    assert.equal(f.smsCalls.length, 1);
    assert.equal(f.finalized.length, 1);
    assert.equal(f.twilio.closeCalls.length, 1);
    assert.deepEqual(f.hangupCalls, [{ callSid: "CA712fb437d8fc2839b540dd206a4ef626" }]);
    assert.equal(f.app.session.watchdog.pendingCount, 0);

    const traceEvents = new Set(["TURN_INTERPRETED", "EFFECT_QUEUED", "AVAILABILITY_RESULT_APPLIED", "RESPONSE_PLANNED", "PLAYBACK_ACKNOWLEDGED", "CONFIRMATION_AUTHORITY_GRANTED", "BOOKING_SUCCEEDED", "SMS_RESULT", "TRANSCRIPT_FINALIZED", "SESSION_TERMINATING"]);
    const trace = f.app.session.journal().filter(({ event }) => traceEvents.has(event)).map(({ event, callSid: _callSid, buildSha: _buildSha, sequence, ...details }) => ({ sequence, event, details }));
    console.log("[CA712_NATURAL_ACCEPTANCE_TRACE]", JSON.stringify(trace));
  } finally {
    Appointment.findOne = originalFindOne;
    moment.now = originalMomentNow;
  }
});

test("Spanish production path selects the offered slot by spoken time and carries its date into ASK_NAME", async () => {
  await withSchedulingDatabase([], async () => {
    const barber = ca712Barber();
    const f = fixture({
      callSid: "CA-ca712-spanish",
      language: "es",
      proposal: createBookingProposal({ proposalId: "ca712-spanish" }),
      availabilityAdapter: realAdapter(barber),
    });
    await start(f);
    await caller(f, "es-request", "Quiero un Haircut este viernes.");
    assert.equal(lastPurpose(f.openai), ResponsePurpose.ASK_TIME);
    await deliverLastResponse(f, "¿A qué hora lo prefieres el viernes?");
    await caller(f, "es-time", "A las nueve de la mañana.");
    await waitFor(() => lastPurpose(f.openai) === ResponsePurpose.OFFER_ALTERNATIVES, f.app);
    await deliverLastResponse(f, "El viernes está cerrado. El sábado hay a las diez, diez y media u once. ¿Cuál prefieres?");
    await caller(f, "es-select", "A las diez de la mañana.");
    await waitFor(() => lastPurpose(f.openai) === ResponsePurpose.ASK_NAME, f.app);

    assert.equal(f.app.session.proposal.date, "2026-10-17");
    assert.equal(f.app.session.proposal.time, "10:00");
    assert.equal(f.app.session.proposal.name, null);
    assert.equal(f.app.session.proposal.availability.status, "available");
    assert.equal(f.bookingCalls.length, 0);
    assert.equal(f.smsCalls.length, 0);
    await f.app.terminate("TEST_DONE");
  });
});

test("ambiguous same-time offered slots clarify without changing proposal or restoring authority", async () => {
  const facts = { service: "Haircut", date: "2026-10-16", time: "09:00" };
  const alternatives = [
    { date: "2026-10-17", time: "10:00", slotKey: deriveSlotKey({ service: "Haircut", date: "2026-10-17", time: "10:00" }) },
    { date: "2026-10-18", time: "10:00", slotKey: deriveSlotKey({ service: "Haircut", date: "2026-10-18", time: "10:00" }) },
  ];
  const proposal = createBookingProposal({ proposalId: "ambiguous-time", ...facts, availability: { proposalVersion: 1, slotKey: deriveSlotKey(facts), status: "unavailable", alternatives } });
  const f = fixture({ proposal });
  await start(f);
  const before = f.app.session.proposal;
  await caller(f, "ambiguous-ten", "10 AM");
  await waitFor(() => lastPurpose(f.openai) === ResponsePurpose.CLARIFICATION, f.app);
  assert.equal(f.app.session.proposal, before);
  assert.equal(f.checkCalls.length, 0);
  assert.equal(f.bookingCalls.length, 0);
  assert.equal(f.smsCalls.length, 0);
  assert.equal(f.app.session.confirmationAuthority.verifyGrant({ proposalVersion: proposal.proposalVersion, responseId: "none", markId: "none", responseRegistry: f.app.session.responseRegistry, playbackRegistry: f.app.session.playbackRegistry }).reason, "NO_CURRENT_CONFIRMATION");
  await f.app.terminate("TEST_DONE");
});

function realAdapter(barber) {
  return new V1AvailabilityAdapter({ findBarberByIdFn: async () => barber });
}

function schedulingBarber({ durationMinutes = 45, bufferMinutes = 10, hours = {}, blackoutDates = [{ date: new Date("2026-10-17T12:00:00Z") }] } = {}) {
  const closed = { isClosed: true, open: "09:00", close: "12:00" };
  return {
    _id: BUSINESS.barberId,
    services: [{ name: "Haircut", durationMinutes }],
    availability: {
      timezone: BUSINESS.timeZone,
      defaultServiceDurationMinutes: 30,
      bufferMinutes,
      blackoutDates,
      businessHours: {
        sun: closed, mon: open("09:00", "12:00"), tue: closed, wed: closed,
        thu: closed, fri: open("09:00", "12:00"), sat: open("09:00", "12:00"),
        ...hours,
      },
    },
  };
}

function ca712Barber() {
  return schedulingBarber({
    durationMinutes: 30,
    bufferMinutes: 0,
    blackoutDates: [],
    hours: {
      ...closedWeek(),
      sat: open("10:00", "11:30"),
    },
  });
}

function open(openTime, closeTime) { return { isClosed: false, open: openTime, close: closeTime }; }
function closedWeek() { return Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((day) => [day, { isClosed: true, open: "09:00", close: "12:00" }])); }

function searchRequest(changes = {}) {
  const request = {
    commandId: "search-1",
    barberId: BUSINESS.barberId,
    service: "Haircut",
    requestedDate: "2026-10-15",
    afterTime: null,
    timeZone: BUSINESS.timeZone,
    proposalVersion: 2,
    searchType: "DATE",
    limit: 3,
    ...changes,
  };
  return { ...request, proposalSlotKey: changes.proposalSlotKey ?? deriveSlotKey({ service: request.service, date: request.requestedDate, time: null }) };
}

function fixture({ callSid = null, proposal = serviceProposal(), language = "en", searchResults = [[]], selectedAvailable = false, availabilityAdapter: suppliedAvailability = null, bookingAdapter: suppliedBooking = null, scheduler = undefined, emit = () => {} } = {}) {
  const twilio = new FakeSocket();
  const openai = new FakeSocket();
  openai.readyState = 0;
  const searchCalls = [];
  const checkCalls = [];
  const bookingCalls = [];
  const smsCalls = [];
  const finalized = [];
  const hangupCalls = [];
  let searchIndex = 0;
  const fakeAvailability = {
    searchAvailableTimes: async (request) => {
      searchCalls.push(request);
      const pending = searchResults[Math.min(searchIndex++, searchResults.length - 1)];
      const alternatives = await Promise.resolve(pending);
      return { proposalVersion: request.proposalVersion, proposalSlotKey: request.proposalSlotKey, searchType: request.searchType, requestedDate: request.requestedDate, afterTime: request.afterTime, alternatives, reason: alternatives.length ? null : "UNAVAILABLE" };
    },
    checkAvailability: async (request) => { checkCalls.push(request); return { proposalVersion: request.proposalVersion, slotKey: request.slotKey, available: selectedAvailable, alternatives: [], reason: selectedAvailable ? null : "UNAVAILABLE" }; },
    getAlternatives: async (request) => ({ slotKey: request.slotKey, alternatives: [], reason: null }),
  };
  const availabilityAdapter = suppliedAvailability || fakeAvailability;
  const app = initializeVoiceV2Session({
    callSid: callSid || `CA-scheduling-${language}`, callerNumber: "+18135550100", businessContext: BUSINESS, buildSha: "scheduling-review",
    twilioSocket: twilio, openaiSocketFactory: () => openai, proposal, availabilityAdapter,
    scheduler,
    bookingAdapter: suppliedBooking || { createAppointment: async (command) => { bookingCalls.push(command); return { success: true, appointmentId: "appt" }; } },
    smsAdapter: { sendAppointmentConfirmation: async (command) => { smsCalls.push(command); return { success: true, submitted: true }; } },
    transcriptAdapter: { appendTurn: async () => ({ success: true }), finalizeCall: async (request) => { finalized.push(request); return { success: true }; } },
    callControlAdapter: { terminateCall: async ({ callSid: terminatedCallSid }) => { hangupCalls.push({ callSid: terminatedCallSid }); return { success: true, submitted: true }; } },
    now: () => REFERENCE_DATE,
    turnContext: { language, availableServices: ["Haircut"] },
    emit,
  });
  openai.open();
  return { app, twilio, openai, searchCalls, checkCalls, bookingCalls, smsCalls, finalized, hangupCalls };
}

function serviceProposal() { return createBookingProposal({ proposalId: "scheduling", service: "Haircut" }); }
function namedServiceProposal() { return createBookingProposal({ proposalId: "closed-to-booked", service: "Haircut", name: "Roberto" }); }
function selectedSlotProposal({ time = "10:00", name = null } = {}) {
  const facts = { service: "Haircut", date: "2026-10-16", time };
  return createBookingProposal({ proposalId: "later", ...facts, name, availability: { proposalVersion: 1, slotKey: deriveSlotKey(facts), status: "available", alternatives: [] } });
}

function recordingAvailability(adapter, calls) {
  return {
    checkAvailability: (request) => adapter.checkAvailability(request),
    getAlternatives: (request) => adapter.getAlternatives(request),
    searchAvailableTimes: (request) => { calls.push(request); return adapter.searchAvailableTimes(request); },
  };
}

async function withSchedulingDatabase(appointments, operation) {
  const originalFindOne = Appointment.findOne;
  const originalMomentNow = moment.now;
  const queries = [];
  moment.now = () => REFERENCE_DATE.getTime();
  Appointment.findOne = async (query) => {
    queries.push(query);
    return appointments.find((appointment) => queryMatchesAppointment(query, appointment)) || null;
  };
  try { return await operation({ queries }); }
  finally { Appointment.findOne = originalFindOne; moment.now = originalMomentNow; }
}

function queryMatchesAppointment(query, appointment) {
  if (query?.barberId && String(query.barberId) !== BUSINESS.barberId) return false;
  const start = appointment.startAt.getTime();
  const end = appointment.endAt.getTime();
  return (query.$or || []).some((clause) => {
    const startRange = clause.startAt;
    const endRange = clause.endAt;
    return (!startRange || rangeMatches(start, startRange)) && (!endRange || rangeMatches(end, endRange));
  });
}

function rangeMatches(value, range) {
  return (range.$lt === undefined || value < new Date(range.$lt).getTime())
    && (range.$lte === undefined || value <= new Date(range.$lte).getTime())
    && (range.$gt === undefined || value > new Date(range.$gt).getTime())
    && (range.$gte === undefined || value >= new Date(range.$gte).getTime());
}

function inMemoryBookingDependencies(barber, appointments) {
  return {
    findBarberById: async (barberId) => barberId === BUSINESS.barberId ? barber : null,
    findByIdempotencyKey: async (barberId, key) => appointments.find((appointment) => appointment.barberId === barberId && appointment.bookingCommand.idempotencyKey === key) || null,
    createAppointment: async (values) => {
      const appointment = { _id: `appointment-${appointments.length + 1}`, ...values };
      appointments.push(appointment);
      return appointment;
    },
  };
}

async function start(f) {
  f.twilio.receive({ event: "start", start: { callSid: f.app.session.callSid, streamSid: "MZ-scheduling" } });
  f.openai.receive({ type: "session.created" });
  await settle(f.app);
  f.openai.receive({ type: "session.updated" });
  await settle(f.app);
  await deliverLastResponse(f, "Hello");
  f.app.session.watchdog.cancel("caller-silence");
  f.openai.sent.length = 0;
  f.twilio.sent.length = 0;
}

async function caller(f, id, transcript) {
  f.openai.receive(transcriptEvent(id, transcript));
  await settle(f.app);
}

function transcriptEvent(id, transcript) { return { type: "conversation.item.input_audio_transcription.completed", event_id: `event-${id}`, item_id: id, transcript }; }

async function deliverLastResponse(f, transcript) {
  const create = lastCreate(f.openai);
  if (!create) return;
  const requestId = create.response.metadata.v2RequestId;
  const responseId = `response-${requestId}`;
  f.openai.receive({ type: "response.created", response: { id: responseId, metadata: { v2RequestId: requestId } } });
  f.openai.receive({ type: "response.output_audio.delta", response_id: responseId, delta: "AQID" });
  f.openai.receive({ type: "response.output_audio_transcript.done", response_id: responseId, transcript });
  f.openai.receive({ type: "response.done", response: { id: responseId, status: "completed" } });
  await settle(f.app);
  const mark = f.twilio.sent.filter((item) => item.event === "mark").at(-1);
  if (mark) {
    f.twilio.receive({ event: "mark", streamSid: "MZ-scheduling", mark: { name: mark.mark.name } });
    await settle(f.app);
  }
}

function lastCreate(openai) { return openai.sent.filter((entry) => entry.type === "response.create").at(-1); }
function creates(openai, purpose) { return openai.sent.filter((entry) => entry.type === "response.create" && entry.response.metadata.purpose === purpose); }
function lastPurpose(openai) { return lastCreate(openai)?.response?.metadata?.purpose || null; }
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function controlledScheduler() {
  const tasks = [];
  const options = {
    schedule: (callback, delay) => { const task = { callback, delay, cancelled: false, fired: false }; tasks.push(task); return task; },
    cancel: (task) => { task.cancelled = true; },
  };
  const active = (delay) => tasks.filter((task) => !task.cancelled && !task.fired && task.delay === delay);
  return { options, fire: async (delay) => { const task = active(delay)[0]; assert.ok(task, `active ${delay}ms task required`); task.fired = true; await task.callback(); } };
}
async function settle(app) { for (let index = 0; index < 8; index += 1) { await Promise.resolve(); await app.ready(); } }
async function waitFor(predicate, app = null) { for (let index = 0; index < 100; index += 1) { if (predicate()) return; await new Promise((resolve) => setImmediate(resolve)); } throw new Error(`condition_not_reached${app ? `:${JSON.stringify(app.session.journal().slice(-8))}` : ""}`); }
