// utils/audio/audioUtils.js
import { spawnSync } from "child_process";
import ulaw from "mulaw-js";

// Convert µ-law → PCM16
export const mulawToPCM16 = (base64) => {
  const ulawBuf = Buffer.from(base64, "base64");
  return Buffer.from(ulaw.mulawToLinear(ulawBuf));
};

// Convert PCM16 → µ-law
export const pcm16ToMulaw = (pcm) => {
  return Buffer.from(ulaw.linearToMulaw(pcm));
};

// Resample PCM using sox (installed on Render)
export const resamplePCM16 = (pcm, fromRate, toRate) => {
  const sox = spawnSync("sox", [
    "-t", "raw",
    "-r", String(fromRate),
    "-e", "signed-integer",
    "-b", "16",
    "-c", "1",
    "-",

    "-t", "raw",
    "-r", String(toRate),
    "-e", "signed-integer",
    "-b", "16",
    "-c", "1",
    "-"
  ], { input: pcm });

  return sox.stdout;
};
