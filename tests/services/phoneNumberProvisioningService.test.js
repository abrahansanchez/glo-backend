import test from "node:test";
import assert from "node:assert/strict";
import PhoneNumberAssignment from "../../models/PhoneNumberAssignment.js";
import {
  createTwilioProvisioningProvider,
  INBOUND_ROUTING_ROLE,
  mirrorAssignedBarber,
  provisionDedicatedInboundRoutingNumber,
} from "../../services/phoneNumberProvisioningService.js";

const BASE_URL = "https://glo.example.test";
const NOW = new Date("2026-09-29T12:00:00Z");

test("assignment model exposes durable role and unique routing identity indexes", () => {
  const indexes = PhoneNumberAssignment.schema.indexes();
  assert.ok(indexes.some(([keys, options]) => keys.barberId === 1 && keys.role === 1 && options.unique === true));
  for (const field of ["numberKey", "candidateNumber", "phoneNumber", "providerSid"]) {
    const index = indexes.find(([keys]) => keys[field] === 1);
    assert.ok(index, `${field} index missing`);
    assert.equal(index[1].unique, true);
    assert.deepEqual(index[1].partialFilterExpression, { [field]: { $type: "string", $gt: "" } });
  }
});

test("first successful request creates one provisioning assignment, purchases once, and mirrors Barber", async () => {
  const state = setup();
  const result = await provision(state, "barber-1");
  assert.equal(result.status, "assigned");
  assert.equal(state.assignments.records.length, 1);
  assert.equal(state.assignments.records[0].status, "assigned");
  assert.equal(state.assignments.records[0].numberKey, "+15555550100");
  assert.equal(state.assignments.records[0].phoneNumber, "+15555550100");
  assert.equal(state.assignments.records[0].providerSid, "PN100");
  assert.equal(state.provider.searches, 1);
  assert.deepEqual(state.provider.searchRequests, [{ limit: 3, fallback: false }]);
  assert.equal(state.provider.purchases.length, 1);
  assert.equal(state.barbers.records.get("barber-1").inboundRoutingNumber, "+15555550100");
  assert.equal(state.barbers.records.get("barber-1").inboundRoutingSid, "PN100");
});

test("Twilio inventory provider searches preferred area first and fallback without areaCode", async () => {
  const requests = [];
  const client = {
    availablePhoneNumbers(country) {
      return {
        local: {
          async list(params) {
            requests.push({ country, params });
            return [{ phoneNumber: "+15555550100" }];
          },
        },
      };
    },
    incomingPhoneNumbers: {
      async list() { return []; },
      async create() { throw new Error("not used"); },
    },
  };
  const provider = createTwilioProvisioningProvider({
    env: { TWILIO_DEFAULT_COUNTRY: "US", TWILIO_DEFAULT_AREA_CODE: "813" },
    client,
  });

  await provider.searchAvailableNumbers({ limit: 3 });
  await provider.searchAvailableNumbers({ limit: 3, fallback: true });

  assert.deepEqual(requests, [
    { country: "US", params: { areaCode: "813", limit: 3, voiceEnabled: true } },
    { country: "US", params: { limit: 3, voiceEnabled: true } },
  ]);
});

test("empty preferred inventory invokes country-wide fallback and purchases the fallback candidate", async () => {
  const state = setup({
    preferredAvailable: [],
    fallbackAvailable: ["+15555550200"],
    sidByNumber: { "+15555550200": "PN200" },
  });
  const result = await provision(state, "barber-1");

  assert.equal(result.status, "assigned");
  assert.equal(state.assignments.records[0].numberKey, "+15555550200");
  assert.deepEqual(state.provider.searchRequests, [
    { limit: 3, fallback: false },
    { limit: 3, fallback: true },
  ]);
  assert.deepEqual(state.provider.purchases.map((entry) => entry.phoneNumber), ["+15555550200"]);
});

test("preferred candidates all colliding invokes fallback and reserves exactly one fallback winner", async () => {
  const state = setup({
    assignments: [{ _id: "other", barberId: "barber-2", role: INBOUND_ROUTING_ROLE, status: "assigned", numberKey: "+15555550100", phoneNumber: "+15555550100", providerSid: "PN100" }],
    preferredAvailable: ["+15555550100"],
    fallbackAvailable: ["+15555550200"],
    sidByNumber: { "+15555550200": "PN200" },
  });
  const result = await provision(state, "barber-1");

  assert.equal(result.status, "assigned");
  assert.equal(state.assignments.records.find((entry) => entry.barberId === "barber-1").numberKey, "+15555550200");
  assert.deepEqual(state.provider.purchases.map((entry) => entry.phoneNumber), ["+15555550200"]);
});

