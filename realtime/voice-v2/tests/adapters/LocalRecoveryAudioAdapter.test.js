import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { LocalRecoveryAudioAdapter, extractRecoveryPcmu } from "../../adapters/LocalRecoveryAudioAdapter.js";
import { localRecoveryFixture, recoveryWav } from "../helpers/localRecoveryFixture.js";

function withFmt(size, cbSize = 0) {
  const original = recoveryWav(); const fmt = Buffer.alloc(size);
  original.copy(fmt, 0, 20, 20 + Math.min(size, 16));
  if (size >= 18) fmt.writeUInt16LE(cbSize, 16);
  const header = Buffer.from(original.subarray(0, 20)); header.writeUInt32LE(size, 16);
  const wav = Buffer.concat([header, fmt, Buffer.alloc(size % 2), original.subarray(36)]);
  wav.writeUInt32LE(wav.length - 8, 4); return wav;
}

for (const size of [16, 18]) test(`valid ${size}-byte mu-law fmt with no extension returns only audio`, () => {
  assert.deepEqual(extractRecoveryPcmu(withFmt(size)), Buffer.alloc(160, 0xff));
});

const malformedFormats = [
  ["fmt size 17", () => withFmt(17)],
  ["fmt cbSize 65535", () => withFmt(18, 65535)],
  ["fmt cbSize 1", () => withFmt(18, 1)],
  ["fmt size greater than 18", () => withFmt(20)],
  ["fmt size less than 16", () => withFmt(15)],
  ["truncated fmt", () => { const wav = withFmt(18).subarray(0, 30); wav.writeUInt32LE(wav.length - 8, 4); return wav; }],
  ["fmt boundary beyond file", () => { const wav = withFmt(18); wav.writeUInt32LE(wav.length, 16); return wav; }],
  ["missing odd data padding", () => { const wav = recoveryWav("en", 161).subarray(0, 205); wav.writeUInt32LE(wav.length - 8, 4); return wav; }],
  ["truncated chunk header", () => { const wav = Buffer.concat([recoveryWav(), Buffer.alloc(4)]); wav.writeUInt32LE(wav.length - 8, 4); return wav; }],
];
for (const [label, make] of malformedFormats) test(`${label} rejected even with matching approval and cannot return audio`, () => {
  const wav = make(); assert.throws(() => extractRecoveryPcmu(wav));
  const hash = createHash("sha256").update(wav).digest("hex");
  const adapter = new LocalRecoveryAudioAdapter({ readAsset: (name) => name.endsWith(".json") ? Buffer.from(JSON.stringify({ en: hash, es: hash })) : wav });
  assert.throws(() => adapter.getAudio("en"), { code: "PRODUCTION_ASSETS_REQUIRED" });
  assert.throws(() => adapter.getAudio("es"), { code: "PRODUCTION_ASSETS_REQUIRED" });
});

for (const language of ["en", "es"]) test(`${language} approved fixture has mono 8 kHz mu-law data only`, () => {
  const clip = localRecoveryFixture().getAudio(language);
  assert.equal(clip.format, "audio/pcmu"); assert.equal(clip.language, language); assert.equal(clip.durationMs, 20);
  assert.equal(clip.audio.length, 160); assert.ok(clip.audio.every((byte) => byte === (language === "es" ? 0xfe : 0xff)));
});

test("production asset boundary remains fail-closed without reviewed recordings", () => {
  assert.throws(() => new LocalRecoveryAudioAdapter({ readAsset: () => { throw new Error("missing_test_asset"); } }).getAudio("en"), { code: "PRODUCTION_ASSETS_REQUIRED" });
  assert.throws(() => new LocalRecoveryAudioAdapter({ readAsset: () => { throw new Error("missing_test_asset"); } }).getAudio("es"), { code: "PRODUCTION_ASSETS_REQUIRED" });
});

test("format validation rejects PCM, stereo, wrong sample rate, truncation and metadata", () => {
  for (const mutate of [
    (wav) => wav.writeUInt16LE(1, 20), (wav) => wav.writeUInt16LE(2, 22),
    (wav) => wav.writeUInt32LE(24000, 24), (wav) => wav.writeUInt32LE(999999, 40),
    (wav) => wav.write("LIST", 36),
  ]) { const wav = recoveryWav(); mutate(wav); assert.throws(() => extractRecoveryPcmu(wav)); }
});

test("hash approval is required independently of compatible format", () => {
  assert.throws(() => localRecoveryFixture({ corrupt: true }).getAudio("en"), { code: "PRODUCTION_ASSETS_REQUIRED" });
  assert.throws(() => localRecoveryFixture({ incompatible: true }).getAudio("en"), { code: "PRODUCTION_ASSETS_REQUIRED" });
  assert.throws(() => new LocalRecoveryAudioAdapter({ readAsset: () => Buffer.from('{}') }).getAudio("es"), { code: "PRODUCTION_ASSETS_REQUIRED" });
});

test("one valid locale cannot mask a missing second reviewed recording", () => {
  const adapter = localRecoveryFixture(); const read = adapter.readAsset;
  adapter.readAsset = (name) => { if (name.includes(".es.")) throw new Error("missing Spanish recording"); return read(name); };
  assert.throws(() => adapter.getAudio("en"), { code: "PRODUCTION_ASSETS_REQUIRED" });
});

test("initialized recovery uses private validated copies without later filesystem reads", () => {
  const adapter = localRecoveryFixture(); adapter.prepare();
  adapter.readAsset = () => { throw new Error("must not read during recovery"); };
  const first = adapter.getAudio("en"); first.audio.fill(0);
  assert.ok(adapter.getAudio("en").audio.every((byte) => byte === 0xff));
  assert.ok(adapter.getAudio("es").audio.every((byte) => byte === 0xfe));
});

for (const language of ["en", "es"]) test(`${language} approved production recovery asset validates through default adapter`, () => {
  const clip = new LocalRecoveryAudioAdapter().getAudio(language);
  assert.equal(clip.format, "audio/pcmu"); assert.equal(clip.language, language);
  assert.ok(clip.durationMs >= 20 && clip.durationMs <= 15000); assert.equal(clip.audio.length, clip.durationMs * 8);
});
