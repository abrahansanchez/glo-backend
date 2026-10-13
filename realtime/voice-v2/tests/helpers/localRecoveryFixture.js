import { createHash } from "node:crypto";
import { LocalRecoveryAudioAdapter } from "../../adapters/LocalRecoveryAudioAdapter.js";

export function recoveryWav(language = "en", payloadBytes = 160) {
  const bytes = Buffer.alloc(44 + payloadBytes + (payloadBytes % 2), language === "es" ? 0xfe : 0xff);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVE", 8);
  bytes.write("fmt ", 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(7, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(8000, 28); bytes.writeUInt16LE(1, 32); bytes.writeUInt16LE(8, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(payloadBytes, 40);
  return bytes;
}

export function localRecoveryFixture({ missing = false, corrupt = false, incompatible = false, payloadBytes = 160 } = {}) {
  const en = recoveryWav("en", payloadBytes); const es = recoveryWav("es", payloadBytes);
  if (incompatible) en.writeUInt32LE(24000, 24);
  const hashes = { en: createHash("sha256").update(en).digest("hex"), es: createHash("sha256").update(es).digest("hex") };
  return new LocalRecoveryAudioAdapter({ readAsset(name) {
    if (missing) throw new Error("missing_test_asset");
    if (name.endsWith(".json")) return Buffer.from(JSON.stringify(hashes));
    const wav = name.includes(".es.") ? es : en;
    return corrupt ? Buffer.alloc(44) : wav;
  } });
}
