export class FakeResponseGenerator {
  #sequence = 0;
  constructor({ scripts = [] } = {}) { this.scripts = [...scripts]; }
  async generate(plan) {
    const script = this.scripts.shift() || {};
    if (script.delay) await script.delay;
    if (script.error) throw script.error;
    return Object.freeze({ responseId: script.responseId || `fake-response-${++this.#sequence}`, transcript: script.transcript || defaultTranscript(plan), audioBytes: script.audioBytes ?? 2048 });
  }
}
function defaultTranscript(plan) { const f = plan.expectedFacts; return `${f.name}, should I confirm your ${f.service} for ${f.date} at ${f.time}?`; }
