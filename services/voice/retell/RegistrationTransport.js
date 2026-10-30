const endpoint = 'https://api.retellai.com/v2/register-phone-call';
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const safeError = code => Object.assign(new Error(code), { code });

// Explicit opt-in only; no environment reads or SDK retry machinery. Native fetch
// follows no redirects here. Neither request nor response envelopes are logged.
export function createRetellRegistrationTransport({ enabled = false, apiKey, http = globalThis.fetch, deadlineMs = 3000 } = {}) {
  if (enabled !== true) return Object.freeze({ registerPhoneCall: async () => { throw safeError('RETELL_TRANSPORT_DISABLED'); } });
  if (typeof apiKey !== 'string' || !apiKey.length || /[\r\n]/.test(apiKey) || typeof http !== 'function'
    || !Number.isInteger(deadlineMs) || deadlineMs < 10 || deadlineMs > 10000) throw safeError('RETELL_TRANSPORT_CONFIGURATION_INVALID');
  return Object.freeze({
    async registerPhoneCall(payload, { signal } = {}) {
      if (!payload || Object.keys(payload).sort().join(',') !== 'agent_id,agent_version,direction,metadata'
        || !identifier(payload.agent_id) || !Number.isSafeInteger(payload.agent_version) || payload.agent_version < 0
        || payload.direction !== 'inbound' || !payload.metadata
        || Object.keys(payload.metadata).join(',') !== 'glo_registration_attempt'
        || !/^[a-f\d-]{36}$/.test(payload.metadata.glo_registration_attempt || '')) throw safeError('RETELL_REGISTRATION_REQUEST_INVALID');
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      let timer, reader;
      try {
        if (signal?.aborted) throw safeError('RETELL_REGISTRATION_ABORTED');
        return await Promise.race([
          (async () => {
            const response = await http(endpoint, { method: 'POST', redirect: 'error', signal: controller.signal,
              headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
            if (controller.signal.aborted) throw safeError('RETELL_REGISTRATION_ABORTED');
            if (response.status !== 201 && response.status !== 200) throw safeError('RETELL_REGISTRATION_HTTP_ERROR');
            if (!response.body?.getReader) throw safeError('RETELL_REGISTRATION_RESPONSE_INVALID');
            reader = response.body.getReader();
            const chunks = []; let size = 0;
            for (;;) {
              const { done, value } = await reader.read();
              if (controller.signal.aborted) throw safeError('RETELL_REGISTRATION_ABORTED');
              if (done) break;
              size += value.byteLength;
              if (size > 65536) throw safeError('RETELL_REGISTRATION_RESPONSE_INVALID');
              chunks.push(Buffer.from(value));
            }
            const r = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (r?.call_type !== 'phone_call' || !identifier(r.call_id) || r.agent_id !== payload.agent_id
              || r.agent_version !== payload.agent_version || r.call_status !== 'registered') throw safeError('RETELL_REGISTRATION_RESPONSE_INVALID');
            // Only validated identity leaves the transport, never arbitrary fields.
            return Object.freeze({ call_id: r.call_id, agent_id: r.agent_id, agent_version: r.agent_version, call_status: r.call_status });
          })(),
          new Promise((_, reject) => {
            controller.signal.addEventListener('abort', () => reject(safeError('RETELL_REGISTRATION_ABORTED')), { once: true });
            timer = setTimeout(() => { controller.abort(); }, deadlineMs);
          }),
        ]);
      } catch { throw safeError('RETELL_REGISTRATION_OUTCOME_UNKNOWN'); }
      finally {
        clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort();
        // A cancellation failure must not expose its arbitrary error or mask ours.
        try { void reader?.cancel().catch(() => {}); } catch {}
      }
    },
  });
}
