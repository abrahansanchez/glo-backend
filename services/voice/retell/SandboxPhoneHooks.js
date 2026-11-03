import twilio from 'twilio';

const diagnostic = (req, stage, reasonCode) => {
  const sid = req.body?.CallSid;
  try { console.info({ event: 'RETELL_SANDBOX_HANDOFF', callSid: typeof sid === 'string' && /^CA[a-f\d]{32}$/.test(sid) ? sid : null, stage, reasonCode }); } catch {}
};

// Shared by the existing phone controllers/router and credential-free HTTP tests.
// Default absence is a no-op, not an environment-controlled route change.
export async function observeSandboxIncoming(req, businessId) {
  try { await req.app?.locals?.retellSandbox?.observeIncoming(req, businessId); }
  catch { diagnostic(req, 'INCOMING_OBSERVATION', 'OBSERVATION_EXCEPTION'); }
}
export async function handleSandboxFallback(req, res) {
  const handoff = req.app?.locals?.retellSandbox;
  if (!handoff) { diagnostic(req, 'FALLBACK_SELECTION', 'SANDBOX_NOT_INSTALLED'); return false; }
  try {
    const result = await handoff.fallback(req);
    if (!result) return false;
    res.status(result.status).type('text/xml').send(result.twiml); return true;
  } catch {
    diagnostic(req, 'FALLBACK_RESULT', 'HANDOFF_HOOK_EXCEPTION');
    const r = new twilio.twiml.VoiceResponse(); r.hangup();
    res.status(503).type('text/xml').send(r.toString()); return true;
  }
}
export async function handleSandboxWebhook(req, res, kind) {
  const handoff = req.app?.locals?.retellSandbox;
  if (!handoff) return res.sendStatus(404);
  try {
    const result = await handoff.webhook(req, kind);
    return res.status(result.status).type('text/xml').send(result.twiml);
  } catch {
    const r = new twilio.twiml.VoiceResponse(); r.hangup();
    return res.status(503).type('text/xml').send(r.toString());
  }
}
