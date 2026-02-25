import mongoose from "mongoose";
import Barber from "./Barber.js";
import { sendExpoPush } from "../utils/push/expoPush.js";

const voicemailSchema = new mongoose.Schema(
  {
    barberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Barber",
      required: true,
      index: true,
    },
    callerNumber: {
      type: String,
      required: true,
    },
    calledNumber: {
      type: String,
    },
    recordingUrl: {
      type: String,
      required: true,
    },
    transcriptionText: {
      type: String,
      default: null,
    },
    callSid: {
      type: String,
      index: true,
    },
    durationSeconds: {
      type: Number,
      default: null,
    },
    status: {
      type: String,
      enum: ["new", "listened", "archived"],
      default: "new",
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

voicemailSchema.post("save", function postVoicemailSave(doc) {
  const statusNow = String(doc.status || "").toLowerCase();
  const shouldNotify = this.isNew || (this.isModified("status") && statusNow === "new");
  if (!shouldNotify) return;

  void (async () => {
    try {
      const barberId = String(doc.barberId || "");
      const voicemailId = String(doc._id || "");
      const from = String(doc.callerNumber || "").trim();
      const barber = await Barber.findById(doc.barberId).select("expoPushToken");
      const token = barber?.expoPushToken || null;
      if (!token) {
        console.log(`[PUSH_VOICEMAIL] skipped/no-token barberId=${barberId}`);
        return;
      }

      await sendExpoPush(
        token,
        "New voicemail",
        `New voicemail from ${from || "unknown number"}. Tap to listen.`,
        {
          type: "NEW_VOICEMAIL",
          voicemailId,
          from: from || "",
          barberId,
        }
      );
      console.log(`[PUSH_VOICEMAIL] sent barberId=${barberId} voicemailId=${voicemailId}`);
    } catch (error) {
      console.error("[PUSH_VOICEMAIL] error:", error?.message || error);
    }
  })();
});

const Voicemail = mongoose.model("Voicemail", voicemailSchema);

export default Voicemail;
