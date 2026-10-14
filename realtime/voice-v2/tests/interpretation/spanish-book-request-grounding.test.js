import test from "node:test";
import assert from "node:assert/strict";
import { interpretTurn } from "../../interpretation/TurnInterpreter.js";
import { normalizeTurn } from "../../interpretation/TurnNormalizer.js";
import { extractTime } from "../../interpretation/extractors/TimeExtractor.js";
import { buildServiceCatalogue } from "../../interpretation/buildServiceCatalogue.js";
import { createBookingProposal } from "../../domain/BookingProposal.js";

const productionServices = () => buildServiceCatalogue([{ name: "Haircut" }]);
const interpret = (transcript, availableServices = productionServices()) => interpretTurn({
  transcript, sourceTurnId: "frozen-spanish", referenceDate: "2026-10-14",
  businessTimeZone: "America/New_York", availableServices,
  currentProposal: createBookingProposal({ proposalId: "frozen-spanish" }),
});

test("full frozen Spanish booking request grounds Haircut, next Monday and 14:00", async () => {
  const result = await interpret("Quiero hacer una cita para cortarme el pelo el lunes a las dos de la tarde.");
  assert.equal(result.interpretation.action, "BOOK_REQUEST");
  assert.equal(result.interpretation.service, "Haircut");
  assert.equal(result.interpretation.date, "2026-10-19");
  assert.equal(result.interpretation.time, "14:00");
  assert.equal(result.interpretation.name, undefined);
  assert.equal(result.interpretationSource, "deterministic");
});

for (const [phrase, expected] of [["una cita", null], ["a la una de la tarde", "13:00"], ["a las dos de la tarde", "14:00"]]) {
  test(phrase + " extracts " + expected + " through real time and interpreter paths", async () => {
    assert.equal(extractTime(normalizeTurn(phrase)), expected);
    assert.equal((await interpret(phrase)).interpretation.time ?? null, expected);
  });
}

test("a la una preserves afternoon evidence from current time", () => {
  assert.equal(extractTime(normalizeTurn("a la una"), { currentTime: "14:00" }), "13:00");
});

test("corte de pelo still grounds the offered Haircut", async () => {
  assert.equal((await interpret("corte de pelo")).interpretation.service, "Haircut");
});

test("cortarme el pelo requires the exact alias in the supplied catalogue", async () => {
  const original = [{ canonical: "Haircut", aliases: ["hair cut", "corte", "corte de pelo"] }];
  assert.equal((await interpret("cortarme el pelo", original)).interpretation.service, undefined);
  assert.equal((await interpret("cortarme el pelo", [{ canonical: "Haircut", aliases: ["cortarme el pelo"] }])).interpretation.service, "Haircut");
  assert.equal((await interpret("cortarme el pelo")).interpretation.service, "Haircut");
});

test("different catalogue without the alias gains no Haircut authorization", async () => {
  assert.equal((await interpret("cortarme el pelo", buildServiceCatalogue([{ name: "Beard Trim" }]))).interpretation.service, undefined);
  assert.equal((await interpret("cortarme el pelo", [{ canonical: "Other", aliases: ["corte de pelo"] }])).interpretation.service, undefined);
});

test("deterministic interpretation invokes no availability, booking or SMS operations", async () => {
  const calls = []; const forbidden = (name) => { calls.push(name); throw new Error("unexpected effect"); };
  const result = await interpretTurn({ transcript: "Quiero hacer una cita para cortarme el pelo el lunes a las dos de la tarde.",
    sourceTurnId: "no-effects", referenceDate: "2026-10-14", businessTimeZone: "America/New_York",
    availableServices: productionServices(), currentProposal: createBookingProposal({ proposalId: "no-effects" }),
    availabilityAdapter: { checkAvailability: () => forbidden("availability") },
    bookingAdapter: { createAppointment: () => forbidden("booking") },
    smsAdapter: { sendAppointmentConfirmation: () => forbidden("sms") },
  });
  assert.equal(result.interpretation.action, "BOOK_REQUEST"); assert.deepEqual(calls, []);
});

for (const phrase of ["a la una, cita de pelo", "a la una cita de pelo"]) test(phrase + " preserves explicit one-o-clock through real interpreter", async () => {
  assert.equal(extractTime(normalizeTurn(phrase)), "01:00");
  assert.equal((await interpret(phrase)).interpretation.time, "01:00");
});
