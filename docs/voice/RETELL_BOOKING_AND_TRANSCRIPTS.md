# Retell booking and transcript slice - offline, 2026-11-02

Starting HEAD: e4e8db8ba687c0352f77a37e2ee34a04d0da6258. No production activation, agent publication, credentials, provider requests, calls or SMS in this task. Existing read-only/SIP routing and budget rules remain. No mobile files changed.

## Recorded checkpoint (operator-provided, not newly queried)

call_2dfaf3a042757bc40cfff56d4a4 / attempt 16ffe663-62a3-46ce-b75b-4977d049f77f; parent CA828ff91afd684c3e2bce80503b7b9e7a; SIP child CAf2f53d947f27799139cc9778e89a2a4f; business 69d6b84155368d54a594b55a; agent agent_1da974cf19d41a0b0e64b012d5 published version 0. Context and two availability reads succeeded; registration SUPERSEDED, bridge screened, budget ENDED. glo_retell_checkpoint_001 is consumed and must remain so. This is read-only call evidence, not booking/transcript-ingestion acceptance.

## Authority and booking implementation

Retell owns interpretation and confirmation dialogue. Gl? derives tenant, parent call and agent identity only from signed requests and persisted registration. Signed Twilio incoming From is retained as trusted routing provenance; caller ID is not verified customer ownership. A separately supplied E.164 contact is contact data, not authentication. No existing-appointment lookup, cancel or reschedule tool is exposed.

Both existing sandbox switches must still be true for startup. New independent RETELL_BOOKING_ENABLED defaults false (only exact true enables). Each new registration also snapshots bookingAllowed; turning the setting on cannot upgrade an older read-only registration. Active, screened, unexpired current ownership and pinned agent/version are required on every booking HTTP request. Read compatibility mode remains READ_ONLY; bookingAllowed is the separate capability.

prepare_booking validates exactly one catalogue ID/legacy handle, maps it to the actual canonical service name/duration, checks revision, timezone, strict future calendar date/time in the current business-local today..+30-day window, full hours, buffers, blackouts and conflicts. Name/contact are bounded. A durable 60-second proposal (also bounded by call/bridge expiry) contains exact facts, price, duration, contact and incoming provenance. A new well-formed preparation invalidates the prior proposal even if unavailable or unsupported. Multiple separate items return MULTI_ITEM_BOOKING_UNSUPPORTED; an existing single combination item uses its real duration. No partial bundle booking.

commit_booking accepts the current server-issued proposal ID and AFFIRMATIVE only after the caller confirms that exact summary. Confirmation time and facts hash are persisted when claiming commit. Negative/ambiguous responses are not commit instructions. A model boolean/string cannot establish that a human actually affirmed: conversational confirmation correctness remains a Retell/live-test responsibility. No old phrase interpreter, playback gate or StructuredPhoneDriver is imported. Changed facts require prepare and confirmation again.

Gl? rechecks authorization, exact facts hash, current proposal, expiry, revision and availability. It reuses createIdempotentAppointment, reconciliation and atomicScheduleMutation. The optional beforeCreate hook fences registration ownership in the same schedule transaction; other callers retain their path. Stable retell:<proposal UUID> key and existing appointment unique index prevent duplicate effects. Hash mismatch conflicts. BOOKED requires persisted appointment identity; lost replies reconcile. Absence remains UNKNOWN and keeps the durable lock/key; no automatic second create. Bounded transaction WriteConflict exhaustion also remains UNKNOWN. Known unavailable slots are rejected with checked alternatives. Unknown/stuck prepare/commit locks need operator reconciliation; no automatic unlock/retry is provided.

No convenience 60-minute/SMS helper is used. Retell appointments set notificationsSuppressed=true. Both SMS functions exit before constructing a client; reminder selection excludes these rows. Other appointments default false and retain normal reminders. This persists SMS opt-out across restarts and later reminder jobs. No SMS activation/configuration is added.

## Later dashboard tool configuration (not applied)

Use full Retell payload, NOT args-only: {name, call, args}; authenticated call_id, agent_id, agent_version and ongoing status must be present in call. Do not add a business ID argument or static identity header. Existing x-retell-signature over exact raw body authenticates the request. No dashboard Authorization secret/header is required by these handlers.

POST https://glo-backend-yaho.onrender.com/api/voice/retell/tools/prepare-booking
POST https://glo-backend-yaho.onrender.com/api/voice/retell/tools/commit-booking

These are intended URLs, not a claim that this patch is deployed/enabled. Exact names/descriptions/schemas are exported by services/voice/retell/bookingTools.js; ready-to-paste schemas follow below. Recommend prepare timeout_ms=5000, commit timeout_ms=15000, max_retry=0, args_at_root=false. These are dashboard recommendations, not server-enforced 5/15-second deadlines or dollar caps. Client timeout never justifies issuing a new proposal to retry an uncertain booking. Same-proposal commit can reconcile while authorized.