test("empty preferred and fallback inventory returns retryable NO_AVAILABLE_NUMBER", async () => {
  const state = setup({ preferredAvailable: [], fallbackAvailable: [] });

  await assert.rejects(provision(state, "barber-1"), (error) => {
    assert.equal(error.code, "NO_AVAILABLE_NUMBER");
    assert.equal(error.preferredInventoryFailureReason, "PREFERRED_INVENTORY_EMPTY");
    assert.equal(error.inventoryFailureReason, "FALLBACK_INVENTORY_EMPTY");
    return true;
  });
  assert.equal(state.assignments.records[0].status, "failed");
  assert.equal(state.assignments.records[0].failureClass, "retryable");
  assert.equal(state.assignments.records[0].lastErrorCode, "NO_AVAILABLE_NUMBER");
  assert.equal(state.provider.purchases.length, 0);
});

test("unusable preferred and fallback candidates return retryable failure without purchase", async () => {
  const state = setup({
    assignments: [
      { _id: "other-1", barberId: "barber-2", role: INBOUND_ROUTING_ROLE, status: "assigned", numberKey: "+15555550100", phoneNumber: "+15555550100", providerSid: "PN100" },
      { _id: "other-2", barberId: "barber-3", role: INBOUND_ROUTING_ROLE, status: "assigned", numberKey: "+15555550200", phoneNumber: "+15555550200", providerSid: "PN200" },
    ],
    preferredAvailable: ["+15555550100", "not-a-number"],
    fallbackAvailable: ["+15555550200"],
  });

  await assert.rejects(provision(state, "barber-1"), (error) => {
    assert.equal(error.code, "NO_AVAILABLE_NUMBER");
    assert.equal(error.preferredInventoryFailureReason, "PREFERRED_CANDIDATES_UNUSABLE");
    assert.equal(error.inventoryFailureReason, "FALLBACK_CANDIDATES_UNUSABLE");
    return true;
  });
  assert.equal(state.assignments.records.find((entry) => entry.barberId === "barber-1").failureClass, "retryable");
  assert.equal(state.provider.purchases.length, 0);
});

test("search remains bounded across preferred and fallback stages", async () => {
  const state = setup({
    preferredAvailable: ["bad", "+15555550100", "+15555550101"],
    fallbackAvailable: ["+15555550200", "+15555550201"],
    candidateRetryLimit: 2,
    assignments: [
      { _id: "other-1", barberId: "barber-2", role: INBOUND_ROUTING_ROLE, status: "assigned", numberKey: "+15555550100", phoneNumber: "+15555550100", providerSid: "PN100" },
      { _id: "other-2", barberId: "barber-3", role: INBOUND_ROUTING_ROLE, status: "assigned", numberKey: "+15555550200", phoneNumber: "+15555550200", providerSid: "PN200" },
    ],
    sidByNumber: { "+15555550201": "PN201" },
  });
  const result = await provision(state, "barber-1");

  assert.equal(result.status, "assigned");
  assert.equal(state.assignments.records.find((entry) => entry.barberId === "barber-1").numberKey, "+15555550201");
  assert.deepEqual(state.provider.searchRequests, [
    { limit: 2, fallback: false },
    { limit: 2, fallback: true },
  ]);
});

test("assigned retry returns same number and repairs Barber without provider calls", async () => {
  const state = setup({
    assignments: [{ _id: "assignment-1", barberId: "barber-1", role: INBOUND_ROUTING_ROLE, status: "assigned", numberKey: "+15555550100", phoneNumber: "+15555550100", providerSid: "PN100" }],
    barber: { inboundRoutingNumber: null, inboundRoutingSid: null },
  });
  const result = await provision(state, "barber-1");
  assert.equal(result.status, "assigned");
  assert.equal(result.repairedBarber, true);
  assert.equal(state.provider.searches, 0);
  assert.equal(state.provider.purchases.length, 0);
  assert.equal(state.barbers.records.get("barber-1").inboundRoutingNumber, "+15555550100");
});

