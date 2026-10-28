import { extractPcm24kMonoFromWav, pcm24kToPcmu8k } from './pcm24kToPcmu8k.js';

// Same converter and three-sample alignment as the complete-buffer path.
// HTTP boundaries have no relationship to WAV chunks, samples or PCMU frames.
export class IncrementalWavPcmu {
  constructor({ onFrames, onDecodable = () => {} }) {
    Object.assign(this, { onFrames, onDecodable });
    this.parts = []; this.size = 0; this.dataStart = null; this.dataSize = null;
    this.convertedSourceBytes = 0; this.pending = Buffer.alloc(0); this.decoded = false;
    this.converted = [];
    this.pcmRemainder = Buffer.alloc(0); this.dataRead = 0;
  }
  async push(bytes) {
    this.parts.push(bytes); this.size += bytes.length;
    if (this.size > 32 * 1024 * 1024) throw invalid();
    let incoming = bytes;
    if (this.dataStart === null) {
      const wav = Buffer.concat(this.parts, this.size);
      if (wav.length < 12) return;
      if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw invalid();
      let offset = 12, format = false;
      while (offset + 8 <= wav.length) {
        const id = wav.toString('ascii', offset, offset + 4), length = wav.readUInt32LE(offset + 4), start = offset + 8;
        if (id === 'data') {
          if (!format) throw invalid();
          this.dataStart = start; this.dataSize = length === 0xffffffff ? Infinity : length; break;
        }
        if (length > 65536 || start + length > 65536) throw invalid();
        if (start + length > wav.length) return;
        if (id === 'fmt ') {
          if (format || length < 16 || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 2) !== 1
            || wav.readUInt32LE(start + 4) !== 24000 || wav.readUInt16LE(start + 12) !== 2 || wav.readUInt16LE(start + 14) !== 16) throw invalid();
          format = true;
        }
        offset = start + length + length % 2;
      }
      if (this.dataStart === null) return;
      incoming = wav.subarray(this.dataStart);
    }
    const data = incoming.subarray(0, Math.min(incoming.length, this.dataSize - this.dataRead));
    this.dataRead += data.length;
    const pcm = Buffer.concat([this.pcmRemainder, data]), aligned = Math.floor(pcm.length / 6) * 6;
    this.pcmRemainder = Buffer.from(pcm.subarray(aligned));
    if (aligned) {
      const audio = pcm24kToPcmu8k(pcm.subarray(0, aligned));
      this.convertedSourceBytes += aligned;
      this.converted.push(audio);
      if (!this.decoded) { this.decoded = true; this.onDecodable(); }
      this.pending = Buffer.concat([this.pending, audio]);
      await this.flush(false);
    }
  }
  async finish() {
    // Detect truncation, odd samples, unsupported final format and empty clips
    // before releasing the final short frame or allowing a playback mark.
    const complete = pcm24kToPcmu8k(extractPcm24kMonoFromWav(Buffer.concat(this.parts, this.size)));
    if (!this.decoded || !complete.equals(Buffer.concat(this.converted))) throw invalid();
    await this.flush(true);
    return complete;
  }
  async flush(final) {
    const length = final ? this.pending.length : Math.floor(this.pending.length / 160) * 160;
    if (!length) return;
    const frames = [];
    for (let offset = 0; offset < length; offset += 160) frames.push(Buffer.from(this.pending.subarray(offset, Math.min(offset + 160, length))));
    this.pending = Buffer.from(this.pending.subarray(length));
    await this.onFrames(frames);
  }
}
const invalid = () => Object.assign(Error('invalid_incremental_wav'), { code: 'TTS_INVALID_AUDIO' });
