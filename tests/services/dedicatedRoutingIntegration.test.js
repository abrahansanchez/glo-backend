import test from "node:test";
import assert from "node:assert/strict";
import Barber from "../../models/Barber.js";
import PhoneNumberAssignment from "../../models/PhoneNumberAssignment.js";
import { findBarberByInboundNumber } from "../../services/business/resolveBusinessByCalledNumber.js";
import {
  assignForwardingRoutingNumberWithOptions,
  assignStrategy,
  beginForwardingVerificationCall,
  getStrategyStatus,
  maybeVerifyForwardingCall,
  startForwardingTest,
  verifyForwardingDigits,
} from "../../services/phoneStrategyService.js";

const BASE_URL = "https://glo.example.test";
const NOW = new Date("2026-09-29T12:00:00Z");
const VALID_TEST_SECRET = "test-forwarding-secret-32-bytes-minimum";

test("forward_existing provisions one dedicated routing number and preserves customer number separately", async (t) => {
  const state = setup();
  mockBarber(t, state);
  const barber = await assignStrategy("barber-1", "forward_existing", {
    forwardFromNumber: "+15555550001",
    forwardingCarrier: "Carrier",
  });
  barber.forwardFromNumber = "+15555550001";
  barber.forwardingCarrier = "Carrier";
  await barber.save();

  const assigned = await assignForwardingRoutingNumberWithOptions("barber-1", provisionOptions(state));

  assert.equal(assigned.forwardFromNumber, "+15555550001");
  assert.equal(assigned.forwardToNumber, "+15555550100");
  assert.equal(assigned.inboundRoutingNumber, "+15555550100");
  assert.equal(assigned.inboundRoutingSid, "PN100");
  assert.equal(assigned.twilioNumber || null, null);
  assert.equal(assigned.pendingInboundRoutingNumber || null, null);
  assert.equal(assigned.forwardingStatus, "routing_ready");
  assert.equal(state.provider.searches, 1);
  assert.deepEqual(state.provider.purchases.map((entry) => entry.phoneNumber), ["+15555550100"]);
});

test("retrying forward_existing reuses assignment without a second provider purchase", async (t) => {
  const state = setup();
  mockBarber(t, state);
  await assignForwardingRoutingNumberWithOptions("barber-1", provisionOptions(state));
  await assignForwardingRoutingNumberWithOptions("barber-1", provisionOptions(state));

  assert.equal(state.assignments.records.length, 1);
  assert.equal(state.provider.searches, 1);
  assert.equal(state.provider.purchases.length, 1);
  assert.equal(state.barbers.records.get("barber-1").forwardToNumber, "+15555550100");
});