test("simultaneous requests cause at most one inventory search and purchase", async () => {
  const state = setup({ providerDelayMs: 15 });
  const [first, second] = await Promise.all([
    provision(state, "barber-1"),
    provision(state, "barber-1"),
  ]);
  assert.equal(state.provider.searches, 1);
  assert.equal(state.provider.purchases.length, 1);
  assert.equal(state.assignments.records.length, 1);
  assert.deepEqual([first.status, second.status].sort(), ["assigned", "provisioning"]);
});

test("active pending attempt prevents duplicate provider calls", async () => {
  const state = setup({
    assignments: [{
      _id: "assignment-1",
      barberId: "barber-1",
      role: INBOUND_ROUTING_ROLE,
      status: "provisioning",
      attemptId: "active",
      attemptExpiresAt: new Date("2026-09-29T12:10:00Z"),
    }],
  });
  const result = await provision(state, "barber-1");
  assert.equal(result.status, "provisioning");
  assert.equal(state.provider.searches, 0);
  assert.equal(state.provider.purchases.length, 0);
});

test("expired attempt can be reclaimed", async () => {
  const state = setup({
    assignments: [{
      _id: "assignment-1",
      barberId: "barber-1",
      role: INBOUND_ROUTING_ROLE,
      status: "provisioning",
      attemptId: "expired",
      attemptExpiresAt: new Date("2026-09-29T11:59:00Z"),
    }],
  });
  const result = await provision(state, "barber-1");
  assert.equal(result.status, "assigned");
  assert.equal(state.provider.searches, 1);
  assert.equal(state.provider.purchases.length, 1);
});

test("candidate collision uses bounded retry behavior", async () => {
  const state = setup({
    assignments: [{ _id: "other", barberId: "barber-2", role: INBOUND_ROUTING_ROLE, status: "provisioning", numberKey: "+15555550100", candidateNumber: "+15555550100" }],
    available: ["+15555550100", "+15555550101"],
    sidByNumber: { "+15555550101": "PN101" },
  });
  const result = await provision(state, "barber-1");
  assert.equal(result.status, "assigned");
  assert.equal(result.assignment.numberKey, "+15555550101");
  assert.equal(result.assignment.phoneNumber, "+15555550101");
  assert.deepEqual(state.provider.purchases.map((p) => p.phoneNumber), ["+15555550101"]);
});

test("provider rejection stores sanitized failure state without raw provider payload", async () => {
  const state = setup({ purchaseError: Object.assign(new Error("provider said +15555550100 raw payload"), { code: "twilio 500 +15555550100" }) });
  await assert.rejects(provision(state, "barber-1"), /TWILIO_500_PHONE/);
  const assignment = state.assignments.records[0];
  assert.equal(assignment.status, "failed");
  assert.equal(assignment.lastErrorCode, "TWILIO_500_PHONE");
  assert.equal(assignment.failureClass, "retryable");
  assert.ok(assignment.retryAfter instanceof Date);
  assert.equal("rawPayload" in assignment, false);
});

test("ambiguous purchase outcome reconciles owned matching candidate and does not buy again on retry", async () => {
  const state = setup({
    purchaseError: Object.assign(new Error("lost response"), { code: "UNKNOWN_PURCHASE_OUTCOME" }),
    ownedAfterPurchaseFailure: true,
  });
  const result = await provision(state, "barber-1");
  assert.equal(result.status, "assigned");
  assert.equal(result.reconciled, true);
  assert.equal(state.provider.purchases.length, 1);
  assert.equal(state.assignments.records[0].numberKey, "+15555550100");
  state.provider.purchaseError = null;
  const retry = await provision(state, "barber-1");
  assert.equal(retry.status, "assigned");
  assert.equal(state.provider.purchases.length, 1);
});

test("assignment success plus Barber mirror failure is repaired on retry without purchase", async () => {
  const state = setup({ failNextSave: true });
  await assert.rejects(provision(state, "barber-1"), /BARBER_MIRROR_WRITE_FAILED/);
  assert.equal(state.assignments.records[0].status, "assigned");
  assert.equal(state.provider.purchases.length, 1);
  const retry = await provision(state, "barber-1");
  assert.equal(retry.status, "assigned");
  assert.equal(retry.repairedBarber, true);
  assert.equal(state.provider.purchases.length, 1);
  assert.equal(state.barbers.records.get("barber-1").inboundRoutingNumber, "+15555550100");
});

