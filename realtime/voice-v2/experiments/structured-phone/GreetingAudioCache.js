import { createHash } from 'node:crypto';

const aborted = () => Object.assign(Error('greeting_preparation_aborted'), { code: 'TTS_ABORTED' });
// Process-local, structured-greeting-only converted audio. No call identity,
// transcript, credentials, request diagnostics or playback objects are retained.
export class GreetingAudioCache {
  #entries = new Map(); #bytes = 0;
  constructor({ maxEntries = 32, maxBytes = 4194304, maxEntryBytes = 262144, ttlMs = 900000, preparationMs = 60000, now = () => performance.now() } = {}) {
    for (const n of [maxEntries, maxBytes, maxEntryBytes, ttlMs, preparationMs]) if (!Number.isSafeInteger(n) || n <= 0) throw TypeError('invalid_greeting_cache_limit');
    Object.assign(this, { maxEntries, maxBytes, maxEntryBytes, ttlMs, preparationMs, now });
  }
  get stats() { return Object.freeze({ entries: this.#entries.size, bytes: this.#bytes }); }
  #remove(key, entry) {
    if (this.#entries.get(key) !== entry) return;
    this.#entries.delete(key); if (entry.audio) this.#bytes -= entry.audio.length;
  }
  acquire({ businessId, language, text, configuration, signal, prepare, observe = () => {} }) {
    if (signal?.aborted) return Promise.reject(aborted());
    if (typeof businessId !== 'string' || !businessId || businessId.length > 128 || !['en', 'es'].includes(language)
      || typeof text !== 'string' || !text || text.length > 1024 || !configuration || typeof prepare !== 'function') return Promise.reject(TypeError('invalid_greeting_identity'));
    const fields = ['model', 'voice', 'endpoint', 'responseFormat', 'outputFormat', 'conversion'];
    if (Object.keys(configuration).length !== fields.length || fields.some(f => typeof configuration[f] !== 'string' || !configuration[f] || configuration[f].length > 256)) return Promise.reject(TypeError('invalid_greeting_configuration'));
    const key = createHash('sha256').update(JSON.stringify([businessId, language, text, fields.map(f => configuration[f])])).digest('hex');
    for (const [id, old] of this.#entries) if (old.audio && this.now() >= old.expires) this.#remove(id, old);
    let entry = this.#entries.get(key);
    const disposition = entry ? entry.audio ? 'HIT' : 'JOIN' : 'MISS';
    try { observe(disposition); } catch {}
    if (!entry) {
      while (this.#entries.size >= this.maxEntries) {
        const oldest = [...this.#entries].find(([, value]) => value.audio);
        if (!oldest) return Promise.reject(Object.assign(Error('greeting_cache_capacity'), { code: 'TTS_ADAPTER_ERROR' }));
        this.#remove(...oldest);
      }
      entry = { controller: new AbortController(), waiters: 0, audio: null };
      this.#entries.set(key, entry);
      let timeout, cancel;
      const deadline = new Promise((_, reject) => { timeout = setTimeout(() => {
        this.#remove(key, entry); entry.controller.abort(); reject(aborted());
      }, this.preparationMs); });
      const cancellation = new Promise((_, reject) => { cancel = () => reject(aborted()); entry.controller.signal.addEventListener('abort', cancel, { once: true }); });
      entry.promise = Promise.race([Promise.resolve().then(() => {
        if (entry.controller.signal.aborted) throw aborted();
        return prepare(entry.controller.signal);
      }), deadline, cancellation]).then(result => {
        if (entry.controller.signal.aborted) throw aborted();
        if (!Buffer.isBuffer(result?.audio) || !result.audio.length || result.format !== 'audio/pcmu') throw Object.assign(Error('invalid_greeting_audio'), { code: 'TTS_INVALID_AUDIO' });
        const audio = Buffer.from(result.audio);
        if (audio.length <= this.maxEntryBytes && audio.length <= this.maxBytes && this.#entries.get(key) === entry) {
          while (this.#bytes + audio.length > this.maxBytes) {
            const oldest = [...this.#entries].find(([, value]) => value.audio);
            if (!oldest) break;
            this.#remove(...oldest);
          }
          entry.audio = audio; entry.expires = this.now() + this.ttlMs; this.#bytes += audio.length;
        } else this.#remove(key, entry);
        // Only converted bytes survive. Per-call latency/provider metadata must
        // never be replayed as if a new HTTP request had occurred.
        return audio;
      }).catch(error => { this.#remove(key, entry); throw error; }).finally(() => { clearTimeout(timeout); entry.controller.signal.removeEventListener('abort', cancel); });
    }
    this.#entries.delete(key); this.#entries.set(key, entry); // LRU touch
    entry.waiters++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error, audio) => {
        if (done) return; done = true; signal?.removeEventListener('abort', cancel); entry.waiters--;
        if (!entry.audio && entry.waiters === 0) { this.#remove(key, entry); entry.controller.abort(); }
        if (error) reject(error); else resolve(Object.freeze({ audio: Buffer.from(audio), format: 'audio/pcmu', greetingCache: disposition }));
      };
      const cancel = () => finish(aborted());
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) return cancel();
      entry.promise.then(audio => finish(null, audio), error => finish(error));
    });
  }
}

export function greetingSynthesisConfiguration(adapter) {
  if (![adapter?.model, adapter?.voice, adapter?.endpoint].every(s => typeof s === 'string' && s.length > 0 && s.length <= 256)) return null;
  // These are the exact settings supported by the existing speech adapter.
  return Object.freeze({ model: adapter.model, voice: adapter.voice, endpoint: adapter.endpoint,
    responseFormat: 'wav', outputFormat: 'audio/pcmu', conversion: 'wav-pcm24k-mono-to-pcmu8k:v1' });
}
