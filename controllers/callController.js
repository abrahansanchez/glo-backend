import twilio from "twilio";
import Barber from "../models/Barber.js";

const VoiceResponse = twilio.twiml.VoiceResponse;

const getBaseHttpsUrl = (req) => {
  const rawBase = process.env.APP_BASE_URL || req.headers.host || "";
  const normalized = rawBase.replace(/(^\w+:|^)\/\//, "").replace(/\/$/, "");
  return `https://${normalized}`;
};

const getMediaWebsocketUrl = (req) => {
  const rawBase = process.env.APP_BASE_URL || req.headers.host || "";
  const normalized = rawBase.replace(/(^\w+:|^)\/\//, "").replace(/\/$/, "");
  return `wss://${normalized}/ws/media`;
};

const buildInitialPrompt = (barberName) =>
  `You are Glo, the AI receptionist for ${barberName}.\n` +
  `When you answer:\n` +
  `- Say: "Thanks for calling Glo. This is ${barberName}'s AI receptionist. How can I help you today?"\n` +
  `- Be natural and brief (1 sentence + a question).\n` +
  `- NEVER invent dates or times.\n` +
  `- If booking: require BOTH date and time, repeat back EXACTLY, then confirm YES before finalizing.\n`;

const buildAiStreamTwiml = ({ req, barberId, initialPrompt }) => {
  const wsUrl = getMediaWebsocketUrl(req);
  const response = new VoiceResponse();
  const connect = response.connect();
  const stream = connect.stream({
    url: wsUrl,
    track: "inbound_track",
  });

  stream.parameter({ name: "barberId", value: String(barberId) });
  stream.parameter({ name: "initialPrompt", value: initialPrompt });

  return response;
};

export const handleIncomingCall = async (req, res) => {
  try {
    console.log("[INCOMING] Incoming Twilio Call (RAW):", req.body);

    const called = req.body.Called || req.body.To;
    const cleanNumber = called ? called.trim() : null;

    console.log("[INCOMING] normalized called number:", cleanNumber);

    const barber = await Barber.findOne({ twilioNumber: cleanNumber });

    if (!barber) {
      console.log("[INCOMING] no barber found for number:", cleanNumber);
      const twiml = new VoiceResponse();
      twiml.say("Sorry, this number is not assigned.");
      return res.type("text/xml").send(twiml.toString());
    }

    const barberId = barber._id.toString();
    const ringTimeoutSeconds = Number(process.env.RING_TIMEOUT_SECONDS || 12);
    const fallbackUrl = `${getBaseHttpsUrl(req)}/api/voice/dial-fallback`;

    console.log("[INCOMING] matched barberId:", barberId);
    console.log("[INCOMING] dialing client identity:", barberId);
    console.log("[INCOMING] ring timeout:", ringTimeoutSeconds);

    const response = new VoiceResponse();
    const dial = response.dial({
      timeout: ringTimeoutSeconds,
      action: fallbackUrl,
      method: "POST",
    });
    dial.client(barberId);

    const twimlOutput = response.toString();
    console.log("[INCOMING] sending TwiML:\n", twimlOutput);

    return res.type("text/xml").send(twimlOutput);
  } catch (error) {
    console.error("Error in handleIncomingCall:", error);

    const fallback = new VoiceResponse();
    fallback.say("We are experiencing issues. Please try again later.");
    return res.type("text/xml").send(fallback.toString());
  }
};

export const handleDialFallback = async (req, res) => {
  try {
    const dialStatusRaw = req.body.DialCallStatus || "";
    const dialStatus = String(dialStatusRaw).toLowerCase();
    const callSid = req.body.CallSid || "";
    const to = req.body.To || "";
    const from = req.body.From || "";

    console.log("[DIAL_FALLBACK] HIT");
    console.log("[DIAL_FALLBACK] DialCallStatus:", dialStatusRaw);
    console.log("[DIAL_FALLBACK] CallSid:", callSid);
    console.log("[DIAL_FALLBACK] To/From:", { to, from });

    const twiml = new VoiceResponse();
    if (dialStatus === "completed") {
      twiml.hangup();
      const twimlOutput = twiml.toString();
      console.log("[DIAL_FALLBACK] completed; hanging up. TwiML:\n", twimlOutput);
      return res.type("text/xml").send(twimlOutput);
    }

    const cleanNumber = to ? String(to).trim() : null;
    const barber = cleanNumber ? await Barber.findOne({ twilioNumber: cleanNumber }) : null;

    if (!barber) {
      twiml.say("Sorry, this number is not assigned.");
      const twimlOutput = twiml.toString();
      console.log("[DIAL_FALLBACK] no barber match; TwiML:\n", twimlOutput);
      return res.type("text/xml").send(twimlOutput);
    }

    const barberId = barber._id.toString();
    const initialPrompt = buildInitialPrompt(barber.name);
    const aiTwiml = buildAiStreamTwiml({ req, barberId, initialPrompt });
    const twimlOutput = aiTwiml.toString();

    console.log("[DIAL_FALLBACK] falling back to AI stream");
    console.log("[DIAL_FALLBACK] TwiML:\n", twimlOutput);

    return res.type("text/xml").send(twimlOutput);
  } catch (error) {
    console.error("Error in handleDialFallback:", error);

    const fallback = new VoiceResponse();
    fallback.say("We are experiencing issues. Please try again later.");
    return res.type("text/xml").send(fallback.toString());
  }
};
