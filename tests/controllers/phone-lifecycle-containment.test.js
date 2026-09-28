import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.STRIPE_SECRET_KEY ||= "sk_test_phoneLifecycleContainment";
process.env.STRIPE_WEBHOOK_SECRET ||= "whsec_phoneLifecycleContainment";

const { cancelBarber } = await import("../../controllers/cancelController.js");
const stripeModule = await import("../../utils/stripe.js");
const stripeWebhookModule = await import("../../routes/stripeWebhookRoutes.js");
const Barber = (await import("../../models/Barber.js")).default;
const Subscription = (await import("../../models/Subscription.js")).default;
const cancelControllerSource = () =>
  readFileSync(new URL("../../controllers/cancelController.js", import.meta.url), "utf8");
const stripeWebhookSource = () =>
  readFileSync(new URL("../../routes/stripeWebhookRoutes.js", import.meta.url), "utf8");

const makeResponse = () => {
  const response = {
    statusCode: 200,
    body: undefined,
    text: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.text = payload;
      return this;
    },
  };
  return response;
};

test("DELETE /api/cancel/:barberId returns disabled response without revealing account existence", async () => {
  for (const barberId of ["existing-barber", "unknown-barber"]) {
    const response = makeResponse();

    await cancelBarber({ params: { barberId } }, response);

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.body, {
      error: "ACCOUNT_CANCELLATION_UNAVAILABLE",
    });
  }
});

