export class FakeVoiceTransportAdapter {
  #sequence = 0;
  constructor(playbackRegistry) { this.playbackRegistry = playbackRegistry; this.submissions = []; }
  submit({ responseId, proposalVersion, audioBytes, markId = `fake-mark-${++this.#sequence}` }) { this.playbackRegistry.register({ markId, responseId, proposalVersion }); if (audioBytes > 0) { this.playbackRegistry.submit(markId, audioBytes); this.submissions.push(markId); } return markId; }
  acknowledge(markId) { return this.playbackRegistry.acknowledge(markId); }
  interrupt(markId) { return this.playbackRegistry.interrupt(markId); }
  clear(markId) { return this.playbackRegistry.clear(markId); }
}
