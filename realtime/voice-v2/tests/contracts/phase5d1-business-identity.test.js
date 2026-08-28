import test from "node:test";
import assert from "node:assert/strict";
import { CallSession } from "../../CallSession.js";
import { createBookingProposal } from "../../domain/BookingProposal.js";
import { reduceBooking } from "../../domain/BookingReducer.js";
import { prepareVoiceV2SessionStart } from "../../application/prepareVoiceV2SessionStart.js";
import { INBOUND_NUMBER_FIELDS, findBarberByInboundNumber, resolveBusinessByCalledNumber } from "../../../../services/business/resolveBusinessByCalledNumber.js";

const context = (id = "barber-1") => ({ businessId: id, barberId: id, timeZone: "America/New_York", services: [{ name: "Haircut" }], calledNumber: "+18135550100" });
const proposal = (id = "p") => createBookingProposal({ proposalId: id });

test("shared lookup preserves the exact V1 model query, sort, no-input, and no-match behavior", async () => {
  let filter; let sort; const document = { _id: "barber-1" };
  const found = await findBarberByInboundNumber("+18135550100", { findOneFn: (value) => { filter = value; return { sort: (value2) => { sort = value2; return document; } }; } });
  assert.equal(found, document); assert.deepEqual(filter, { $or: [{ twilioNumber: "+18135550100" }, { assignedTwilioNumber: "+18135550100" }, { twilioPhoneNumber: "+18135550100" }] }); assert.deepEqual(sort, { updatedAt: -1, createdAt: -1 });
  assert.equal(await findBarberByInboundNumber("", { findOneFn: () => { throw new Error("must not query"); } }), null);
  assert.equal(await findBarberByInboundNumber("+1", { findOneFn: () => ({ sort: () => null }) }), null);
  await assert.rejects(findBarberByInboundNumber("+1", { findOneFn: () => { throw new Error("database failed"); } }), /database failed/);
  await assert.rejects(findBarberByInboundNumber("+1", { findOneFn: () => ({ sort: () => { throw new Error("sort failed"); } }) }), /sort failed/);
});

test("all currently accepted Twilio number fields resolve through the one shared query", async () => {
  assert.deepEqual(INBOUND_NUMBER_FIELDS, ["twilioNumber", "assignedTwilioNumber", "twilioPhoneNumber"]);
  for (const field of INBOUND_NUMBER_FIELDS) {
    const barber = { _id: `${field}-id`, [field]: "+18135550100", availability: { timezone: "America/Chicago" }, services: [{ name: "Haircut" }] };
    const resolved = await resolveBusinessByCalledNumber("  +18135550100  ", { findOneFn: (filter) => ({ sort: () => filter.$or.some((term) => term[field] === barber[field]) ? barber : null }) });
    assert.equal(resolved.businessId, `${field}-id`); assert.equal(resolved.calledNumber, "+18135550100"); assert.equal(Object.isFrozen(resolved.services[0]), true);
  }
});

test("CallSession businessContext is copied, deeply frozen, non-reassignable, and proposal-independent", () => {
  const source = context(); const call = new CallSession({ callSid: "CA", buildSha: "sha", proposal: proposal(), businessContext: source }); source.services[0].name = "Changed outside";
  assert.equal(call.businessContext.services[0].name, "Haircut"); assert.equal(Object.isFrozen(call.businessContext.services), true);
  assert.throws(() => { call.businessContext.businessId = "other"; }, TypeError); assert.throws(() => { call.businessContext = context("other"); }, TypeError);
  const before = call.businessContext; call.replaceProposal(call.proposal, createBookingProposal({ proposalId: "p", proposalVersion: 2 })); assert.equal(call.businessContext, before);
  assert.equal("businessId" in call.proposal, false); assert.equal("barberId" in call.proposal, false);
});

test("caller-derived proposal changes and simultaneous calls cannot alter or share business identity", () => {
  const a = new CallSession({ callSid: "A", buildSha: "sha", proposal: proposal("a"), businessContext: context("business-a") }); const b = new CallSession({ callSid: "B", buildSha: "sha", proposal: proposal("b"), businessContext: context("business-b") });
  const callerClaim = reduceBooking(a.proposal, { action: "SET_SERVICE", confidence: "explicit", sourceTurnId: "caller-claim", service: "Other Shop Haircut" }).nextProposal; a.replaceProposal(a.proposal, callerClaim);
  assert.equal(a.businessContext.businessId, "business-a"); assert.equal(b.businessContext.businessId, "business-b"); assert.notEqual(a.businessContext, b.businessContext);
});

test("unresolved or failed business identity prevents all partial session construction", async () => {
  for (const resolver of [async () => null, async () => { throw new Error("lookup failed"); }]) {
    let constructions = 0; const events = [];
    const result = await prepareVoiceV2SessionStart({ calledNumber: "+18135550999", resolveBusinessByCalledNumber: resolver, createResolvedSession: async () => { constructions += 1; return {}; }, emit: (event) => events.push(event) });
    assert.equal(result.started, false); assert.equal(result.session, null); assert.equal(constructions, 0); assert.match(events[0].event, /^BUSINESS_IDENTITY_(UNRESOLVED|RESOLUTION_FAILED)$/);
  }
});

test("resolved business context is the sole input to session construction", async () => {
  const trusted = context(); let received;
  const result = await prepareVoiceV2SessionStart({ calledNumber: trusted.calledNumber, resolveBusinessByCalledNumber: async () => trusted, createResolvedSession: async (values) => { received = values; return { id: "session" }; } });
  assert.equal(result.started, true); assert.equal(received.businessContext, trusted); assert.equal(result.session.id, "session");
});