test("existing assigned Barber fields are never overwritten by a different assignment", async () => {
  const state = setup({
    assignments: [{ _id: "assignment-1", barberId: "barber-1", role: INBOUND_ROUTING_ROLE, status: "assigned", numberKey: "+15555550100", phoneNumber: "+15555550100", providerSid: "PN100" }],
    barber: { inboundRoutingNumber: "+15555550999", inboundRoutingSid: "PN999" },
  });
  await assert.rejects(provision(state, "barber-1"), /BARBER_ROUTING_NUMBER_CONFLICT/);
  assert.equal(state.barbers.records.get("barber-1").inboundRoutingNumber, "+15555550999");
  assert.equal(state.provider.purchases.length, 0);
});

test("cross-field and cross-Barber number collisions fail closed", async () => {
  const state = setup({
    assignments: [{ _id: "other", barberId: "barber-2", role: INBOUND_ROUTING_ROLE, status: "assigned", numberKey: "+15555550100", phoneNumber: "+15555550100", providerSid: "PN200" }],
  });
  await assert.rejects(provision(state, "barber-1"), /NO_AVAILABLE_NUMBER|DUPLICATE/);
  assert.equal(state.provider.purchases.length, 0);
});

test("two assignments racing for the same candidate produce one numberKey owner and loser retries", async () => {
  const state = setup({
    available: ["+15555550100", "+15555550101"],
    sidByNumber: { "+15555550100": "PN100", "+15555550101": "PN101" },
    barbers: ["barber-1", "barber-2"],
  });
  const [first, second] = await Promise.all([
    provision(state, "barber-1"),
    provision(state, "barber-2"),
  ]);
  assert.deepEqual([first.status, second.status], ["assigned", "assigned"]);
  assert.equal(new Set(state.assignments.records.map((entry) => entry.numberKey)).size, 2);
  assert.deepEqual(state.provider.purchases.map((entry) => entry.phoneNumber).sort(), ["+15555550100", "+15555550101"]);
});

test("candidate numberKey conflicts with assigned numberKey on another assignment", async () => {
  const state = setup({
    assignments: [{ _id: "other", barberId: "barber-2", role: INBOUND_ROUTING_ROLE, status: "provisioning", numberKey: "+15555550100", candidateNumber: "+15555550100" }],
    available: ["+15555550100"],
  });
  await assert.rejects(provision(state, "barber-1"), /NO_AVAILABLE_NUMBER/);
  assert.equal(state.provider.purchases.length, 0);
});

test("assigned numberKey conflicts with candidate claim on another assignment", async () => {
  const state = setup({
    assignments: [{ _id: "other", barberId: "barber-2", role: INBOUND_ROUTING_ROLE, status: "assigned", numberKey: "+15555550100", phoneNumber: "+15555550100", providerSid: "PN200" }],
    available: ["+15555550100"],
  });
  await assert.rejects(provision(state, "barber-1"), /NO_AVAILABLE_NUMBER/);
  assert.equal(state.provider.purchases.length, 0);
});

test("assigned and retained records do not change numberKey or regress", async () => {
  const assigned = setup({
    assignments: [{ _id: "assignment-1", barberId: "barber-1", role: INBOUND_ROUTING_ROLE, status: "assigned", numberKey: "+15555550100", phoneNumber: "+15555550100", providerSid: "PN100" }],
    available: ["+15555550101"],
  });
  await provision(assigned, "barber-1");
  assert.equal(assigned.assignments.records[0].numberKey, "+15555550100");
  assert.equal(assigned.provider.purchases.length, 0);

  const retained = setup({
    assignments: [{ _id: "assignment-1", barberId: "barber-1", role: INBOUND_ROUTING_ROLE, status: "retained", numberKey: "+15555550100", phoneNumber: "+15555550100", providerSid: "PN100" }],
    available: ["+15555550101"],
  });
  const result = await provision(retained, "barber-1");
  assert.equal(result.status, "retained");
  assert.equal(retained.assignments.records[0].numberKey, "+15555550100");
  assert.equal(retained.provider.purchases.length, 0);
});

