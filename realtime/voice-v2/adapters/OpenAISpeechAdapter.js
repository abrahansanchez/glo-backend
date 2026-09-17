import { extractPcm24kMonoFromWav, pcm24kToPcmu8k, speechAudioFormat } from "../audio/pcm24kToPcmu8k.js";

const DEFAULT_ENDPOINT = "https://api.openai.com/v1/audio/speech";

export class OpenAISpeechAdapter {
  constructor({
    apiKey,
    model = "gpt-4o-mini-tts",
    voice = "alloy",
    endpoint = DEFAULT_ENDPOINT,
    fetchFn = globalThis.fetch,
    monotonicNow = () => performance.now(),
  } = {}) {
    if (!apiKey) throw new TypeError("openai_api_key_required");
    if (typeof fetchFn !== "function") throw new TypeError("fetch_required");
    this.apiKey = apiKey;
    this.model = model;
    this.voice = voice;
    this.endpoint = endpoint;
    this.fetchFn = fetchFn;
    this.monotonicNow = monotonicNow;
  }

  async synthesize({ input, language = "en", signal } = {}) {
    if (typeof input !== "string" || !input.trim()) throw new TypeError("speech_input_required");
    const startedAt = this.monotonicNow();
    let response;
    try {
      response = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          voice: this.voice,
          input,
          response_format: "wav",
        }),
        signal,
      });
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw typedError("speech_request_aborted", "TTS_ABORTED");
      throw typedError("speech_provider_request_failed", "TTS_ADAPTER_ERROR", error);
    }

    if (!response?.ok) throw typedError(`speech_provider_http_${response?.status || "unknown"}`, "TTS_ADAPTER_ERROR");
    const sourceAudio = Buffer.from(await response.arrayBuffer());
    if (!sourceAudio.length) throw typedError("speech_provider_empty_audio", "TTS_EMPTY_AUDIO");
    const audio = pcm24kToPcmu8k(extractPcm24kMonoFromWav(sourceAudio));
    const completedAt = this.monotonicNow();
    const latencyMs = Math.max(0, completedAt - startedAt);

    return Object.freeze({
      audio,
      format: speechAudioFormat.target,
      sourceFormat: speechAudioFormat.source,
      sourceSampleRate: speechAudioFormat.sourceSampleRate,
      targetSampleRate: speechAudioFormat.targetSampleRate,
      language: language === "es" ? "es" : "en",
      inputCharacterCount: input.length,
      firstAudioLatencyMs: latencyMs,
      totalLatencyMs: latencyMs,
      durationMs: (audio.length / speechAudioFormat.targetSampleRate) * 1000,
    });
  }
}

function typedError(message, code, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}
