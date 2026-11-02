import { createHash } from 'node:crypto';
import Receipt from '../../../models/RetellTranscriptReceipt.js';
import VoiceCallRecord from '../../../models/VoiceCallRecord.js';
import { appendTranscriptTurn, finalizeTranscript, createVoiceCallRecordStore } from '../../transcripts/transcriptPersistence.js';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);
// Webhooks are UNSCRUBBED even with provider redaction enabled. Never infer a
// redacted payload. Explicit TEXT opt-in + everything storage is required here.
const redactSecrets = text => text.replace(/authorization\s*:[^\r\n]+/gi, '[REDACTED]')
  .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, '[REDACTED]')
  .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
export class RetellTranscriptIngestion {
  constructor({ repository, VoiceCallRecordModel = VoiceCallRecord, ReceiptModel = Receipt, retentionDays, now = () => new Date() }) {
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 30) throw Error('TRANSCRIPT_POLICY_INVALID');
    Object.assign(this, { repository, VoiceCallRecordModel, ReceiptModel, retentionDays, now });
    this.ready = Promise.resolve().then(async () => {
      await VoiceCallRecordModel.init(); await VoiceCallRecordModel.createIndexes(); await ReceiptModel.init(); await ReceiptModel.createIndexes();
    });
  }
  async ingest(event) {
    if (!['call_ended','call_analyzed'].includes(event?.event)) return;
    const call = event.call;
    if (!identifier(call?.call_id) || !identifier(call?.agent_id)) throw Error('TRANSCRIPT_IDENTITY_INVALID');
    // No ACTIVE/expiry filter: post-call evidence must remain ingestible without
    // restoring any call/tool authority, including after Twilio supersession.
    const row = await this.repository.Model.findOne({ providerCallId: call.call_id }).lean();
    if (!row || row.agentId !== call.agent_id || (call.agent_version !== undefined && row.agentVersion !== call.agent_version)
      || (call.metadata?.glo_registration_attempt !== undefined && row.attemptId !== call.metadata.glo_registration_attempt))
      throw Error('TRANSCRIPT_IDENTITY_INVALID');
    if (call.data_storage_setting !== 'everything') return; // never reconstruct scrubbed/opt-out content
    const turns = call.transcript_object;
    if (turns === undefined) return; // later call_analyzed may carry final transcript
    if (!Array.isArray(turns) || turns.length > 512 || turns.some(t => !['agent','user'].includes(t?.role)
      || typeof t.content !== 'string' || !t.content.trim() || t.content.length > 8192)
      || turns.reduce((n,t) => n + t.content.length, 0) > 65536) throw Error('TRANSCRIPT_SHAPE_INVALID');
    const end = Number.isFinite(call.end_timestamp) && call.end_timestamp > 0 ? Math.min(call.end_timestamp, +this.now()) : +new Date(row.createdAt);
    const expiresAt = new Date(end + this.retentionDays * 86400000);
    if (!Number.isFinite(+expiresAt) || +expiresAt <= +this.now()) return;
    await this.ready;
    const existing = await this.VoiceCallRecordModel.findOne({ callSid: row._id }).lean();
    if (existing && (String(existing.barberId) !== row.businessId || existing.metadata?.provider !== 'retell')) throw Error('TRANSCRIPT_TENANT_CONFLICT');
    const callerNumber = row.trustedCallerNumber || 'UNKNOWN'; // display absence, never invented identity
    try {
      await this.VoiceCallRecordModel.updateOne({ callSid: row._id }, { $setOnInsert: {
        callSid: row._id, barberId: row.businessId, callerNumber, retellExpiresAt: expiresAt, metadata: { provider: 'retell' },
      } }, { upsert: true, runValidators: true });
    } catch (e) { if (e?.code !== 11000) throw e; }
    const current = await this.VoiceCallRecordModel.findOne({ callSid: row._id }).lean();
    if (String(current?.barberId) !== row.businessId || current?.metadata?.provider !== 'retell') throw Error('TRANSCRIPT_TENANT_CONFLICT');
    const store = createVoiceCallRecordStore({ model: this.VoiceCallRecordModel });
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i], id = digest([call.call_id, i]), contentHash = digest([turn.role, turn.content]);
      // Immutable per-position digest prevents corrected/conflicting snapshots
      // appending a second version of the same utterance. Partial crashes replay.
      try { await this.ReceiptModel.create({ _id: id, callId: call.call_id, businessId: row.businessId, contentHash, expiresAt }); }
      catch (e) {
        if (e?.code !== 11000) throw e;
        const receipt = await this.ReceiptModel.findById(id).lean();
        if (receipt?.contentHash !== contentHash || receipt.businessId !== row.businessId) throw Error('TRANSCRIPT_CONTENT_CONFLICT');
      }
      const offset = turn.words?.[0]?.start;
      const hasTime = Number.isFinite(call.start_timestamp) && call.start_timestamp > 0 && Number.isFinite(offset) && offset >= 0 && offset <= 7200;
      const appended = await appendTranscriptTurn({ callSid: row._id, barberId: row.businessId, callerNumber,
        turnId: `retell:${id}`, role: turn.role === 'user' ? 'caller' : 'assistant', text: redactSecrets(turn.content),
        timestamp: hasTime ? new Date(call.start_timestamp + offset * 1000) : this.now() }, { store });
      if (!appended.success) throw Error('TRANSCRIPT_PERSISTENCE_FAILED');
    }
    const finalized = await finalizeTranscript({ callSid: row._id, barberId: row.businessId, callerNumber,
      outcome: 'CALL_ENDED', appointmentId: null, finalizedAt: new Date(end), metadata: {
        provider: 'retell', providerCallId: call.call_id, language: row.language,
        ...(Number.isFinite(call.start_timestamp) && call.start_timestamp > 0 ? { callStartedAt: new Date(call.start_timestamp).toISOString() } : {}),
      } }, { store });
    if (!finalized.success) throw Error('TRANSCRIPT_FINALIZATION_FAILED');
  }
}