test("terminal failure persists class and is not automatically repurchased", async () => {
  const state = setup({
    ownedNumbers: new Map([["+15555550100", { phoneNumber: "+15555550100", sid: "PN999", friendlyName: "other-assignment" }]]),
  });
  await assert.rejects(provision(state, "barber-1"), /PROVIDER_NUMBER_OWNED_BY_OTHER_ASSIGNMENT/);
  assert.equal(state.assignments.records[0].failureClass, "terminal");
  assert.equal(state.assignments.records[0].retryAfter, null);
  await assert.doesNotReject(async () => {
    const retry = await provision(state, "barber-1");
    assert.equal(retry.status, "failed");
  });
  assert.equal(state.provider.purchases.length, 0);
});

test("successful retry clears failure metadata", async () => {
  const state = setup({
    assignments: [{
      _id: "assignment-1",
      barberId: "barber-1",
      role: INBOUND_ROUTING_ROLE,
      status: "failed",
      failureClass: "retryable",
      lastErrorCode: "NO_AVAILABLE_NUMBER",
      retryAfter: new Date("2026-09-29T12:00:00Z"),
    }],
  });
  const result = await provision(state, "barber-1");
  assert.equal(result.status, "assigned");
  assert.equal(state.assignments.records[0].failureClass, null);
  assert.equal(state.assignments.records[0].retryAfter, null);
  assert.equal(state.assignments.records[0].lastErrorCode, null);
});

test("owned candidate belonging to another assignment fails closed", async () => {
  const state = setup({
    ownedNumbers: new Map([["+15555550100", { phoneNumber: "+15555550100", sid: "PN999", friendlyName: "other-assignment" }]]),
  });
  await assert.rejects(provision(state, "barber-1"), /PROVIDER_NUMBER_OWNED_BY_OTHER_ASSIGNMENT/);
  assert.equal(state.provider.purchases.length, 0);
});

test("full phone numbers and provider payloads are not logged", async () => {
  const state = setup();
  await provision(state, "barber-1");
  assert.deepEqual(state.logs, []);
});

test("mirrorAssignedBarber rejects incomplete assignments", async () => {
  const state = setup();
  await assert.rejects(mirrorAssignedBarber({ barberId: "barber-1", phoneNumber: "", providerSid: "" }, { BarberModel: state.barbers }), /ASSIGNMENT_NOT_ASSIGNED/);
});

function setup({
  assignments = [],
  barber = {},
  barbers = ["barber-1"],
  available = ["+15555550100"],
  preferredAvailable = null,
  fallbackAvailable = [],
  sidByNumber = { "+15555550100": "PN100" },
  purchaseError = null,
  ownedAfterPurchaseFailure = false,
  providerDelayMs = 0,
  failNextSave = false,
  ownedNumbers = new Map(),
  candidateRetryLimit = 3,
} = {}) {
  const logs = [];
  const assignModel = createAssignmentModel(assignments);
  const barberSeed = Object.fromEntries(barbers.map((id) => [id, { _id: id, ...barber }]));
  const barberModel = createBarberModel(barberSeed, { failNextSave });
  const provider = createProvider({
    preferredAvailable: preferredAvailable || available,
    fallbackAvailable,
    sidByNumber,
    purchaseError,
    ownedAfterPurchaseFailure,
    providerDelayMs,
    ownedNumbers,
  });
  return { assignments: assignModel, barbers: barberModel, provider, logs, candidateRetryLimit };
}

function provision(state, barberId) {
  return provisionDedicatedInboundRoutingNumber(barberId, {
    AssignmentModel: state.assignments,
    BarberModel: state.barbers,
    provider: state.provider,
    baseUrl: BASE_URL,
    now: () => NOW,
    candidateRetryLimit: state.candidateRetryLimit,
    createAttemptId: () => `attempt-${state.assignments.attempts++}`,
  });
}

