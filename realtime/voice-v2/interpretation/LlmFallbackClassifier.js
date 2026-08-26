export class LlmFallbackClassifier {
  constructor({ classify } = {}) {
    this.classifyTurn = typeof classify === "function" ? classify : null;
  }

  async classify(input) {
    if (!this.classifyTurn) return null;
    return this.classifyTurn(Object.freeze({ ...input }));
  }
}
