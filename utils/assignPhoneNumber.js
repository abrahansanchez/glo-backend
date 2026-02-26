import dotenv from "dotenv";
import twilio from "twilio";
import Barber from "../models/Barber.js";

dotenv.config();

/**
 * Assign a Twilio number automatically to a barber.
 */
export const assignPhoneNumber = async (barberId) => {
  console.log(" assignPhoneNumber started");

  try {
    //  1. Check if mock mode is enabled FIRST
    if (process.env.USE_TWILIO_MOCK === "true") {
      console.log("⚙️ Using Mock Twilio Mode");

      const mockNumber = "+13105551234";
      const mockSid = "PNabc12345";

      const barber = await Barber.findById(barberId);
      if (!barber) throw new Error("Barber not found");

      barber.twilioNumber = mockNumber;
      barber.assignedTwilioNumber = mockNumber;
      barber.twilioSid = mockSid;
      await barber.save();

      console.log(`✅ Mock number assigned: ${mockNumber} (${mockSid})`);
      return { number: mockNumber, sid: mockSid };
    }

    const rawBaseUrl = String(process.env.APP_BASE_URL || "").trim();
    let parsedBaseUrl;
    try {
      parsedBaseUrl = new URL(rawBaseUrl);
      if (!/^https?:$/i.test(parsedBaseUrl.protocol)) {
        throw new Error("APP_BASE_URL must use http/https");
      }
    } catch {
      console.error("[CONFIG] APP_BASE_URL missing");
      const configError = new Error("APP_BASE_URL missing or invalid");
      configError.code = "BASE_URL_MISSING";
      configError.status = 500;
      throw configError;
    }
    const baseOrigin = parsedBaseUrl.origin;

    //  2. Only initialize Twilio client if NOT mock
    console.log("🔗 Connecting to real Twilio API...");
    const client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    // 3. Search for an available number
    const numbers = await client
      .availablePhoneNumbers(process.env.TWILIO_COUNTRY_CODE || "US")
      .local.list({
        areaCode: process.env.TWILIO_DEFAULT_AREA_CODE || "813",
        limit: 1,
      });

    if (!numbers.length) throw new Error("No available Twilio numbers found.");

    const numberToBuy = numbers[0].phoneNumber;

    // 4. Purchase number
    const purchase = await client.incomingPhoneNumbers.create({
      phoneNumber: numberToBuy,
      voiceUrl: `${baseOrigin}/api/voice/incoming`,
      smsUrl: `${baseOrigin}/api/sms/inbound`,
    });

    // 5. Save to barber record
    const barber = await Barber.findById(barberId);
    if (!barber) throw new Error("Barber not found");

    barber.twilioNumber = purchase.phoneNumber;
    barber.assignedTwilioNumber = purchase.phoneNumber;
    barber.twilioSid = purchase.sid;
    await barber.save();

    console.log(`Twilio number purchased: ${purchase.phoneNumber}`);
    return { number: purchase.phoneNumber, sid: purchase.sid };

  } catch (error) {
    console.error(" assignPhoneNumber error:", error.message);
    throw error;
  }
};
