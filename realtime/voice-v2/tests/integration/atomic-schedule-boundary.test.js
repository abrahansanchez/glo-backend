import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCandidateConflictQuery,
  buildFenceId,
  calculateFenceIdsForInterval,
  createAppointmentAtomically,
  localDatesTouched,
} from "../../../../services/booking/atomicScheduleMutation.js";

const barberId = "507f1f77bcf86cd799439011";

test("fence id uses barber and local date only, with timezone as metadata outside the key", () => {
  assert.equal(
    buildFenceId({ barberId, localDate: "2026-09-19" }),
    "barber:507f1f77bcf86cd799439011:date:2026-09-19"
  );
});

test("end-exclusive local date classification handles midnight and buffered midnight", () => {
  assert.deepEqual(localDatesTouched({
    startAt: new Date("2026-09-20T03:30:00.000Z"),
    endAt: new Date("2026-09-20T04:00:00.000Z"),
    timeZone: "America/New_York",
  }), ["2026-09-19"]);

  assert.deepEqual(calculateFenceIdsForInterval({
    barberId,
    startAt: new Date("2026-09-20T03:30:00.000Z"),
    endAt: new Date("2026-09-20T04:00:00.000Z"),
    timeZone: "America/New_York",
    bufferMinutes: 10,
  }), [
    "barber:507f1f77bcf86cd799439011:date:2026-09-19",
    "barber:507f1f77bcf86cd799439011:date:2026-09-20",
  ]);

  assert.deepEqual(localDatesTouched({
    startAt: new Date("2026-09-20T03:30:00.000Z"),
    endAt: new Date("2026-09-20T04:30:00.000Z"),
    timeZone: "America/New_York",
  }), ["2026-09-19", "2026-09-20"]);
});

test("authoritative conflict query preserves candidate-only buffer semantics", () => {
  const query = buildCandidateConflictQuery({
    barberId,
    startAt: new Date("2026-09-19T14:00:00.000Z"),
    endAt: new Date("2026-09-19T14:30:00.000Z"),
    bufferMinutes: 10,
  });
  assert.deepEqual(query.status, { $in: ["confirmed", "pending"] });
  assert.equal(query.$or[0].startAt.$gte.toISOString(), "2026-09-19T13:50:00.000Z");
  assert.equal(query.$or[0].startAt.$lt.toISOString(), "2026-09-19T14:40:00.000Z");
});

test("atomic create attaches the same session to fence, idempotency, conflict and create calls", async () => {
  const calls = [];
  const session = fakeSession(calls);
  const appointmentValues = {
    barberId,
    clientName: "Test",
    clientPhone: "+18135550100",
    service: "Haircut",
    startAt: new Date("2026-09-19T14:00:00.000Z"),
    endAt: new Date("2026-09-19T14:30:00.000Z"),
    date: new Date("2026-09-19T14:00:00.000Z"),
    time: "10:00 AM",
    status: "confirmed",
    source: "ai",
    bookingCommand: { idempotencyKey: "key-1", requestHash: "hash-1" },
  };
  const AppointmentModel = fakeAppointmentModel(calls);
  const BarberModel = fakeBarberModel(calls);
  const ScheduleFenceModel = fakeFenceModel(calls);

  const result = await createAppointmentAtomically(appointmentValues, {
    startSession: async () => session,
    AppointmentModel,
    BarberModel,
    ScheduleFenceModel,
    idempotencyKey: "key-1",
    requestHash: "hash-1",
  });

  assert.equal(result.appointment._id, "appt-1");
  assert.deepEqual(calls.map((call) => call.type), [
    "startTransaction",
    "barber.session",
    "fence.updateOne",
    "findOne.session",
    "findOne.session",
    "create",
    "commitTransaction",
    "endSession",
  ]);
  assert.ok(calls.every((call) => !("session" in call) || call.session === session));
});

function fakeSession(calls) {
  return {
    active: false,
    startTransaction(options) { this.active = true; calls.push({ type: "startTransaction", options }); },
    async commitTransaction() { this.active = false; calls.push({ type: "commitTransaction" }); },
    async abortTransaction() { this.active = false; calls.push({ type: "abortTransaction" }); },
    async endSession() { calls.push({ type: "endSession" }); },
    inTransaction() { return this.active; },
  };
}

function fakeQuery(value, calls, type) {
  return {
    session(session) { calls.push({ type: `${type}.session`, session }); return this; },
    lean() { return Promise.resolve(value); },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
}

function fakeBarberModel(calls) {
  return {
    findById() {
      return {
        select() { return this; },
        session(session) { calls.push({ type: "barber.session", session }); return this; },
        lean() {
          return Promise.resolve({
            _id: barberId,
            services: [{ name: "Haircut", durationMinutes: 30 }],
            availability: { timezone: "America/New_York", bufferMinutes: 0 },
          });
        },
      };
    },
  };
}

function fakeAppointmentModel(calls) {
  return {
    findOne(query) {
      return fakeQuery(null, calls, "findOne");
    },
    async create(values, options) {
      calls.push({ type: "create", session: options.session, values });
      return [{ _id: "appt-1", ...values[0] }];
    },
  };
}

function fakeFenceModel(calls) {
  return {
    collection: {
      async updateOne(filter, update, options) {
        calls.push({ type: "fence.updateOne", filter, update, session: options.session });
        return { acknowledged: true };
      },
    },
  };
}