test("disabled cancellation route never reads, deletes, or releases Barber phone state", async (t) => {
  const originalFindById = Barber.findById;
  const originalFindByIdAndDelete = Barber.findByIdAndDelete;
  const originalDeleteOne = Barber.deleteOne;
  const originalFindOneAndDelete = Barber.findOneAndDelete;
  const calls = {
    findById: 0,
    findByIdAndDelete: 0,
    deleteOne: 0,
    findOneAndDelete: 0,
  };
  const existingBarber = Object.freeze({
    _id: "existing-barber",
    twilioNumber: "+15555550100",
    assignedTwilioNumber: "+15555550100",
    interimTwilioNumber: "+15555550101",
    twilioSid: "PNexisting",
    forwardingEnabled: true,
  });
  const before = structuredClone(existingBarber);
  const response = makeResponse();

  t.after(() => {
    Barber.findById = originalFindById;
    Barber.findByIdAndDelete = originalFindByIdAndDelete;
    Barber.deleteOne = originalDeleteOne;
    Barber.findOneAndDelete = originalFindOneAndDelete;
  });

  Barber.findById = async () => {
    calls.findById += 1;
    throw new Error("Barber.findById must not be called by disabled cancellation");
  };
  Barber.findByIdAndDelete = async () => {
    calls.findByIdAndDelete += 1;
    throw new Error("Barber.findByIdAndDelete must not be called by disabled cancellation");
  };
  Barber.deleteOne = async () => {
    calls.deleteOne += 1;
    throw new Error("Barber.deleteOne must not be called by disabled cancellation");
  };
  Barber.findOneAndDelete = async () => {
    calls.findOneAndDelete += 1;
    throw new Error("Barber.findOneAndDelete must not be called by disabled cancellation");
  };

  await cancelBarber({ params: { barberId: existingBarber._id } }, response);

  assert.equal(response.statusCode, 404);
  assert.deepEqual(existingBarber, before);
  assert.deepEqual(calls, {
    findById: 0,
    findByIdAndDelete: 0,
    deleteOne: 0,
    findOneAndDelete: 0,
  });
  assert.doesNotMatch(cancelControllerSource(), /releasePhoneNumber|incomingPhoneNumbers|twilio\s*\(/);
});

test("Stripe customer.subscription.deleted updates billing status only and preserves phone lifecycle fields", async (t) => {
  const originalConstructEvent = stripeModule.stripe.webhooks.constructEvent;
  const originalSubscriptionFindOne = Subscription.findOne;
  const originalBarberFindOne = Barber.findOne;

  const subscriptionDoc = {
    status: "active",
    canceledAt: null,
    saveCount: 0,
    async save() {
      this.saveCount += 1;
    },
  };
  const barberDoc = {
    _id: "barber-1",
    subscriptionStatus: "active",
    twilioNumber: "+15555550100",
    assignedTwilioNumber: "+15555550100",
    interimTwilioNumber: "+15555550101",
    twilioSid: "PNexisting",
    forwardingEnabled: true,
    saveCount: 0,
    async save() {
      this.saveCount += 1;
    },
  };
  const phoneSnapshot = {
    twilioNumber: barberDoc.twilioNumber,
    assignedTwilioNumber: barberDoc.assignedTwilioNumber,
    interimTwilioNumber: barberDoc.interimTwilioNumber,
    twilioSid: barberDoc.twilioSid,
    forwardingEnabled: barberDoc.forwardingEnabled,
  };
  let constructEventCalled = 0;
  const sourceBefore = stripeWebhookSource();

  t.after(() => {
    stripeModule.stripe.webhooks.constructEvent = originalConstructEvent;
    Subscription.findOne = originalSubscriptionFindOne;
    Barber.findOne = originalBarberFindOne;
  });

  stripeModule.stripe.webhooks.constructEvent = (_body, signature, secret) => {
    constructEventCalled += 1;
    assert.equal(signature, "valid-signature");
    assert.equal(secret, process.env.STRIPE_WEBHOOK_SECRET);
    return {
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_containment",
        },
      },
    };
  };
  Subscription.findOne = async (filter) => {
    assert.deepEqual(filter, { stripeSubscriptionId: "sub_containment" });
    return subscriptionDoc;
  };
  Barber.findOne = (filter) => {
    assert.deepEqual(filter, { stripeSubscriptionId: "sub_containment" });
    return {
      select(selection) {
        assert.equal(selection, "_id expoPushToken subscriptionStatus");
        return Promise.resolve(barberDoc);
      },
    };
  };

  const response = makeResponse();
  await stripeWebhookModule.default(
    {
      headers: {
        "stripe-signature": "valid-signature",
      },
      body: Buffer.from("{}"),
    },
    response
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { received: true });
  assert.equal(constructEventCalled, 1);
  assert.doesNotMatch(sourceBefore, /from\s+["']twilio["']|incomingPhoneNumbers|releasePhoneNumber|\.remove\s*\(/);
  assert.equal(subscriptionDoc.status, "canceled");
  assert.ok(subscriptionDoc.canceledAt instanceof Date);
  assert.equal(subscriptionDoc.saveCount, 1);
  assert.equal(barberDoc.subscriptionStatus, "canceled");
  assert.equal(barberDoc.saveCount, 1);
  assert.deepEqual(
    {
      twilioNumber: barberDoc.twilioNumber,
      assignedTwilioNumber: barberDoc.assignedTwilioNumber,
      interimTwilioNumber: barberDoc.interimTwilioNumber,
      twilioSid: barberDoc.twilioSid,
      forwardingEnabled: barberDoc.forwardingEnabled,
    },
    phoneSnapshot
  );
});

test("Stripe canceled subscription update preserves phone lifecycle fields", async (t) => {
  const originalSubscriptionFindOne = Subscription.findOne;
  const originalBarberFindOne = Barber.findOne;

  const subscriptionDoc = {
    status: "active",
    canceledAt: null,
    saveCount: 0,
    async save() {
      this.saveCount += 1;
    },
  };
  const barberDoc = {
    _id: "barber-2",
    subscriptionStatus: "active",
    twilioNumber: "+15555550200",
    assignedTwilioNumber: "+15555550200",
    interimTwilioNumber: "+15555550201",
    twilioSid: "PNupdated",
    forwardingEnabled: true,
    saveCount: 0,
    async save() {
      this.saveCount += 1;
    },
  };
  const phoneSnapshot = {
    twilioNumber: barberDoc.twilioNumber,
    assignedTwilioNumber: barberDoc.assignedTwilioNumber,
    interimTwilioNumber: barberDoc.interimTwilioNumber,
    twilioSid: barberDoc.twilioSid,
    forwardingEnabled: barberDoc.forwardingEnabled,
  };
  const sourceBefore = stripeWebhookSource();

  t.after(() => {
    Subscription.findOne = originalSubscriptionFindOne;
    Barber.findOne = originalBarberFindOne;
  });

  Subscription.findOne = async (filter) => {
    assert.deepEqual(filter, { stripeSubscriptionId: "sub_updated" });
    return subscriptionDoc;
  };
  Barber.findOne = (filter) => {
    assert.deepEqual(filter, { stripeSubscriptionId: "sub_updated" });
    return {
      select(selection) {
        assert.equal(selection, "_id expoPushToken subscriptionStatus");
        return Promise.resolve(barberDoc);
      },
    };
  };

  const result = await stripeWebhookModule.handleCanceledSubscription({
    subscription: { id: "sub_updated" },
    eventType: "customer.subscription.updated",
  });

  assert.deepEqual(result, {
    barberId: "barber-2",
    eventType: "customer.subscription.updated",
  });
  assert.doesNotMatch(sourceBefore, /from\s+["']twilio["']|incomingPhoneNumbers|releasePhoneNumber|\.remove\s*\(/);
  assert.equal(subscriptionDoc.status, "active");
  assert.equal(subscriptionDoc.saveCount, 0);
  assert.equal(barberDoc.subscriptionStatus, "canceled");
  assert.equal(barberDoc.saveCount, 1);
  assert.deepEqual(
    {
      twilioNumber: barberDoc.twilioNumber,
      assignedTwilioNumber: barberDoc.assignedTwilioNumber,
      interimTwilioNumber: barberDoc.interimTwilioNumber,
      twilioSid: barberDoc.twilioSid,
      forwardingEnabled: barberDoc.forwardingEnabled,
    },
    phoneSnapshot
  );
});
