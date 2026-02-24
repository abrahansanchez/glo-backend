import twilio from "twilio";
import Barber from "../models/Barber.js";
import {
  clearActiveCall,
  clearActiveCallBySid,
  getActiveCall,
  setActiveCall,
} from "../utils/voice/activeCallStore.js";
import { sendExpoPush } from "../utils/push/expoPush.js";

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

const getAiStreamTwimlString = ({ req, barberId, barberName }) => {
  const initialPrompt = buildInitialPrompt(barberName);
  return buildAiStreamTwiml({ req, barberId, initialPrompt }).toString();
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
    const callSid = req.body.CallSid || "";
    const from = req.body.From || "";
    const to = req.body.To || req.body.Called || "";
    const ringTimeoutSeconds = Number(process.env.RING_TIMEOUT_SECONDS || 12);
    const fallbackUrl = `${getBaseHttpsUrl(req)}/api/voice/dial-fallback`;

    setActiveCall({
      barberId,
      callSid,
      from,
      to,
      createdAt: Date.now(),
    });

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
    clearActiveCallBySid(callSid);

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
    clearActiveCall(barberId);

    if (dialStatus === "no-answer") {
      if (!barber.expoPushToken) {
        console.log(`[PUSH_MISSED_CALL] skipped/no-token barberId=${barberId}`);
      } else {
        void (async () => {
          try {
            const pushPromise = sendExpoPush(
              barber.expoPushToken,
              "Missed call",
              `Missed call from ${from || "unknown number"}. AI handled it.`,
              {
                type: "MISSED_CALL",
                callSid,
                from: from || "",
                to: to || "",
                barberId,
              }
            );

            const timeoutPromise = new Promise((resolve) =>
              setTimeout(() => resolve({ ok: false, timeout: true }), 1500)
            );

            const result = await Promise.race([pushPromise, timeoutPromise]);
            if (result?.ok) {
              console.log(`[PUSH_MISSED_CALL] sent barberId=${barberId} callSid=${callSid}`);
            } else if (result?.timeout) {
              console.log(`[PUSH_MISSED_CALL] sent barberId=${barberId} callSid=${callSid} (timed)`);
            } else {
              console.log(`[PUSH_MISSED_CALL] error barberId=${barberId} callSid=${callSid}`);
            }
          } catch (err) {
            console.error(
              `[PUSH_MISSED_CALL] error barberId=${barberId} callSid=${callSid}`,
              err?.message || err
            );
          }
        })();
      }
    }

    const twimlOutput = getAiStreamTwimlString({
      req,
      barberId,
      barberName: barber.name,
    });

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

export const handleAiTakeover = async (req, res) => {
  try {
    const barberId = req.user?.id || req.user?._id?.toString();
    if (!barberId) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    const activeCall = getActiveCall(barberId);
    if (!activeCall) {
      return res.status(404).json({ error: "NO_ACTIVE_CALL" });
    }

    const barber = await Barber.findById(barberId).select("name");
    if (!barber) {
      return res.status(404).json({ error: "BARBER_NOT_FOUND" });
    }

    const twiml = getAiStreamTwimlString({
      req,
      barberId: String(barberId),
      barberName: barber.name,
    });

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      return res.status(500).json({
        error: "TWILIO_CONFIG_MISSING",
        message: "Missing Twilio env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN",
      });
    }

    const client = twilio(accountSid, authToken);
    await client.calls(activeCall.callSid).update({ twiml });

    clearActiveCall(String(barberId));
    console.log(
      `[AI_TAKEOVER] barberId=${String(barberId)} callSid=${activeCall.callSid} redirected-to-ai`
    );

    return res.status(200).json({
      success: true,
      callSid: activeCall.callSid,
      redirectedTo: "ai",
    });
  } catch (error) {
    console.error("[AI_TAKEOVER] error:", error);
    return res.status(500).json({
      error: "AI_TAKEOVER_FAILED",
      message: error.message || "Failed to redirect call to AI.",
    });
  }
};

/*
Manual Test Plan (AI Takeover)
1. Place an inbound call to the Twilio number mapped to a barber.
2. Keep the mobile app open while the call is still ringing the client identity.
3. Trigger POST /api/voice/ai-takeover as that authenticated barber ("Let AI Handle").
4. Confirm AI media stream starts immediately (no waiting for Dial timeout).
5. Confirm server log includes:
   [AI_TAKEOVER] barberId=... callSid=... redirected-to-ai
*/
