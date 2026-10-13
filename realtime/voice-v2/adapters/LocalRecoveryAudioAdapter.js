import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const root = new URL("../assets/", import.meta.url);

export class LocalRecoveryAudioAdapter {
  #clips = null;
  #unavailable = false;
  constructor({ readAsset = (name) => readFileSync(new URL(name, root)) } = {}) { this.readAsset = readAsset; }
  prepare() {
    if (this.#clips) return;
    if (this.#unavailable) throw Object.assign(new Error("local_recovery_asset_unavailable"), { code: "PRODUCTION_ASSETS_REQUIRED" });
    try {
      const approval = JSON.parse(this.readAsset("terminal-recovery.approved.json").toString("utf8"));
      if (!approval || Array.isArray(approval) || Object.keys(approval).length !== 2
        || Object.keys(approval).some((key) => !["en", "es"].includes(key))) throw new Error("unapproved");
      const clips = {};
      // A valid English recording alone must not mask an unusable Spanish deployment.
      for (const locale of ["en", "es"]) {
        const expected = approval[locale];
        if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("unapproved");
        const wav = Buffer.from(this.readAsset(`terminal-recovery.${locale}.wav`));
        if (createHash("sha256").update(wav).digest("hex") !== expected) throw new Error("hash_mismatch");
        clips[locale] = extractRecoveryPcmu(wav);
      }
      this.#clips = Object.freeze(clips);
    } catch {
      this.#unavailable = true;
      throw Object.assign(new Error("local_recovery_asset_unavailable"), { code: "PRODUCTION_ASSETS_REQUIRED" });
    }
  }
  getAudio(language) {
    this.prepare();
    const selected = language === "es" ? "es" : "en";
    const audio = Buffer.from(this.#clips[selected]);
    return Object.freeze({ audio, format: "audio/pcmu", language: selected, durationMs: audio.length / 8 });
  }
}

export function extractRecoveryPcmu(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 44 || wav.length > 120256
    || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE"
    || wav.readUInt32LE(4) + 8 !== wav.length) throw new TypeError("invalid_recovery_wav");
  let format = false; let audio = null;
  for (let offset = 12; offset < wav.length;) {
    if (offset + 8 > wav.length) throw new TypeError("invalid_recovery_chunk");
    const kind = wav.toString("ascii", offset, offset + 4); const size = wav.readUInt32LE(offset + 4); const start = offset + 8;
    if (start + size > wav.length) throw new TypeError("truncated_recovery_chunk");
    if (kind === "fmt ") {
      if (format || ![16, 18].includes(size) || (size === 18 && wav.readUInt16LE(start + 16) !== 0)
        || wav.readUInt16LE(start) !== 7 || wav.readUInt16LE(start + 2) !== 1
        || wav.readUInt32LE(start + 4) !== 8000 || wav.readUInt32LE(start + 8) !== 8000
        || wav.readUInt16LE(start + 12) !== 1 || wav.readUInt16LE(start + 14) !== 8) throw new TypeError("incompatible_recovery_format");
      format = true;
    } else if (kind === "data") {
      if (audio || size < 160 || size > 120000) throw new TypeError("invalid_recovery_audio");
      audio = Buffer.from(wav.subarray(start, start + size));
    } else if (kind !== "fact" || size !== 4) throw new TypeError("recovery_metadata_not_allowed");
    offset = start + size + (size % 2);
    if (offset > wav.length) throw new TypeError("invalid_recovery_padding");
  }
  if (!format || !audio) throw new TypeError("missing_recovery_audio");
  return audio;
}