test("concurrent forward_existing submissions create one assignment and one active verification attempt", async (t) => {
  const state = setup({ providerDelayMs: 15 });
  mockBarber(t, state);
  mockAssignmentFindOne(t, state);
  process.env.TWILIO_VERIFICATION_FROM_NUMBER = "+15555550198";
  process.env.FORWARDING_VERIFICATION_HMAC_SECRET = VALID_TEST_SECRET;

  await Promise.all([
    assignForwardingRoutingNumberWithOptions("barber-1", provisionOptions(state)),
    assignForwardingRoutingNumberWithOptions("barber-1", provisionOptions(state)),
  ]);
  const [first, second] = await Promise.allSettled([
    startForwardingTest({ barberId: "barber-1", forwardFromNumber: "+15555550001" }),
    startForwardingTest({ barberId: "barber-1", forwardFromNumber: "+15555550001" }),
  ]);

  assert.equal(state.assignments.records.length, 1);
  assert.equal(state.provider.searches, 1);
  assert.equal(state.provider.purchases.length, 1);
  assert.equal([first, second].filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal([first, second].filter((entry) => entry.status === "rejected").length, 1);
  assert.equal(
    [first, second].find((entry) => entry.status === "rejected").reason.code,
    "VERIFICATION_ALREADY_RUNNING"
  );
  const fulfilled = [first, second].find((entry) => entry.status === "fulfilled").value;
  const rejected = [first, second].find((entry) => entry.status === "rejected").reason;
  assert.equal(state.barbers.records.get("barber-1").forwardingStatus, "verification_pending");
  assert.equal(typeof state.barbers.records.get("barber-1").verificationSessionId, "string");
  assert.equal(fulfilled.verificationSessionId, state.barbers.records.get("barber-1").verificationSessionId);
  assert.equal(rejected.verificationSessionId, state.barbers.records.get("barber-1").verificationSessionId);
});

test("forwarding status exposes current pending verification session id to the owner", async (t) => {
  const state = setup();
  mockBarber(t, state);
  mockAssignmentFindOne(t, state);
  process.env.TWILIO_VERIFICATION_FROM_NUMBER = "+15555550198";
  process.env.FORWARDING_VERIFICATION_HMAC_SECRET = VALID_TEST_SECRET;

  await assignForwardingRoutingNumberWithOptions("barber-1", provisionOptions(state));
  const started = await startForwardingTest({ barberId: "barber-1", forwardFromNumber: "+15555550001" });
  const status = await getStrategyStatus("barber-1");

  assert.equal(typeof started.verificationSessionId, "string");
  assert.equal(status.forwardingStatus, "verification_pending");
  assert.equal(status.verificationSessionId, started.verificationSessionId);
  assert.equal(status.verificationSessionId, state.barbers.records.get("barber-1").verificationSessionId);
});

test("active provisioning returns pending state and does not call provider again", async (t) => {
  const state = setup({
    assignments: [{
      _id: "assignment-1",
      barberId: "barber-1",
      role: "inbound_routing",
      status: "provisioning",
      attemptId: "attempt-active",
      attemptExpiresAt: new Date("2026-09-29T12:10:00Z"),
    }],
  });
  mockBarber(t, state);
  const result = await assignForwardingRoutingNumberWithOptions("barber-1", provisionOptions(state));

  assert.equal(result.routingProvisioning.status, "provisioning");
  assert.equal(result.forwardToNumber || null, null);
  assert.equal(state.provider.searches, 0);
  assert.equal(state.provider.purchases.length, 0);
});

test("retryable and terminal provisioning failures are represented without automatic repurchase", async (t) => {
  const retryable = setup({
    assignments: [{
      _id: "assignment-1",
      barberId: "barber-1",
      role: "inbound_routing",
      status: "failed",
      failureClass: "retryable",
      lastErrorCode: "NO_AVAILABLE_NUMBER",
      retryAfter: new Date("2026-09-29T12:00:00Z"),
    }],
    available: [],
  });
  mockBarber(t, retryable);
  mockAssignmentFindOne(t, retryable);
  const retryableStatus = await getStrategyStatus("barber-1");
  assert.equal(retryableStatus.phoneSetupState, "provisioning_failed_retryable");

  const terminal = setup({
    assignments: [{
      _id: "assignment-1",
      barberId: "barber-1",
      role: "inbound_routing",
      status: "failed",
      failureClass: "terminal",
      lastErrorCode: "PROVIDER_NUMBER_OWNED_BY_OTHER_ASSIGNMENT",
      numberKey: "+15555550100",
      candidateNumber: "+15555550100",
    }],
  });
  mockBarber(t, terminal);
  await assignForwardingRoutingNumberWithOptions("barber-1", provisionOptions(terminal));
  assert.equal(terminal.provider.purchases.length, 0);
  assert.equal(terminal.assignments.records[0].status, "failed");
});

test("provisioning survives verification failure and retry does not repurchase", async (t) => {
  const state = setup();
  mockBarber(t, state);
  mockAssignmentFindOne(t, state);
  process.env.TWILIO_VERIFICATION_FROM_NUMBER = "+15555550198";
  process.env.FORWARDING_VERIFICATION_HMAC_SECRET = VALID_TEST_SECRET;

  await assignForwardingRoutingNumberWithOptions("barber-1", provisionOptions(state));
  await startForwardingTest({ barberId: "barber-1", forwardFromNumber: "+15555550001" });
  const verified = await maybeVerifyForwardingCall({
    to: "+15555550100",
    from: "+15555550999",
    callSid: "CAwrong",
  });
  await assignForwardingRoutingNumberWithOptions("barber-1", provisionOptions(state));

  assert.equal(verified, false);
  assert.equal(state.assignments.records[0].status, "assigned");
  assert.equal(state.provider.purchases.length, 1);
  assert.equal(state.barbers.records.get("barber-1").forwardingStatus, "verification_pending");
});

test("successful verification is idempotent and stale failures cannot regress verified state", async (t) => {
  const state = setup();
  mockBarber(t, state);
  mockAssignmentFindOne(t, state);
  process.env.TWILIO_VERIFICATION_FROM_NUMBER = "+15555550198";
  process.env.FORWARDING_VERIFICATION_HMAC_SECRET = VALID_TEST_SECRET;

  await assignForwardingRoutingNumberWithOptions("barber-1", provisionOptions(state));
  const started = await startForwardingTest({ barberId: "barber-1", forwardFromNumber: "+15555550001" });
  const first = await maybeVerifyForwardingCall({
    to: "+15555550100",
    from: "+15555550198",
    callSid: "CAverify",
  });
  const verified = await verifyForwardingDigits({
    to: "+15555550100",
    callSid: "CAverify",
    sessionId: state.barbers.records.get("barber-1").verificationSessionId,
    digits: started.verificationCode,
  });
  const duplicate = await verifyForwardingDigits({
    to: "+15555550100",
    callSid: "CAverify",
    sessionId: "consumed-session",
    digits: started.verificationCode,
  });
  const barber = state.barbers.records.get("barber-1");
  const previousVerifiedAt = barber.forwardingVerifiedAt;
  barber.verificationWindowExpiresAt = new Date("2026-09-29T11:00:00Z");
  const stale = await maybeVerifyForwardingCall({
    to: "+15555550100",
    from: "+15555550999",
    callSid: "CAstale",
  });

  assert.equal(first, false);
  assert.equal(verified.verified, true);
  assert.equal(duplicate.verified, true);
  assert.equal(stale, false);
  assert.equal(barber.forwardingStatus, "verified");
  assert.equal(barber.forwardingVerifiedAt, previousVerifiedAt);
});

test("stale session A code and action cannot verify restarted session B", async (t) => {
  const state = setup();
  mockBarber(t, state);
  mockAssignmentFindOne(t, state);
  process.env.FORWARDING_VERIFICATION_HMAC_SECRET = VALID_TEST_SECRET;

  await assignForwardingRoutingNumberWithOptions("barber-1", provisionOptions(state));
  const sessionA = await startForwardingTest({ barberId: "barber-1", forwardFromNumber: "+15555550001" });
  const barber = state.barbers.records.get("barber-1");
  const idA = barber.verificationSessionId;
  const digestA = barber.verificationCodeDigest;

  const callA = await beginForwardingVerificationCall({
    to: "+15555550100",
    from: "+15555550001",
    callSid: "CA-A",
  });
  assert.equal(callA.active, true);
  assert.equal(barber.verificationCallSid, "CA-A");

  const sessionB = await startForwardingTest({
    barberId: "barber-1",
    forwardFromNumber: "+15555550001",
    restartVerification: true,
    expectedVerificationSessionId: idA,
  });
  const idB = barber.verificationSessionId;
  const digestB = barber.verificationCodeDigest;
  assert.notEqual(idA, idB);
  assert.notEqual(digestA, digestB);
  assert.equal(barber.verificationCallSid, null);

  const staleA = await verifyForwardingDigits({
    to: "+15555550100",
    callSid: "CA-A",
    sessionId: idA,
    digits: sessionA.verificationCode,
  });
  assert.equal(staleA.verified, false);
  assert.equal(barber.verificationSessionId, idB);
  assert.equal(barber.verificationCodeDigest, digestB);
  assert.equal(barber.verificationCallSid, null);
  assert.equal(barber.verificationCodeAttempts, 0);

  const codeAWithB = await verifyForwardingDigits({
    to: "+15555550100",
    callSid: "CA-A",
    sessionId: idB,
    digits: sessionA.verificationCode,
  });
  assert.equal(codeAWithB.verified, false);
  assert.equal(barber.verificationCodeAttempts, 0);

  const callB = await beginForwardingVerificationCall({
    to: "+15555550100",
    from: "+15555550001",
    callSid: "CA-B",
  });
  assert.equal(callB.active, true);
  assert.equal(barber.verificationCallSid, "CA-B");

  const codeBWithA = await verifyForwardingDigits({
    to: "+15555550100",
    callSid: "CA-B",
    sessionId: idA,
    digits: sessionB.verificationCode,
  });
  assert.equal(codeBWithA.verified, false);
  assert.equal(barber.forwardingStatus, "verification_pending");

  const verifyB = await verifyForwardingDigits({
    to: "+15555550100",
    callSid: "CA-B",
    sessionId: idB,
    digits: sessionB.verificationCode,
  });
  assert.equal(verifyB.verified, true);
  assert.equal(barber.forwardingStatus, "verified");

  const replayB = await verifyForwardingDigits({
    to: "+15555550100",
    callSid: "CA-B",
    sessionId: idB,
    digits: sessionB.verificationCode,
  });
  assert.equal(replayB.verified, true);
});

test("atomic CallSid race admits one owner and duplicate owner remains idempotent", async (t) => {
  const state = setup();
  mockBarber(t, state);
  mockAssignmentFindOne(t, state);
  process.env.FORWARDING_VERIFICATION_HMAC_SECRET = VALID_TEST_SECRET;

  await assignForwardingRoutingNumberWithOptions("barber-1", provisionOptions(state));
  await startForwardingTest({ barberId: "barber-1", forwardFromNumber: "+15555550001" });

  const [a, b] = await Promise.all([
    beginForwardingVerificationCall({ to: "+15555550100", from: "+15555550001", callSid: "CA-1" }),
    beginForwardingVerificationCall({ to: "+15555550100", from: "+15555550002", callSid: "CA-2" }),
  ]);
  const winners = [a, b].filter((entry) => entry.active);
  assert.equal(winners.length, 1);
  const owner = state.barbers.records.get("barber-1").verificationCallSid;
  assert.ok(["CA-1", "CA-2"].includes(owner));

  const duplicate = await beginForwardingVerificationCall({
    to: "+15555550100",
    from: "+15555550003",
    callSid: owner,
  });
  assert.equal(duplicate.active, true);
});

test("atomic incorrect attempts exhaust after five and block later correct code", async (t) => {
  const state = setup();
  mockBarber(t, state);
  mockAssignmentFindOne(t, state);
  process.env.FORWARDING_VERIFICATION_HMAC_SECRET = VALID_TEST_SECRET;

  await assignForwardingRoutingNumberWithOptions("barber-1", provisionOptions(state));
  const started = await startForwardingTest({ barberId: "barber-1", forwardFromNumber: "+15555550001" });
  const barber = state.barbers.records.get("barber-1");
  await beginForwardingVerificationCall({ to: "+15555550100", from: "+15555550001", callSid: "CAwrong" });

  const wrong = await Promise.all(
    ["111111", "222222", "333333", "444444", "555555"].map((digits) =>
      verifyForwardingDigits({
        to: "+15555550100",
        callSid: "CAwrong",
        sessionId: barber.verificationSessionId,
        digits,
      })
    )
  );
  assert.equal(wrong.filter((entry) => entry.reason === "CODE_MISMATCH").length, 5);
  assert.equal(barber.verificationCodeAttempts, 5);

  const sixth = await verifyForwardingDigits({
    to: "+15555550100",
    callSid: "CAwrong",
    sessionId: barber.verificationSessionId,
    digits: started.verificationCode,
  });
  assert.equal(sixth.verified, false);
  assert.equal(sixth.reason, "TOO_MANY_ATTEMPTS");
  assert.equal(barber.forwardingStatus, "verification_pending");
});

test("atomic success races are serializable and cannot regress verified state", async (t) => {
  const state = setup();
  mockBarber(t, state);
  mockAssignmentFindOne(t, state);
  process.env.FORWARDING_VERIFICATION_HMAC_SECRET = VALID_TEST_SECRET;

  await assignForwardingRoutingNumberWithOptions("barber-1", provisionOptions(state));
  const started = await startForwardingTest({ barberId: "barber-1", forwardFromNumber: "+15555550001" });
  const barber = state.barbers.records.get("barber-1");
  const sessionId = barber.verificationSessionId;
  await beginForwardingVerificationCall({ to: "+15555550100", from: "+15555550001", callSid: "CArace" });

  const [correctA, correctB] = await Promise.all([
    verifyForwardingDigits({
      to: "+15555550100",
      callSid: "CArace",
      sessionId,
      digits: started.verificationCode,
    }),
    verifyForwardingDigits({
      to: "+15555550100",
      callSid: "CArace",
      sessionId,
      digits: started.verificationCode,
    }),
  ]);

  assert.equal([correctA, correctB].filter((entry) => entry.verified).length, 1);
  assert.equal(barber.forwardingStatus, "verified");
  assert.equal(barber.verificationSessionId, null);
  assert.equal(barber.verificationCodeDigest, null);
  assert.equal(barber.verificationCodeAttempts, 0);
  assert.equal(barber.verificationCallSid, null);

  const secondState = setup();
  mockBarber(t, secondState);
  mockAssignmentFindOne(t, secondState);
  await assignForwardingRoutingNumberWithOptions("barber-1", provisionOptions(secondState));
  const secondStarted = await startForwardingTest({ barberId: "barber-1", forwardFromNumber: "+15555550001" });
  const secondBarber = secondState.barbers.records.get("barber-1");
  const secondSessionId = secondBarber.verificationSessionId;
  await beginForwardingVerificationCall({ to: "+15555550100", from: "+15555550001", callSid: "CArace2" });

  const [wrong, correct] = await Promise.all([
    verifyForwardingDigits({
      to: "+15555550100",
      callSid: "CArace2",
      sessionId: secondSessionId,
      digits: "999999",
    }),
    verifyForwardingDigits({
      to: "+15555550100",
      callSid: "CArace2",
      sessionId: secondSessionId,
      digits: secondStarted.verificationCode,
    }),
  ]);

  assert.equal(wrong.verified, false);
  assert.equal(wrong.reason, "CODE_MISMATCH");
  assert.equal(correct.verified, true);
  assert.equal(secondBarber.forwardingStatus, "verified");
  assert.equal(secondBarber.verificationCodeAttempts, 0);
  assert.equal(secondBarber.verificationSessionId, null);
});

test("success first prevents later wrong increment and preserves consumed verified state", async (t) => {
  const state = setup();
  mockBarber(t, state);
  mockAssignmentFindOne(t, state);
  process.env.FORWARDING_VERIFICATION_HMAC_SECRET = VALID_TEST_SECRET;

  await assignForwardingRoutingNumberWithOptions("barber-1", provisionOptions(state));
  const started = await startForwardingTest({ barberId: "barber-1", forwardFromNumber: "+15555550001" });
  const barber = state.barbers.records.get("barber-1");
  const sessionId = barber.verificationSessionId;
  await beginForwardingVerificationCall({ to: "+15555550100", from: "+15555550001", callSid: "CAsuccessFirst" });

  const verified = await verifyForwardingDigits({
    to: "+15555550100",
    callSid: "CAsuccessFirst",
    sessionId,
    digits: started.verificationCode,
  });
  const verifiedAt = barber.forwardingVerifiedAt;
  const wrongAfter = await verifyForwardingDigits({
    to: "+15555550100",
    callSid: "CAsuccessFirst",
    sessionId,
    digits: "999999",
  });

  assert.equal(verified.verified, true);
  assert.equal(wrongAfter.verified, true);
  assert.equal(wrongAfter.reason, "ALREADY_VERIFIED");
  assert.equal(barber.forwardingStatus, "verified");
  assert.equal(barber.forwardingVerifiedAt, verifiedAt);
  assert.equal(barber.verificationSessionId, null);
  assert.equal(barber.verificationCodeDigest, null);
  assert.equal(barber.verificationCodeAttempts, 0);
  assert.equal(barber.verificationCallSid, null);
  assert.equal(state.assignments.records.length, 1);
  assert.equal(state.provider.searches, 1);
  assert.equal(state.provider.purchases.length, 1);
});

test("exhaustion first prevents later correct success and preserves pending exhausted state", async (t) => {
  const state = setup();
  mockBarber(t, state);
  mockAssignmentFindOne(t, state);
  process.env.FORWARDING_VERIFICATION_HMAC_SECRET = VALID_TEST_SECRET;

  await assignForwardingRoutingNumberWithOptions("barber-1", provisionOptions(state));
  const started = await startForwardingTest({ barberId: "barber-1", forwardFromNumber: "+15555550001" });
  const barber = state.barbers.records.get("barber-1");
  const sessionId = barber.verificationSessionId;
  await beginForwardingVerificationCall({ to: "+15555550100", from: "+15555550001", callSid: "CAexhaustFirst" });

  for (const digits of ["111111", "222222", "333333", "444444", "555555"]) {
    const failed = await verifyForwardingDigits({
      to: "+15555550100",
      callSid: "CAexhaustFirst",
      sessionId,
      digits,
    });
    assert.equal(failed.reason, "CODE_MISMATCH");
  }

  const correctAfter = await verifyForwardingDigits({
    to: "+15555550100",
    callSid: "CAexhaustFirst",
    sessionId,
    digits: started.verificationCode,
  });

  assert.equal(correctAfter.verified, false);
  assert.equal(correctAfter.reason, "TOO_MANY_ATTEMPTS");
  assert.equal(barber.forwardingStatus, "verification_pending");
  assert.equal(barber.forwardingVerifiedAt, null);
  assert.equal(barber.verificationSessionId, sessionId);
  assert.equal(typeof barber.verificationCodeDigest, "string");
  assert.equal(barber.verificationCodeAttempts, 5);
  assert.equal(barber.verificationCallSid, "CAexhaustFirst");
  assert.equal(state.assignments.records.length, 1);
  assert.equal(state.provider.searches, 1);
  assert.equal(state.provider.purchases.length, 1);
});

test("explicit verification restart race has one durable winner and no provider work", async (t) => {
  const state = setup();
  mockBarber(t, state);
  mockAssignmentFindOne(t, state);
  process.env.FORWARDING_VERIFICATION_HMAC_SECRET = VALID_TEST_SECRET;

  await assignForwardingRoutingNumberWithOptions("barber-1", provisionOptions(state));
  const sessionA = await startForwardingTest({ barberId: "barber-1", forwardFromNumber: "+15555550001" });
  const barber = state.barbers.records.get("barber-1");
  const idA = barber.verificationSessionId;
  const digestA = barber.verificationCodeDigest;
  barber.verificationCodeAttempts = 3;
  barber.verificationCallSid = "CA-old";
  const purchasesBefore = state.provider.purchases.length;
  const searchesBefore = state.provider.searches;

  const results = await Promise.allSettled([
    startForwardingTest({
      barberId: "barber-1",
      forwardFromNumber: "+15555550001",
      restartVerification: true,
      expectedVerificationSessionId: idA,
    }),
    startForwardingTest({
      barberId: "barber-1",
      forwardFromNumber: "+15555550001",
      restartVerification: true,
      expectedVerificationSessionId: idA,
    }),
  ]);

  const fulfilled = results.filter((entry) => entry.status === "fulfilled");
  const rejected = results.filter((entry) => entry.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "VERIFICATION_ALREADY_RUNNING");
  assert.notEqual(barber.verificationSessionId, idA);
  assert.notEqual(barber.verificationCodeDigest, digestA);
  assert.notEqual(fulfilled[0].value.verificationCode, sessionA.verificationCode);
  assert.equal(barber.verificationCallSid, null);
  assert.equal(barber.verificationCodeAttempts, 0);
  assert.equal(state.assignments.records.length, 1);
  assert.equal(state.provider.searches, searchesBefore);
  assert.equal(state.provider.purchases.length, purchasesBefore);
});

test("explicit restart requires the current expected session and rejects stale expectation", async (t) => {
  const state = setup();
  mockBarber(t, state);
  mockAssignmentFindOne(t, state);
  process.env.FORWARDING_VERIFICATION_HMAC_SECRET = VALID_TEST_SECRET;

  await assignForwardingRoutingNumberWithOptions("barber-1", provisionOptions(state));
  await startForwardingTest({ barberId: "barber-1", forwardFromNumber: "+15555550001" });
  const barber = state.barbers.records.get("barber-1");
  const currentSessionId = barber.verificationSessionId;
  const currentDigest = barber.verificationCodeDigest;

  await assert.rejects(
    () =>
      startForwardingTest({
        barberId: "barber-1",
        forwardFromNumber: "+15555550001",
        restartVerification: true,
      }),
    { code: "VERIFICATION_ALREADY_RUNNING" }
  );
  await assert.rejects(
    () =>
      startForwardingTest({
        barberId: "barber-1",
        forwardFromNumber: "+15555550001",
        restartVerification: true,
        expectedVerificationSessionId: "stale-session",
      }),
    { code: "VERIFICATION_ALREADY_RUNNING" }
  );
  assert.equal(barber.verificationSessionId, currentSessionId);
  assert.equal(barber.verificationCodeDigest, currentDigest);
});

test("canonical mirror mismatches fail closed before verification session creation", async (t) => {
  const cases = [
    ["assignment missing", { assignments: [] }],
    ["assignment belongs to another barber", { assignment: { barberId: "other-barber" } }],
    ["wrong assignment role", { assignment: { role: "sms_sender" } }],
    ["status is not assigned", { assignment: { status: "provisioning" } }],
    ["numberKey missing", { assignment: { numberKey: undefined } }],
    ["numberKey blank", { assignment: { numberKey: " " } }],
    ["phoneNumber missing", { assignment: { phoneNumber: undefined } }],
    ["phoneNumber differs", { assignment: { phoneNumber: "+15555550101" } }],
    ["inboundRoutingNumber missing", { barber: { inboundRoutingNumber: undefined } }],
    ["inboundRoutingNumber differs", { barber: { inboundRoutingNumber: "+15555550101" } }],
    ["forwardToNumber missing", { barber: { forwardToNumber: undefined } }],
    ["forwardToNumber differs", { barber: { forwardToNumber: "+15555550101" } }],
    ["providerSid missing", { assignment: { providerSid: undefined } }],
    ["inboundRoutingSid missing", { barber: { inboundRoutingSid: undefined } }],
    ["inboundRoutingSid differs", { barber: { inboundRoutingSid: "PN-other" } }],
    ["pendingInboundRoutingNumber populated", { barber: { pendingInboundRoutingNumber: "+15555550102" } }],
  ];

  for (const [name, config] of cases) {
    await t.test(name, async (t) => {
      const assignment = config.assignments || [{
        _id: "assignment-1",
        barberId: "barber-1",
        role: "inbound_routing",
        status: "assigned",
        numberKey: "+15555550100",
        phoneNumber: "+15555550100",
        providerSid: "PN100",
        ...(config.assignment || {}),
      }];
      const state = setup({ assignments: assignment });
      mockBarber(t, state);
      mockAssignmentFindOne(t, state);
      process.env.FORWARDING_VERIFICATION_HMAC_SECRET = VALID_TEST_SECRET;
      const barber = state.barbers.records.get("barber-1");
      Object.assign(barber, {
        forwardFromNumber: "+15555550001",
        forwardToNumber: "+15555550100",
        inboundRoutingNumber: "+15555550100",
        inboundRoutingSid: "PN100",
        ...(config.barber || {}),
      });
      const before = clone({
        forwardingStatus: barber.forwardingStatus,
        verificationSessionId: barber.verificationSessionId,
        verificationWindowExpiresAt: barber.verificationWindowExpiresAt,
        verificationCodeDigest: barber.verificationCodeDigest,
        verificationCodeAttempts: barber.verificationCodeAttempts,
        verificationCallSid: barber.verificationCallSid,
        assignment: state.assignments.records[0] || null,
      });

      await assert.rejects(
        () => startForwardingTest({ barberId: "barber-1", forwardFromNumber: "+15555550001" }),
        (error) =>
          ["FORWARDING_ROUTING_NOT_ASSIGNED", "FORWARDING_ROUTING_MIRROR_MISMATCH", "INVALID_FORWARDING_PHONE"].includes(error.code)
      );
      assert.deepEqual(
        clone({
          forwardingStatus: barber.forwardingStatus,
          verificationSessionId: barber.verificationSessionId,
          verificationWindowExpiresAt: barber.verificationWindowExpiresAt,
          verificationCodeDigest: barber.verificationCodeDigest,
          verificationCodeAttempts: barber.verificationCodeAttempts,
          verificationCallSid: barber.verificationCallSid,
          assignment: state.assignments.records[0] || null,
        }),
        before
      );
      assert.equal(state.provider.searches, 0);
      assert.equal(state.provider.purchases.length, 0);
    });
  }
});

test("canonical mirror mismatches fail closed at CallSid binding and DTMF consumption", async (t) => {
  const state = setup();
  mockBarber(t, state);
  mockAssignmentFindOne(t, state);
  process.env.FORWARDING_VERIFICATION_HMAC_SECRET = VALID_TEST_SECRET;

  await assignForwardingRoutingNumberWithOptions("barber-1", provisionOptions(state));
  const started = await startForwardingTest({ barberId: "barber-1", forwardFromNumber: "+15555550001" });
  const barber = state.barbers.records.get("barber-1");
  state.assignments.records[0].providerSid = "PN-mismatch";

  const bound = await beginForwardingVerificationCall({
    to: "+15555550100",
    from: "+15555550001",
    callSid: "CAmismatch",
  });
  assert.equal(bound.active, false);
  assert.equal(barber.verificationCallSid, null);
  assert.equal(barber.forwardingStatus, "verification_pending");

  state.assignments.records[0].providerSid = "PN100";
  const validBind = await beginForwardingVerificationCall({
    to: "+15555550100",
    from: "+15555550001",
    callSid: "CAmismatch",
  });
  assert.equal(validBind.active, true);
  state.assignments.records[0].phoneNumber = "+15555550101";
  const consumed = await verifyForwardingDigits({
    to: "+15555550100",
    callSid: "CAmismatch",
    sessionId: barber.verificationSessionId,
    digits: started.verificationCode,
  });
  assert.equal(consumed.verified, false);
  assert.equal(consumed.reason, "ROUTING_MISMATCH");
  assert.equal(barber.forwardingStatus, "verification_pending");
  assert.equal(barber.forwardingVerifiedAt, null);
});

test("forwarding verification HMAC secret edge cases fail closed without leaking secret material", async (t) => {
  const cases = [
    ["missing", undefined, "FORWARDING_VERIFICATION_SECRET_MISSING"],
    ["empty", "", "FORWARDING_VERIFICATION_SECRET_MISSING"],
    ["whitespace", "   ", "FORWARDING_VERIFICATION_SECRET_MISSING"],
    ["short", "short", "FORWARDING_VERIFICATION_SECRET_WEAK"],
    ["placeholder hyphen", "change-me", "FORWARDING_VERIFICATION_SECRET_WEAK"],
    ["placeholder compact", "changeme", "FORWARDING_VERIFICATION_SECRET_WEAK"],
    ["placeholder case and whitespace", " Change-Me ", "FORWARDING_VERIFICATION_SECRET_WEAK"],
  ];

  for (const [name, secret, code] of cases) {
    await t.test(name, async (t) => {
      const state = setup();
      mockBarber(t, state);
      mockAssignmentFindOne(t, state);
      if (secret === undefined) delete process.env.FORWARDING_VERIFICATION_HMAC_SECRET;
      else process.env.FORWARDING_VERIFICATION_HMAC_SECRET = secret;
      const barber = state.barbers.records.get("barber-1");
      Object.assign(barber, {
        forwardToNumber: "+15555550100",
        inboundRoutingNumber: "+15555550100",
        inboundRoutingSid: "PN100",
      });
      state.assignments.records.push({
        _id: "assignment-1",
        barberId: "barber-1",
        role: "inbound_routing",
        status: "assigned",
        numberKey: "+15555550100",
        phoneNumber: "+15555550100",
        providerSid: "PN100",
      });
      const logs = [];
      const originalLog = console.log;
      console.log = (...args) => logs.push(args.join(" "));
      t.after(() => {
        console.log = originalLog;
      });

      await assert.rejects(
        () => startForwardingTest({ barberId: "barber-1", forwardFromNumber: "+15555550001" }),
        (error) => {
          assert.equal(error.code, code);
          assert.doesNotMatch(error.message, /change-me|changeme|short/i);
          return true;
        }
      );
      assert.equal(barber.forwardingStatus, "not_started");
      assert.equal(barber.verificationSessionId, null);
      assert.equal(barber.verificationCodeDigest, undefined);
      const needle = String(secret || "").trim();
      if (needle) {
        assert.equal(logs.some((entry) => entry.includes(needle)), false);
      }
    });
  }

  const state = setup();
  mockBarber(t, state);
  mockAssignmentFindOne(t, state);
  process.env.FORWARDING_VERIFICATION_HMAC_SECRET = VALID_TEST_SECRET;
  await assignForwardingRoutingNumberWithOptions("barber-1", provisionOptions(state));
  const result = await startForwardingTest({ barberId: "barber-1", forwardFromNumber: "+15555550001" });
  assert.match(result.verificationCode, /^\d{6}$/);
});

test("deterministic test code generator preserves leading zeroes without persisting plaintext", async (t) => {
  const state = setup();
  mockBarber(t, state);
  mockAssignmentFindOne(t, state);
  process.env.FORWARDING_VERIFICATION_HMAC_SECRET = VALID_TEST_SECRET;

  await assignForwardingRoutingNumberWithOptions("barber-1", provisionOptions(state));
  const result = await startForwardingTest({
    barberId: "barber-1",
    forwardFromNumber: "+15555550001",
    createVerificationCode: () => "000042",
  });
  const barber = state.barbers.records.get("barber-1");
  await beginForwardingVerificationCall({ to: "+15555550100", from: "+15555550001", callSid: "CAzero" });

  const shortCode = await verifyForwardingDigits({
    to: "+15555550100",
    callSid: "CAzero",
    sessionId: barber.verificationSessionId,
    digits: "42",
  });
  const verified = await verifyForwardingDigits({
    to: "+15555550100",
    callSid: "CAzero",
    sessionId: barber.verificationSessionId,
    digits: "000042",
  });

  assert.equal(result.verificationCode, "000042");
  assert.match(result.verificationCode, /^\d{6}$/);
  assert.notEqual(barber.verificationCodeDigest, "000042");
  assert.equal(shortCode.verified, false);
  assert.equal(shortCode.reason, "INVALID_DIGITS");
  assert.equal(verified.verified, true);
});

test("unauthorized barber cannot provision or verify another barber and routing resolver ignores forwarding-only fields", async (t) => {
  const state = setup({ barbers: ["barber-1", "barber-2"] });
  mockBarber(t, state);
  mockAssignmentFindOne(t, state);
  await assignForwardingRoutingNumberWithOptions("barber-1", provisionOptions(state));
  const other = state.barbers.records.get("barber-2");
  other.numberStrategy = "forward_existing";
  other.phoneNumberStrategy = "forward_existing";
  other.forwardToNumber = "+15555550100";
  other.forwardingStatus = "verification_pending";
  other.verificationSessionId = "attacker-session";
  other.verificationWindowExpiresAt = new Date(Date.now() + 60_000);
  process.env.TWILIO_VERIFICATION_FROM_NUMBER = "+15555550198";

  const verified = await maybeVerifyForwardingCall({
    to: "+15555550100",
    from: "+15555550198",
    callSid: "CAverify",
  });
  assert.equal(verified, false);
  assert.equal(other.forwardingStatus, "verification_pending");

  const resolved = await findBarberByInboundNumber("+15555550100", {
    findOneFn: (filter) => {
      if (filter.inboundRoutingNumber === "+15555550100") return state.barbers.records.get("barber-1");
      if (filter.$or?.some((entry) => entry.forwardToNumber === "+15555550100")) {
        throw new Error("forwardToNumber must not be queried for routing identity");
      }
      return { sort: () => null };
    },
  });
  assert.equal(resolved._id, "barber-1");
});

test("other phone strategies retain current behavior", async (t) => {
  const state = setup();
  mockBarber(t, state);
  await assignStrategy("barber-1", "new_number");
  assert.equal(state.barbers.records.get("barber-1").numberStrategy, "new_number");
  assert.equal(state.provider.purchases.length, 0);
  await assignStrategy("barber-1", "port_existing");
  assert.equal(state.barbers.records.get("barber-1").numberStrategy, "port_existing");
  assert.equal(state.provider.purchases.length, 0);
});

function provisionOptions(state) {
  return {
    provisioningOptions: {
      AssignmentModel: state.assignments,
      BarberModel: state.barbers,
      provider: state.provider,
      baseUrl: BASE_URL,
      now: () => NOW,
      createAttemptId: () => `attempt-${state.assignments.attempts++}`,
    },
    AssignmentModel: state.assignments,
  };
}

function setup({
  assignments = [],
  available = ["+15555550100"],
  sidByNumber = { "+15555550100": "PN100" },
  providerDelayMs = 0,
  barbers = ["barber-1"],
} = {}) {
  const assignModel = createAssignmentModel(assignments);
  const barberModel = createBarberModel(Object.fromEntries(barbers.map((id) => [id, {
    _id: id,
    numberStrategy: "forward_existing",
    phoneNumberStrategy: "forward_existing",
    forwardingStatus: "not_started",
    onboarding: { stepMap: {} },
  }])));
  const provider = createProvider({ available, sidByNumber, providerDelayMs });
  return { assignments: assignModel, barbers: barberModel, provider };
}

function mockBarber(t, state) {
  t.mock.method(Barber, "findById", async (id) => state.barbers.findById(id));
  t.mock.method(Barber, "findOne", async (query) => state.barbers.findOne(query));
  t.mock.method(Barber, "findOneAndUpdate", async (query, update) =>
    state.barbers.findOneAndUpdate(query, update)
  );
}

function mockAssignmentFindOne(t, state) {
  t.mock.method(PhoneNumberAssignment, "findOne", async (query) => state.assignments.findOne(query));
}

function createProvider({ available, sidByNumber, providerDelayMs }) {
  const ownedNumbers = new Map();
  return {
    searches: 0,
    purchases: [],
    async searchAvailableNumbers() {
      this.searches += 1;
      return available.map((phoneNumber) => ({ phoneNumber }));
    },
    async findOwnedNumber({ phoneNumber }) {
      return ownedNumbers.get(phoneNumber) || null;
    },
    async purchaseNumber(payload) {
      if (providerDelayMs) await new Promise((resolve) => setTimeout(resolve, providerDelayMs));
      this.purchases.push(payload);
      ownedNumbers.set(payload.phoneNumber, {
        phoneNumber: payload.phoneNumber,
        sid: sidByNumber[payload.phoneNumber],
        friendlyName: payload.friendlyName,
        voiceUrl: payload.voiceUrl,
        smsUrl: payload.smsUrl,
      });
      return { phoneNumber: payload.phoneNumber, sid: sidByNumber[payload.phoneNumber] };
    },
  };
}

function createBarberModel(seed) {
  const records = new Map();
  for (const [id, value] of Object.entries(seed)) records.set(id, barberDoc(value, records));
  return {
    records,
    async findById(id) {
      const found = records.get(String(id));
      return found || null;
    },
    async findOne(query) {
      return [...records.values()].find((record) => matches(record, query)) || null;
    },
    async findOneAndUpdate(query, update) {
      const record = [...records.values()].find((entry) => matches(entry, query));
      if (!record) return null;
      applyUpdate(record, update);
      return record;
    },
  };
}

function barberDoc(value, records) {
  return {
    inboundRoutingNumber: null,
    inboundRoutingSid: null,
    forwardFromNumber: null,
    forwardToNumber: null,
    forwardingVerifiedAt: null,
    verificationSessionId: null,
    verificationWindowExpiresAt: null,
    ...clone(value),
    async save() {
      records.set(String(this._id), this);
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

function matches(record, query = {}) {
  for (const [key, value] of Object.entries(query)) {
    if (key === "$or") {
      if (!value.some((term) => matches(record, term))) return false;
      continue;
    }
    if (typeof value === "object" && value !== null && "$lte" in value) {
      if (!(new Date(record[key]).getTime() <= new Date(value.$lte).getTime())) return false;
      continue;
    }
    if (typeof value === "object" && value !== null && "$gt" in value) {
      if (!(new Date(record[key]).getTime() > new Date(value.$gt).getTime())) return false;
      continue;
    }
    if (typeof value === "object" && value !== null && "$lt" in value) {
      if (!(Number(record[key] || 0) < Number(value.$lt))) return false;
      continue;
    }
    if (typeof value === "object" && value !== null && "$in" in value) {
      if (!value.$in.includes(record[key] ?? null)) return false;
      continue;
    }
    if (record[key] !== value) return false;
  }
  return true;
}

function applyUpdate(record, update) {
  for (const [key, value] of Object.entries(update.$set || {})) record[key] = value;
  for (const [key, value] of Object.entries(update.$inc || {})) {
    record[key] = Number(record[key] || 0) + Number(value);
  }
  for (const key of Object.keys(update.$unset || {})) delete record[key];
}

function enforceUniques(existing, record) {
  if (existing.some((entry) => entry.barberId === record.barberId && entry.role === record.role)) throw duplicate("barberId");
  for (const field of ["numberKey", "candidateNumber", "phoneNumber", "providerSid"]) {
    if (record[field] && existing.some((entry) => entry[field] === record[field])) throw duplicate(field);
  }
}

function duplicate(field) {
  return Object.assign(new Error("duplicate key"), { code: 11000, keyPattern: { [field]: 1 } });
}

function clone(value) {
  return structuredClone(value);
}