Minimal generic prompt additions (EN): Collect the requested catalogue item, date/time, customer name and contact. Prepare, read the returned exact summary and ask for explicit confirmation. Commit only that current proposal after a clear affirmative. If details change, prepare again. Say booked only on BOOKED. UNKNOWN is unresolved: do not promise success/failure or create a new booking. Explain unsupported multiple items and ask for one existing catalogue/combination item; never silently omit a service.

ES: Recoge el servicio del cat?logo, fecha/hora, nombre y contacto. Prepara la propuesta, comunica su resumen exacto y pide confirmaci?n expl?cita. Confirma ?nicamente esa propuesta vigente tras una respuesta afirmativa clara. Si cambian los datos, prepara otra propuesta. Di que est? reservada solo con BOOKED. UNKNOWN no confirma ?xito ni fracaso: no crees otra reserva. Explica cuando varios servicios separados no est?n admitidos; no omitas servicios.

Status handling: PREPARED is not booked; BOOKED includes appointmentId; UNKNOWN/SETTLEMENT_UNKNOWN must not be retried as a new create; UNSUPPORTED/MULTI_ITEM_BOOKING_UNSUPPORTED needs supported selection; REJECTED includes stale/foreign/expired proposal, explicit confirmation required, busy, changed business, unavailable and invalid catalogue/slot. HTTP 400 malformed, 401 signature, 403 unauthorized, 404 disabled, 409 bounded domain rejection, 503 unavailable/persistence diagnostic. Errors never echo arbitrary exceptions or raw arguments.

## Signed final transcript ingestion

Official public contracts checked 2026-11-02: https://docs.retellai.com/features/webhook-overview and https://docs.retellai.com/api-references/get-call . call_ended contains the full call except analysis; call_analyzed supplies the final analyzed call. transcript_object has role agent/user, content and optional word offsets. Webhooks may contain UNSCRUBBED content regardless of provider storage policy. Provider settings alone do not enforce backend redaction.

RETELL_TRANSCRIPTS_ENABLED defaults false. When exact true, RETELL_TRANSCRIPT_RETENTION_DAYS must be an explicit integer 1..30 or startup fails closed. In addition, ingestion requires call.data_storage_setting=everything. Redacted/opt-out/missing modes store no transcript; do not reconstruct scrubbed content. Backend stores intended conversational text only with this explicit policy; secret-pattern filtering is narrow, not universal PII anonymization. Names/phone numbers can remain in opted-in text. Operational consent/privacy approval is still required.

Use existing signed POST /api/voice/retell/events. Preserve call_started and call_ended selections; add supported call_analyzed as a final-snapshot fallback. No transcript_updated event is enabled. Provider call ID resolves a retained durable registration even when terminal/expired; agent and supplied version/attempt conflicts reject. Payload business IDs never select tenant. This read-only evidence lookup never reactivates tools or booking.

Parent CallSid is VoiceCallRecord.callSid; business is barberId; caller is signed incoming provenance or UNKNOWN when historical data lacks it. appendTranscriptTurn/finalizeTranscript are reused. Per-position immutable digests plus deterministic turn IDs deduplicate/recover partial writes; matching longer snapshots append the suffix, shorter/duplicate deliveries do not duplicate. Conflicting revisions reject instead of overwriting. 512 turns/8192 characters per turn/65536 total bound the snapshot. Raw envelopes, tools, analysis, prompts and recording/audio URLs are not stored. Final outcome CALL_ENDED is neutral, not a claimed booking result. No transaction-wide webhook inbox is introduced; partial append failures rely on signed delivery retry and deterministic IDs.

VoiceCallRecord.retellExpiresAt and hash-only receipt expiresAt have TTL indexes; existing records without that field are unaffected. Access/ingestion expiry checks do not depend on TTL deletion for authorization. Mongo TTL removal is asynchronous; existing dashboard reads can display a retained record briefly until deletion. Calls older than the retention boundary are not rehydrated by webhook replay. Registration and booking command identity are NOT TTL-deleted, preventing replay. Booking proposals include contact/name and currently retain command facts indefinitely; a separately reviewed redaction/operational retention policy for durable command data remains a rollout prerequisite.

## Required indexes and deployment prerequisites (not provisioned here)

Additive provisioning only: retellbookingproposals _id unique and {callId:1,createdAt:-1}; retelltranscriptreceipts _id unique and TTL {expiresAt:1}, expireAfterSeconds:0; voicecallrecords additive TTL {retellExpiresAt:1}, expireAfterSeconds:0. Verify existing VoiceCallRecord unique callSid, Appointment unique {barberId:1,bookingCommand.idempotencyKey:1} with its string partial filter, schedule fence _id, registration attempt/provider uniqueness and budget _id. No syncIndexes/drop/reset. Production Mongo must support the existing snapshot/majority transactions; isolated replica-set tests do not establish deployed configuration/indexes.

Review/commit/deploy separately with new flags false. Preserve consumed checkpoint budget; a separately authorized new test requires its own approved budget lifecycle, never reset checkpoint_001. Provision/check indexes additively, approve transcript/privacy/command-data retention, pin reviewed agent version/tools/events, verify authoritative number/business mapping, then separately authorize enablement and controlled booking/conflict/lost-response tests with a known synthetic customer and cleanup plan. No real booking is authorized by this offline task. Rollback: disable RETELL_BOOKING_ENABLED and RETELL_TRANSCRIPTS_ENABLED (or disable either sandbox switch), restart/drain through approved operations; old remote calls are not automatically hung up, records/keys must not be deleted and unknown commands require reconciliation. No webhook/config/agent edits were made.

