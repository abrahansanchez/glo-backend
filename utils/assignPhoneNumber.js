import dotenv from "dotenv";
import twilio from "twilio";
import Barber from "../models/Barber.js";
import { getAppBaseUrl } from "./config.js";

dotenv.config();

const normalizeTarget = (value) =>
  String(value || "primary").trim().toLowerCase() === "interim" ? "interim" : "primary";

const saveAssignedNumber = async ({ barberId, number, sid, target }) => {
  const barber = await Barber.findById(barberId);
  if (!barber) throw new Error("Barber not found");

  if (target === "interim") {
    barber.interimTwilioNumber = number;
  } else {
    barber.twilioNumber = number;
    barber.assignedTwilioNumber = number;
    barber.twilioSid = sid;
  }
  await barber.save();
};

/**
 * Assign a Twilio number automatically to a barber.
 */
export const assignPhoneNumber = async (barberId, options = {}) => {
  const target = normalizeTarget(options?.target);
  console.log(`[TWILIO_ASSIGN_ATTEMPT] barberId=${String(barberId)} target=${target}`);

  try {
    if (process.env.USE_TWILIO_MOCK === "true") {
      const mockNumber = "+13105551234";
      const mockSid = "PNabc12345";

      await saveAssignedNumber({
        barberId,
        number: mockNumber,
        sid: mockSid,
        target,
      });

      console.log(
        `[TWILIO_ASSIGN_SUCCESS] barberId=${String(barberId)} target=${target} number=${mockNumber} sid=${mockSid}`
      );
      return { number: mockNumber, sid: mockSid };
    }

    let baseOrigin;
    try {
      baseOrigin = getAppBaseUrl();
    } catch {
      const configError = new Error("APP_BASE_URL missing or invalid");
      configError.code = "BASE_URL_MISSING";
      configError.status = 500;
      throw configError;
    }

    const client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    const numbers = await client
      .availablePhoneNumbers(process.env.TWILIO_COUNTRY_CODE || "US")
      .local.list({
        areaCode: process.env.TWILIO_DEFAULT_AREA_CODE || "813",
        limit: 1,
      });

    if (!numbers.length) throw new Error("No available Twilio numbers found.");

    const purchase = await client.incomingPhoneNumbers.create({
      phoneNumber: numbers[0].phoneNumber,
      voiceUrl: `${baseOrigin}/api/voice/incoming`,
      smsUrl: `${baseOrigin}/api/sms/inbound`,
    });

    await saveAssignedNumber({
      barberId,
      number: purchase.phoneNumber,
      sid: purchase.sid,
      target,
    });

    console.log(
      `[TWILIO_ASSIGN_SUCCESS] barberId=${String(barberId)} target=${target} number=${purchase.phoneNumber} sid=${purchase.sid}`
    );
    return { number: purchase.phoneNumber, sid: purchase.sid };
  } catch (error) {
    console.error(
      `[TWILIO_ASSIGN_FAILED] barberId=${String(barberId)} target=${target} reason=${String(error?.message || error)}`
    );
    throw error;
  }
};
