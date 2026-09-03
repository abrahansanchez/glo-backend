import test from "node:test";
import assert from "node:assert/strict";
import { CallSession } from "../../CallSession.js";
import { createBookingProposal } from "../../domain/BookingProposal.js";
import { reduceBooking } from "../../domain/BookingReducer.js";
import { prepareVoiceV2SessionStart } from "../../application/prepareVoiceV2SessionStart.js";
import { INBOUND_NUMBER_FIELDS, findBarberByInboundNumber, resolveBusinessByCalledNumber } from "../../../../services/business/resolveBusinessByCalledNumber.js";
import Barber from "../../../../models/Barber.js";

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

test("production resolver converts a hydrated Mongoose result to plain data before deep freezing", async () => {
  const hydrated = new Barber({
    name: "Probando",
    email: "probando@glo.com",
    phone: "+18135550123",
    password: "not-returned",
    twilioNumber: "+12602523232",
    availability: { timezone: "America/New_York" },
    services: [{ name: "Haircut", durationMinutes: 30 }],
  });
  const bsonBytes = hydrated.services[0]._id.id;
  assert.ok(ArrayBuffer.isView(bsonBytes));
  assert.throws(() => Object.freeze(bsonBytes), TypeError);

  let leanCalls = 0;
  let leanOptions;
  const resolved = await resolveBusinessByCalledNumber("+12602523232", {
    findOneFn: () => ({
      sort: () => ({
        lean: (options) => {
          leanCalls += 1;
          leanOptions = options;
          return hydrated.toObject(options);
        },
      }),
    }),
  });

  assert.equal(leanCalls, 1);
  assert.deepEqual(leanOptions, { flattenObjectIds: true });
  assert.equal(resolved.businessId, String(hydrated._id));
  assert.equal(resolved.barberId, String(hydrated._id));
  assert.equal(resolved.calledNumber, "+12602523232");
  assert.equal(resolved.timeZone, "America/New_York");
  assert.deepEqual(resolved.services.map(({ name }) => name), ["Haircut"]);
  assert.equal(Object.isFrozen(resolved), true);
  assert.equal(Object.isFrozen(resolved.services), true);
  assert.equal(Object.isFrozen(resolved.services[0]), true);
});

test("resolver preserves descending update/create ordering for ambiguous numbers", async () => {
  const candidates = [
    { _id: "older", updatedAt: new Date("2026-04-08T21:27:59Z"), createdAt: new Date("2026-03-31T16:25:49Z"), services: [] },
    { _id: "probando", updatedAt: new Date("2026-08-25T15:34:13Z"), createdAt: new Date("2026-04-08T20:19:13Z"), services: [] },
  ];
  let receivedSort;
  const resolved = await resolveBusinessByCalledNumber("+18132952433", {
    findOneFn: () => ({
      sort: (sort) => {
        receivedSort = sort;
        return {
          lean: () => [...candidates].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0],
        };
      },
    }),
  });

  assert.deepEqual(receivedSort, { updatedAt: -1, createdAt: -1 });
  assert.equal(resolved.businessId, "probando");
});

test("resolved business context remains deeply immutable", async () => {
  const resolved = await resolveBusinessByCalledNumber("+12602523232", {
    findOneFn: () => ({
      sort: () => ({
        lean: () => ({
          _id: "69d6b84155368d54a594b55a",
          availability: { timezone: "America/New_York" },
          services: [{ name: "Haircut", durationMinutes: 30 }],
        }),
      }),
    }),
  });
  const expected = structuredClone(resolved);

  for (const mutate of [
    () => { resolved.businessId = "other"; },
    () => { resolved.barberId = "other"; },
    () => { resolved.calledNumber = "+10000000000"; },
    () => { resolved.timeZone = "UTC"; },
    () => { resolved.services.push({ name: "Other" }); },
    () => { resolved.services[0].name = "Other"; },
  ]) assert.throws(mutate, TypeError);

  assert.deepEqual(resolved, expected);
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