## Facts for the separate Mac/mobile task

Existing authenticated, active-subscription GET /api/dashboard/transcripts and /api/dashboard/transcripts/:id already read VoiceCallRecord by tenant. Retell records use the same messages/transcriptLines/preview/status shape and parent CallSid; source currently remains voice_v2 for compatibility, while metadata.provider=retell identifies provenance. The read model uses provider callStartedAt for duration rather than callback insertion time. API detail/list compatibility is tested; actual deployed mobile rendering is not. No push/feed refresh notification was added; the client must fetch/refresh these existing endpoints.

Rejecting a ringing native invite must be separate from Let AI Handle takeover. Existing backend selected sandbox takeover remains blocked; that API returning failure must not prevent local reject. Ringing, permissions, native invite reject and display/refresh are Mac/mobile work, not changed here. No mobile installation, UI, onboarding or number change in this patch.

## Validation evidence

Evidence directory: C:/Users/sanch/AppData/Local/Temp/retell-booking-transcripts-2088758cd7cc47a1a96898776552e886 . Uses fake Retell/Twilio HTTP and a cached existing mongod 8.0.32 executable as an isolated loopback single-node replica set; no download or live database credentials. Real Mongo transactions/unique indexes exercise concurrent same-proposal commits, competing calls/buffers, ownership fencing, uncertain/lost-response settlement, transcript dedupe/terminal/ordering/tenant isolation and existing dashboard read contracts. Broad affected and exact clean-HEAD overlay results are appended after validation. No live provider acceptance, conversational affirmative accuracy or mobile display is inferred from offline results.

### prepare_booking parameters

```json
{
  "type": "object",
  "properties": {
    "serviceIds": {
      "type": "array",
      "minItems": 1,
      "maxItems": 8,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      }
    },
    "date": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
    },
    "time": {
      "type": "string",
      "pattern": "^\\d{2}:\\d{2}$"
    },
    "businessRevision": {
      "type": "string",
      "pattern": "^[a-f0-9]{64}$"
    },
    "clientName": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "contactNumber": {
      "type": "string",
      "pattern": "^\\+[1-9]\\d{7,14}$"
    }
  },
  "required": [
    "serviceIds",
    "date",
    "time",
    "businessRevision",
    "clientName",
    "contactNumber"
  ],
  "additionalProperties": false
}
```

### commit_booking parameters

```json
{
  "type": "object",
  "properties": {
    "proposalId": {
      "type": "string",
      "pattern": "^[a-f0-9-]{36}$"
    },
    "confirmation": {
      "type": "string",
      "enum": [
        "AFFIRMATIVE"
      ]
    }
  },
  "required": [
    "proposalId",
    "confirmation"
  ],
  "additionalProperties": false
}
```

## Final validation and exact task inventory

Worktree and exact clean starting-HEAD overlay each: **389/389 passed**, zero failures/skips/cancellations. Includes all existing Retell regressions, new booking/transcript checks, scheduling/atomic-boundary, tenant transcript read-model and default phone-routing regressions. 23 changed JavaScript syntax checks, Git diff --check, Git diff --cached --check and new-file whitespace pass. The new action suite has 30 cases; startup now has 21 (four retention-policy regressions added). All database-backed action cases actually ran using isolated replica-set storage; they were not skipped or described as production verification.

26 task files, excluding the two unrelated adapter/test modifications and all pre-existing lab/evaluation/engineering files:

```text
docs/voice/RETELL_BOOKING_AND_TRANSCRIPTS.md
docs/voice/RETELL_IMPLEMENTATION_TRACKER.md
docs/voice/RETELL_SANDBOX_CHECKPOINT.md
jobs/appointmentReminders.js
models/Appointment.js
models/RetellBookingProposal.js
models/RetellCallRegistration.js
models/RetellTranscriptReceipt.js
models/VoiceCallRecord.js
routes/retellBookingRoutes.js
routes/retellLifecycleRoutes.js
services/booking/atomicScheduleMutation.js
services/dashboard/transcriptReadModel.js
services/voice/retell/BookingService.js
services/voice/retell/CallRegistration.js
services/voice/retell/RegistrationRepository.js
services/voice/retell/TranscriptIngestion.js
services/voice/retell/bookingTools.js
services/voice/retell/installSandbox.js
services/voice/retell/mountReadOnlyTools.js
services/voice/retell/startup.js
tests/services/retellActionsHarness.js
tests/services/retellBookingTranscripts.test.js
tests/services/retellRegistration.test.js
tests/services/retellStartup.test.js
utils/appointments/appointmentSms.js
```

External inventory.json, hashes.json, checks.json, affected-final.tap and overlay.tap retain exact evidence. The hash before column uses starting-HEAD Git blob bytes for existing files (working-tree CRLF can differ); after uses final working-tree bytes. No files were staged or committed.
