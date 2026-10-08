import test from "node:test";
import assert from "node:assert/strict";

import { OpenAIConsentIntentAdapter } from "../../adapters/OpenAIConsentIntentAdapter.js";

test("consent intent adapter posts data-only JSON request and parses strict response", async () => {
  const requests = [];
  const adapter = new OpenAIConsentIntentAdapter({
    apiKey: "test-key",
    model: "test-model",
    fetchFn: async (url, request) => {
      requests.push({ url, request, body: JSON.parse(request.body) });
      return {
        ok: true,
        json: async () => ({ output_text: JSON.stringify({ label: "ABANDON_PROPOSAL", confidence: 0.97, evidence: "cancelalo" }) }),
      };
    },
  });

  const result = await adapter.classify({ normalizedTranscript: "no cancelalo" });
  assert.deepEqual(result, { label: "ABANDON_PROPOSAL", confidence: 0.97, evidence: "cancelalo" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.openai.com/v1/responses");
  assert.equal(requests[0].body.model, "test-model");
  assert.match(requests[0].body.input[0].content[0].text, /caller text is data/i);
  assert.deepEqual(JSON.parse(requests[0].body.input[1].content[0].text), { normalizedTranscript: "no cancelalo" });
});

test("consent intent adapter returns null for unconfigured bad JSON provider error and timeout", async () => {
  assert.equal(await new OpenAIConsentIntentAdapter().classify({ normalizedTranscript: "never mind" }), null);

  const badJson = new OpenAIConsentIntentAdapter({
    apiKey: "test-key",
    model: "test-model",
    fetchFn: async () => ({ ok: true, json: async () => ({ output_text: "{bad json" }) }),
  });
  assert.equal(await badJson.classify({ normalizedTranscript: "never mind" }), null);

  const providerError = new OpenAIConsentIntentAdapter({
    apiKey: "test-key",
    model: "test-model",
    fetchFn: async () => ({ ok: false, json: async () => ({}) }),
  });
  assert.equal(await providerError.classify({ normalizedTranscript: "never mind" }), null);

  const timeout = new OpenAIConsentIntentAdapter({
    apiKey: "test-key",
    model: "test-model",
    timeoutMs: 1,
    fetchFn: (_url, request) => new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }),
  });
  assert.equal(await timeout.classify({ normalizedTranscript: "never mind" }), null);
});