function createProvider({ preferredAvailable, fallbackAvailable, sidByNumber, purchaseError, ownedAfterPurchaseFailure, providerDelayMs, ownedNumbers }) {
  return {
    searches: 0,
    searchRequests: [],
    purchases: [],
    purchaseError,
    async searchAvailableNumbers({ limit, fallback = false }) {
      this.searches += 1;
      this.searchRequests.push({ limit, fallback });
      const available = fallback ? fallbackAvailable : preferredAvailable;
      return available.map((phoneNumber) => ({ phoneNumber }));
    },
    async findOwnedNumber({ phoneNumber }) {
      return ownedNumbers.get(phoneNumber) || null;
    },
    async purchaseNumber(payload) {
      if (providerDelayMs) await new Promise((resolve) => setTimeout(resolve, providerDelayMs));
      this.purchases.push(payload);
      if (this.purchaseError) {
        if (ownedAfterPurchaseFailure) {
          ownedNumbers.set(payload.phoneNumber, {
            phoneNumber: payload.phoneNumber,
            sid: sidByNumber[payload.phoneNumber],
            friendlyName: payload.friendlyName,
            voiceUrl: payload.voiceUrl,
            smsUrl: payload.smsUrl,
          });
        }
        throw this.purchaseError;
      }
      ownedNumbers.set(payload.phoneNumber, {
        phoneNumber: payload.phoneNumber,
        sid: sidByNumber[payload.phoneNumber],
        friendlyName: payload.friendlyName,
        voiceUrl: payload.voiceUrl,
        smsUrl: payload.smsUrl,
      });
      return { phoneNumber: payload.phoneNumber, sid: sidByNumber[payload.phoneNumber], friendlyName: payload.friendlyName };
    },
  };
}

function createBarberModel(seed, { failNextSave = false } = {}) {
  const records = new Map();
  let failSave = failNextSave;
  for (const [id, value] of Object.entries(seed)) records.set(id, clone(value));
  return {
    records,
    async findById(id) {
      const found = records.get(String(id));
      if (!found) return null;
      const doc = barberDoc(clone(found));
      doc.save = async () => {
        if (failSave) {
          failSave = false;
          throw Object.assign(new Error("BARBER_MIRROR_WRITE_FAILED"), { code: "BARBER_MIRROR_WRITE_FAILED" });
        }
        records.set(String(id), stripBarberDoc(doc));
        return doc;
      };
      return doc;
    },
  };
}

function barberDoc(value) {
  return {
    inboundRoutingNumber: null,
    inboundRoutingSid: null,
    ...value,
    async save() {
      return this;
    },
  };
}

function createAssignmentModel(seed) {
  const model = {
    records: seed.map((value, index) => ({ _id: value._id || `assignment-${index + 1}`, ...clone(value) })),
    next: seed.length + 1,
    attempts: 1,
    async findOne(query) {
      return this.records.find((record) => matches(record, query)) || null;
    },
    async create(value) {
      const record = { _id: `assignment-${this.next++}`, ...clone(value) };
      enforceUniques(this.records, record);
      this.records.push(record);
      return record;
    },
    async findOneAndUpdate(query, update) {
      const record = this.records.find((entry) => matches(entry, query));
      if (!record) return null;
      const next = clone(record);
      applyUpdate(next, update);
      enforceUniques(this.records.filter((entry) => entry !== record), next);
      Object.assign(record, next);
      return record;
    },
  };
  return model;
}

function matches(record, query) {
  for (const [key, value] of Object.entries(query)) {
    if (key === "$or") {
      if (!value.some((term) => matches(record, term))) return false;
      continue;
    }
    if (typeof value === "object" && value !== null && "$lte" in value) {
      if (!(new Date(record[key]).getTime() <= new Date(value.$lte).getTime())) return false;
      continue;
    }
    if (record[key] !== value) return false;
  }
  return true;
}

function applyUpdate(record, update) {
  for (const [key, value] of Object.entries(update.$set || {})) record[key] = value;
  for (const key of Object.keys(update.$unset || {})) delete record[key];
}

function enforceUniques(existing, record) {
  if (existing.some((entry) => entry.barberId === record.barberId && entry.role === record.role)) throw duplicate();
  for (const field of ["numberKey", "candidateNumber", "phoneNumber", "providerSid"]) {
    if (record[field] && existing.some((entry) => entry[field] === record[field])) throw duplicate(field, record[field]);
  }
}

function duplicate(field = "unknown", value = "duplicate") {
  return Object.assign(new Error("duplicate key"), {
    code: 11000,
    keyPattern: { [field]: 1 },
    keyValue: { [field]: value },
  });
}

function clone(value) {
  return structuredClone(value);
}

function stripBarberDoc(value) {
  const plain = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "function") plain[key] = entry;
  }
  return plain;
}
