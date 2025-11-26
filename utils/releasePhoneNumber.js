import dotenv from "dotenv";
dotenv.config();

import twilio from "twilio";
import Barber from "../models/Barber.js";

const client =
  process.env.USE_TWILIO_MOCK === "true"
    ? null
    : twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

export const releasePhoneNumber = async (barberId) => {
  try {
    const barber = await Barber.findById(barberId);
    if (!barber) throw new Error("Barber not found");
    if (!barber.twilioSid) throw new Error("No Twilio SID found for this barber");

    if (process.env.USE_TWILIO_MOCK === "true") {
      //  MOCK MODE
      console.log(`⚙️ Mock release for ${barber.twilioNumber}`);
      barber.twilioNumber = null;
      barber.twilioSid = null;
      await barber.save();
      return { released: true, mode: "mock" };
    }

    // REAL TWILIO MODE
    await client.incomingPhoneNumbers(barber.twilioSid).remove();

    barber.twilioNumber = null;
    barber.twilioSid = null;
    await barber.save();

    console.log(`Released Twilio number for ${barber.name}`);
    return { released: true, mode: "live" };
  } catch (error) {
    console.error("releasePhoneNumber error:", error.message);
    throw error;
  }
};
