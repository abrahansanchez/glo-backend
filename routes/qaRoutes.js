import express from "express";
import bcrypt from "bcryptjs";
import Barber from "../models/Barber.js";
import Subscription from "../models/Subscription.js";

const router = express.Router();
const BCRYPT_SALT_ROUNDS = 10;
const QA_PASSWORD = "Test12345!";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const qaAccounts = [
  { email: "qa_trialing@glo.test", status: "trialing", lastName: "Trialing" },
  { email: "qa_active@glo.test", status: "active", lastName: "Active" },
  {
    email: "qa_past_due_grace@glo.test",
    status: "past_due",
    lastName: "PastDueGrace",
    gracePeriodEndsAt: () => new Date(Date.now() + SEVEN_DAYS_MS),
  },
  {
    email: "qa_past_due_blocked@glo.test",
    status: "past_due",
    lastName: "PastDueBlocked",
    gracePeriodEndsAt: () => new Date(Date.now() - SEVEN_DAYS_MS),
  },
  {
    email: "qa_incomplete@glo.test",
    status: "incomplete",
    lastName: "Incomplete",
  },
  { email: "qa_nosub@glo.test", status: "none", lastName: "NoSub" },
];

router.post("/seed-subscriptions", async (req, res) => {
  if (process.env.ENABLE_QA_ROUTES !== "true") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const providedSecret = req.header("x-qa-secret");
  if (!providedSecret || providedSecret !== process.env.QA_SEED_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    const hashedPassword = await bcrypt.hash(QA_PASSWORD, BCRYPT_SALT_ROUNDS);
    const accounts = [];

    for (const account of qaAccounts) {
      // NOTE: `subscriptionStatus` is kept in sync for convenience; Subscription is source of truth.
      const barber = await Barber.findOneAndUpdate(
        { email: account.email },
        {
          $set: {
            email: account.email,
            password: hashedPassword,
            name: `QA ${account.lastName}`,
            firstName: "QA",
            lastName: account.lastName,
            phone: "+15550000000",
            subscriptionStatus:
              account.email === "qa_nosub@glo.test" ? "none" : account.status,
          },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );

      if (account.email !== "qa_nosub@glo.test") {
        const stripeSuffix = account.email
          .split("@")[0]
          .replace(/[^a-z0-9]/gi, "_")
          .toLowerCase();

        const subscriptionUpdate = {
          barber: barber._id,
          status: account.status,
          stripeCustomerId: `cus_test_${stripeSuffix}`,
          stripeSubscriptionId: `sub_test_${stripeSuffix}`,
        };

        if (account.gracePeriodEndsAt) {
          subscriptionUpdate.gracePeriodEndsAt = account.gracePeriodEndsAt();
        } else {
          subscriptionUpdate.gracePeriodEndsAt = null;
        }

        await Subscription.findOneAndUpdate(
          { barber: barber._id },
          { $set: subscriptionUpdate },
          { new: true, upsert: true, setDefaultsOnInsert: true }
        );
      } else {
        await Subscription.deleteMany({ barber: barber._id });
      }

      accounts.push({
        email: account.email,
        status: account.status,
        hasSubscription: account.email !== "qa_nosub@glo.test",
      });
    }

    return res.json({
      message: "QA accounts seeded",
      accounts,
    });
  } catch (error) {
    console.error("[QA seed] failed:", error);
    return res.status(500).json({ error: "Failed to seed QA accounts" });
  }
});

export default router;
