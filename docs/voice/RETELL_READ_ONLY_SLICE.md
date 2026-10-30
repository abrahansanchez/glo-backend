# Retell read-only tools: first offline slice

Implemented **2026-10-30** on branch `experiment/voice-v2-realtime-conversation-lab`, starting HEAD `fe2f0fc24a70f3da739a6488899805c861c479cc`. This is offline application code, **not** a provisioned agent, connected phone route, deployed endpoint or provider acceptance result. See the [assessment](RETELL_INTEGRATION_ASSESSMENT.md) and [tracker](RETELL_IMPLEMENTATION_TRACKER.md).

## Exact scope and reusable seam

- `routes/retellReadOnlyRoutes.js`: raw-body signed HTTP router factory, default disabled. The subsequent offline wiring verification mounts it **disabled** in server.js, before the general JSON parser, through `mountReadOnlyTools.js`.
- `services/voice/retell/ReadOnlyBusinessTools.js`: catalogue/clock/hour projection and ordered-bundle read-only availability.
- `services/voice/retell/agentTemplates.js`: serializable EN/ES **UNPROVISIONED** configuration templates, not complete create-agent API payloads. Non-routable `.invalid` URLs prevent accidental connection.
- `utils/ai/availabilityHelpers.js`: only adds optional `findConflict` and `observe` arguments to `isSlotAvailable`. Existing default Appointment.findOne, logging, session support and scheduling rules stay intact.
- `tests/services/retellReadOnlyTools.test.js`: synthetic repositories, call bindings, signatures and loopback-only HTTP; no real database, provider or account.
- This document and the existing tracker record the subset and test evidence.

No StructuredPhoneDriver, decision transport, speech orchestration, fixtures or scoring enter the new runtime path. The existing slot predicate remains authoritative for hours/blackouts, explicit bundle duration, buffers, business timezone and confirmed/pending appointment conflicts. New code sums requested services in order, validates facts and dates, checks future instants and searches the existing 30-minute grid, at most seven dates/three alternatives. It never reduces a bundle to its primary service. Duration/price are not supplied by the model or filled using the old single-service default.

There is no appointment/SMS executor, active draft, consent, confirmation, recording, call registration, telephony bridge or provisioning endpoint. The original number, mobile ringing/takeover, V1/V2/structured selection and speech logic are unchanged. Other accounts' existing real-effect behavior is not disabled by this slice.

## Injected composition and identity contract

The factory is `createRetellReadOnlyRouter(options)`. No credentials/environment variables are inspected by it. With no options (or `enabled !== true`), all requests return404 before parsing or repository access. Enabled composition requires explicit valid `allowedBusinessIds` (1-16 lowercase 24-hex IDs), injected signing key and repositories. No production repository defaults are provided.

```text
callBindings.findByProviderCallId(providerCallId) -> server-owned binding or null
businessRepository.findById(boundBusinessId) -> plain application business snapshot or null
appointmentRepository.findConflict(existingGlōConflictQuery) -> conflict record or null
now() -> application-owned clock
audit(safeEvent) -> optional observer (exceptions ignored)
```

The binding is **read, never created/updated, by the tool adapter**:

```json
{
  "provider": "retell",
  "mode": "READ_ONLY",
  "status": "ACTIVE",
  "callId": "call_synthetic_a",
  "businessId": "507f1f77bcf86cd799439011",
  "agentId": "agent_synthetic_en",
  "agentVersion": 1,
  "language": "en",
  "parentCallSid": "CA_SYNTHETIC",
  "revision": 1,
  "expiresAt": "2026-11-01T00:00:00.000Z"
}
```

These are synthetic example identifiers. Production bindings must be established by trusted, separately implemented registration/handoff after existing server number/business resolution and admission. They must not be generated from a tool's metadata, dynamic variables, caller text or submitted business ID. No process-local synthetic store is offered as a production durable store. The repository must support a trustworthy current lookup/revocation across instances; provisioning and durable handoff are still outstanding. Source inspection found **no existing Retell binding store or trusted creation lifecycle**: VoiceCallRecord is transcript/finalization storage, and activeCallStore is a process-local Twilio map without Retell agent/version/revocation authority. Neither is repurposed as a binding.

Signed `call_id`, `agent_id`, exact numeric `agent_version`, and ongoing provider status must match an active unexpired READ_ONLY binding and the explicit business allowlist. Returned business `_id` must also match the bound tenant. Model arguments have no business/price/duration/consent fields. Extra arguments reject. The binding is re-read after all asynchronous business work; closure/revision/agent/tenant/language changes withhold release.

## HTTP/signature contract

Mount prefix: `/api/voice/retell`. `server.js` now calls `mountRetellReadOnlyTools(app)` **after the existing Stripe raw-body route and before global express.json**, without options, credentials or environment lookup. It therefore returns only disabled404 responses at that prefix. Only the following POST tools can exist in an explicitly configured composition:

| Path | Function name | Exact args |
| --- | --- | --- |
| `/tools/context` | `read_business_context` | `{}` |
| `/tools/availability` | `check_bundle_availability` | `{serviceIds:[...],date:"YYYY-MM-DD",time:"HH:mm",businessRevision:"<context SHA256>"}` |

Request envelope is `{name,call,args}`. Payload/args-at-root must be **off**. The full call object may contain transcript/access-token/metadata fields supplied by Retell; they are neither logged, returned nor retained. Only the bounded identity/status fields are used. Args are exact-key validated; service IDs are unique/ordered, 1-8, length <=128. Responses contain only application-owned facts and typed reasons.

Raw uncompressed JSON body limit128KiB; invalid UTF-8/JSON, wrong content type, signature mismatch, old/future timestamps outside five minutes, wrong tool/schema/identity all reject. Signature verification computes HMAC-SHA256 over exact body bytes followed by timestamp, constant-time compares the digest, and never prints the key or arbitrary exception messages. The injected key must be the provider's configured webhook-verification key during future setup; no real key was accessed here.

Official sources checked **2026-10-30**: [signature algorithm/freshness](https://docs.retellai.com/features/secure-webhook), [custom-function wrapper and retry behavior](https://docs.retellai.com/build/single-multi-prompt/custom-function). Offline signatures implement the documented contract; actual Retell acceptance remains unverified.

This read-only slice deliberately has no mutation-idempotency ledger: a duplicate authenticated read recomputes current observations rather than replaying cached availability. Timestamp freshness is not a claim that identical signed read requests cannot repeat within the window. There is a three-second service deadline and32 in-flight reads per router; a canceled/timed-out repository call that ignores cancellation retains its capacity slot until it settles, and cannot start further reads or release late output. Body ingestion is bounded by size; host-level ingress rate/slow-body/request protections remain a deployment prerequisite.

Errors are sanitized JSON, never stacks/raw envelopes:401 authentication,400 malformed arguments/body,403 call authorization,404 disabled/unknown tool,409 stale/unsupported business or slot,413 body too large,429 capacity,503 deadline/repository failure. Unknown exception messages become READ_UNAVAILABLE. Audit records contain only fixed tool/status/reason plus validated call/parent reference and binding revision after authorization.

## Facts, revisions and observation limits

Context returns services `{id,label,price,durationMinutes}`, timeZone, hours, bufferMinutes, blackout dates, application clock and a rolling local today-through-30-days supported window. Missing weekday hours remain null, not an invented open schedule. Missing/invalid price or duration is returned null; a requested bundle containing it returns UNSUPPORTED/MISSING_CATALOGUE_FACTS without a conflict read. Invalid catalogue/schedule structure fails closed. Disabled/nonbookable services are excluded. Original IDs survive; ID-less services use deterministic opaque handles, collision-checked and never persisted.

Labels come only from an explicit trusted repository `service.localizedLabels[en|es]` projection if present; otherwise the actual canonical service name remains. This optional projection is **not claimed to be an existing Barber schema field or a localization migration**. A later repository implementation must load approved labels explicitly, never infer translations. Templates' language instructions do not manufacture Spanish catalogue labels.

The context businessRevision hashes the projected catalogue, labels, timezone, hours, buffers and blackout dates. Availability requires that current revision. It returns exact ordered services, summed duration/cents price, requested slot, available/reason, up to three independently checked alternatives, checkedAt/expiresAt (60 seconds), `reservation:false` and `canAuthorize:false`. Nonexistent/ambiguous DST wall-clock times are rejected rather than guessed. Past/equal instants cannot be available. Closed-time results never claim the services themselves are unavailable or invent an operating-hours reason from a generic conflict.

Alternatives are checked with the same full-duration predicate and checked again after discovery; changed business facts, expired call binding or a requested slot becoming past before final release withhold the result. No draft/evidence-adoption tokens are created. There is **no reservation, transaction or promise that a concurrent booking cannot change availability after its last read**. Any future appointment flow still needs its own current proposal/consent/revalidation/atomic write. The 60-second field is a maximum observation age, not a slot hold or playback acknowledgment.

## Offline validation

Exact affected command (executed locally with synthetic boundaries only):

```powershell
node --test --test-concurrency=1 tests/services/retellReadOnlyTools.test.js realtime/voice-v2/tests/integration/structured-phone.test.js realtime/voice-v2/tests/integration/scheduling-integration.test.js realtime/voice-v2/tests/routing/isolated-live-routing.test.js realtime/voice-v2/tests/routing/phase8b-controlled-wiring.test.js realtime/voice-v2/tests/routing/twilio-transport-auth.test.js
```

Final totals are recorded in the tracker after the run. The new file covers full serialized HTTP requests/responses, real signature bytes/timestamps, cross-call/agent/business isolation, EN/ES trusted labels, bundle order/duration/zero price, hours/buffer/conflicts/blackouts/timezone/DST, missing facts, invalid structures, stale/revoked binding, expiry during async work, privacy sentinels, bounded hung repositories and disabled routing. Existing suites use fake phone/provider/database interfaces; they do not prove current real model output or telephony behavior. No complete-repository suite is claimed.

Syntax checks cover every changed/new JavaScript file; both Git diff checks and separate new-file whitespace checks are required. Test zero-write assertions and the source capability/import boundary establish no new appointment/SMS path; this is not an assertion that all existing Glō routes globally have no effects.

## Next separately authorized sandbox connection

Do **not** run a provider or change existing number routing from this document. The next bounded task must:

1. Review this exact patch and supply durable, server-owned sandbox binding creation/lifecycle. Real read-only model repositories and a disabled mount are now implemented; no trusted registration writer exists. Resolve the already-established business mapping server-side for any later phone handoff; do not ask the model for IDs or ask the user to reconfirm it. A provider sandbox may instead use explicitly synthetic business data and a registered test call.
2. Select a public HTTPS sandbox origin, ingress controls and approved signing-key injection. Keep production disabled. Verify pinned call/agent/version, revocation and replay-safe reads against realistic Retell callbacks. No credentials in prompts or saved artifacts.
3. Separately authorize provisioning an EN/ES agent from the UNPROVISIONED templates, replacing `.invalid` URLs and reconciling exact provider API fields. Keep all mutation/SMS/transfer tools absent. Configure wrapper enabled, zero retries, and bounded tool deadlines.
4. Register a bounded sandbox session and establish its trusted binding **before** it may call tools. Approve explicit session/turn/minute/cost assumptions and stop conditions; request limits are not a hard dollar cap. Record actual provider schema/signature acceptance and EN/ES meaning against returned facts.
5. Stop after read-only catalogue/availability evidence. Phone registration/SIP bridge, existing-number routing, mobile tests, confirmation authority and real booking remain distinct future gates. No provider invocation or key-loading command is supplied here.

Everything remains unstaged. No agent was created, no provider/database/account was contacted and no environment/configuration/number was changed by this implementation task.

## Offline wiring verification — 2026-10-30

### Exact helper change and compatibility

The only `availabilityHelpers.js` delta against starting HEAD adds two optional function arguments to `isSlotAvailable`:

```js
findConflict = query => Appointment.findOne(query)
observe = console.log
```

The existing conflict query, statuses, overlap/buffer arithmetic, date/time parsing, duration fallback, excludeAppointmentId and session chaining are unchanged. Three existing console.log call sites delegate to `observe`; one Appointment.findOne call delegates to `findConflict`. Existing callers omit both options and retain their original behavior. New Retell callers inject a read repository and a silent logger. `getAvailableSlots` and `getServiceDurationMinutes` are unchanged.

`retellAvailabilityCompatibility.test.js` loads the actual helper from Git commit `fe2f0fc24a70f3da739a6488899805c861c479cc` with the same synthetic Appointment model. Nine differential cases compare returned values/errors, exact queries, logs and session handling (available/conflict/closed/hours/blackout/session/exclusion/default-duration/read-error); the tenth exercises the new injection explicitly. These are offline tests, not live database comparisons.

### Minimum composition and real repositories

`services/voice/retell/ReadOnlyRepositories.js` wraps existing model reads:

- Barber.findById(boundBusinessId).select('_id services availability').lean()
- Appointment.findOne(existingConflictQuery).select('_id').lean()

There is no write method or SMS dependency. Construction issues no queries. IDs come only from the adapter's authorized binding, and every conflict query remains tenant-scoped. No catalogue/model schema migration or guessed localization was added; canonical names are used when no explicit label is available in the repository projection.

`services/voice/retell/mountReadOnlyTools.js` exports `mountRetellReadOnlyTools`. Its default server invocation is disabled and does not inspect configuration/credentials. A later explicit composition must provide `config.enabled === true`, a valid allowlist/signingKey, and a **trusted** callBindings.findByProviderCallId implementation. Missing/malformed configuration or missing binding repository leaves the prefix disabled without blocking startup or touching models. There is deliberately no environment switch or test HTTP endpoint that can invent bindings. An agent ID or signature alone cannot activate tenant access.

Offline tests use this same composition function with model-shaped fakes and synthetic bindings; they do not import server.js, which would connect databases/start jobs. Static ordering assertions verify the actual server mount; existing routing suites exercise its unchanged lifecycle separately. This is not a claim that the whole production server was booted offline.

### Signature compatibility and replay conclusions

Current official Retell pages were rechecked on2026-10-30. [Custom functions](https://docs.retellai.com/build/single-multi-prompt/custom-function) document `name`, `call`, `args` when args-at-root is off, including agent/version/call status in the call object. [Signature documentation](https://docs.retellai.com/features/secure-webhook) supports raw-body verification via Retell.verify and describes manual HMAC-SHA256 over raw body plus millisecond timestamp, with five-minute freshness. Use the key designated for webhook verification. The code uses native crypto/constant-time comparison; no SDK was installed or executed and no actual Retell-generated callback was received.

Pretty-printed UTF-8 requests pass through the composed raw parser unchanged; tampering and timestamp failures reject. Identical valid signed reads inside the window may repeat, intentionally recomputing current facts and rechecking binding/expiry. This is freshness protection, **not** one-time replay prevention or mutation idempotency. The composed replay test observes changed catalogue facts and then denies the same read after call closure. Provider compatibility remains unverified until a separately authorized real configuration/callback is accepted.

### Validation/inventory

Affected command adds these two files to the first-slice command above:

```text
tests/services/retellReadOnlyComposition.test.js
tests/services/retellAvailabilityCompatibility.test.js
```

Worktree and exact clean-HEAD overlay results: **248 tests /248 pass /0 fail, skip or cancel each** (46 original read-only, 15 composition, 10 helper compatibility, 177 existing affected tests). Ten JavaScript syntax checks, both Git diff checks and new-file whitespace checks pass. No complete-repository discovery or live/provider compatibility is claimed.

External evidence directory: `C:\Users\sanch\AppData\Local\Temp\retell-read-only-wiring-32824bf35f6c484d8fad68423e74ae4e` (`worktree.tap`, `clean-overlay.tap`, `inventory.txt`, final `overlay-hashes.json`). A local shared clone was detached at the exact starting SHA and reused existing dependencies through a node_modules junction, without installation, network fetch or source changes in another existing worktree. Only the12 inventory files were copied. SHA-256 comparisons verify overlay bytes match the worktree; the excluded adapter/test files are unchanged from clean HEAD in that checkout. These test totals overlap and must not be added.

Combined deployable slice/verification overlay inventory (12 files):

```text
server.js
utils/ai/availabilityHelpers.js
routes/retellReadOnlyRoutes.js
services/voice/retell/ReadOnlyBusinessTools.js
services/voice/retell/ReadOnlyRepositories.js
services/voice/retell/mountReadOnlyTools.js
services/voice/retell/agentTemplates.js
tests/services/retellReadOnlyTools.test.js
tests/services/retellReadOnlyComposition.test.js
tests/services/retellAvailabilityCompatibility.test.js
docs/voice/RETELL_READ_ONLY_SLICE.md
docs/voice/RETELL_IMPLEMENTATION_TRACKER.md
```

This round adds server.js, the repository/composition modules and two test files; adjusts the router's mount comment and original test's server-order assertion; updates these two documents. The helper, business tool service and templates retain the previous slice implementation. Unrelated adapter/test/evaluation/lab/handoff documents are excluded from the overlay.

**Runnable:** offline signed HTTP through the real composition/repository interfaces; a default-disabled prefix in server.js. **Blocked:** provider-connected activation until trusted call-binding registration/revocation/expiry persistence and secure runtime configuration are implemented/reviewed. There is no permissive binding creator, public sandbox bypass, mutation tool, number change or provider command.

## Trusted registration lifecycle — offline implementation, 2026-10-30

This section supersedes the missing-lifecycle blocker above for the **offline implementation only**. Runtime activation, provider transport and telephony handoff remain absent/disabled. Existing incoming, mobile ringing, human answer, fallback and authenticated takeover handlers are unchanged. `activeCallStore` is not an authorization dependency.

### Trusted admission and durable ownership

`createRetellCallRegistration` is an internal, injectable service, disabled unless explicitly constructed with `enabled: true`. There is no registration HTTP endpoint, environment loader or real provider implementation. `observeIncoming` enforces the existing Twilio signature validator directly (not its optional off/observe middleware), against the authoritative `/api/voice/incoming` URL and original form parameters. It resolves the signed `To` through `resolveBusinessByCalledNumber`, rejects conflicting `Called`, and pins an allowlisted server-owned agent/version/language. No model/business argument participates. Other legacy URL aliases deliberately cannot admit through this service until separately reviewed.

`RetellCallRegistration` persists:

- `_id`: original verified parent Twilio CallSid; one row per call.
- `businessId`, pinned `agentId`/numeric `agentVersion`, `language`.
- Server UUID `attemptId`, `ownerEpoch`, monotonic `revision`.
- `providerCallId`, optional early callback `observedCallId`.
- Typed `status`, `expiresAt`, ordinary creation/update timestamps.

The Mongoose repository follows existing create/duplicate-key and conditional `findOneAndUpdate` conventions. It waits for model initialization **and explicit unique-index creation** before querying/claiming. `_id`, attempt ID and a partial unique provider-call ID index fence ownership. No TTL deletion permits an expired incoming replay to create another attempt. Live Mongo index behavior, write durability/topology and operational retention have not been exercised; deployment must verify these rather than treating the model-shaped fake as a real database test.

Flow: `OBSERVED -> REGISTERING -> REGISTERED -> ACTIVE`. Claim is durably consumed before calling the injectable provider. Only the exact returned call/agent/version/status can bind, and success returns only after binding persistence; every result says `telephonyHandoffEnabled: false`. Signed `call_started` promotes only the known bound attempt. An early start is recorded without granting reads, then can become ACTIVE when the matching provider identity is persisted. An early end prevents subsequent binding. `ENDED` and `SUPERSEDED` never reopen. Explicit `supersede(parentCallSid, ownerEpoch)` atomically retires ownership and advances the epoch; it cannot create a replacement registration.

Every parent gets **at most one provider registration dispatch**, including after failure/expiry/supersession. Concurrent/duplicate losers return `CALL_NOT_CLAIMABLE`; they never blindly retry or return another handoff. All provider exceptions/invalid responses/deadlines conservatively become `UNKNOWN`; even a late successful response or start callback cannot activate UNKNOWN. Default deadline is 3 seconds (configurable 10–10000 ms), with AbortSignal propagated; expiry defaults to 10 minutes (bounded 1 second–30 minutes), never extended by callbacks. These are read-authorization limits, not claims about connected-call duration. A stuck/pending/ambiguous attempt needs a separately reviewed reconciliation procedure, not automatic re-registration. A timeout may leave an orphan provider-side registration; abort is not proof that the provider did nothing.

### Callback and read composition

Pass `{ registration: { repository, lifecycle } }` explicitly into `mountRetellReadOnlyTools`, alongside its existing explicit signing key/business allowlist and model dependencies. Tools then read that same durable repository. The raw-body `/api/voice/retell/events` callback is mounted before the read router/general JSON parser. It verifies the existing exact-byte HMAC/timestamp contract before JSON parsing and accepts only typed start/end lifecycle projections in the service. It stores no raw call object, transcript, number, credential, headers, analysis or arbitrary provider error. It returns 503 on persistence errors, 204 for duplicates/ignored foreign events, and never creates unknown registrations from callbacks.

The attempt UUID is sent as `metadata.glo_registration_attempt`, not as business authority. Callbacks must match it, the pinned agent/version and observed/bound provider call ID. Duplicate starts/ends are state-idempotent; end/supersession wins over delayed starts. Tool authorization still checks ACTIVE, expiry, exact signed call/agent/version, server business allowlist and the binding again after asynchronous reads. Revision changes invalidate an in-flight read. Forged business arguments reject; signed model metadata cannot select a tenant. No appointment mutation/SMS capability is introduced.

Current `server.js` still invokes `mountRetellReadOnlyTools(app)` **without options**: no repositories initialize, no callback activates, no registration or credential access occurs. Existing tool-only test injection remains supported. Supplying a signer or an agent alone is insufficient. This task does not attach `observeIncoming`, registration or supersession to any live phone controller.

### Official contracts checked

Checked public sources on 2026-10-30, without provider API calls:

- [Register Phone Call](https://docs.retellai.com/api-references/register-phone-call): POST `/v2/register-phone-call`, agent/version/direction, metadata, returned registered call identity. Numeric version support is also explicit in the [official generated SDK contract](https://github.com/RetellAI/retell-typescript-sdk/blob/main/src/resources/call.ts). No registration idempotency guarantee was established; this implementation never assumes one. A future SDK transport must explicitly disable SDK retries too.
- [Webhook overview](https://docs.retellai.com/features/webhook-overview): `{event, call}`, optional supplied metadata retained in call, start/end notifications and retried nonblocking delivery. Callback ordering cannot substitute for state fencing. Only start/end projection is implemented, not the wider durable webhook inbox/analysis backlog.
- [Signature verification](https://docs.retellai.com/features/secure-webhook): raw bytes plus millisecond timestamp HMAC, five-minute tolerance and the designated webhook-verification key. The existing verifier is reused; no secrets were read.

Provider acceptance and exact returned/callback version/metadata shapes remain unverified. Missing/malformed version, attempt metadata or lifecycle status fails closed. A provider persistence acknowledgment lost after an actual database commit is intrinsically ambiguous: database-committed state governs reads, never the caller's exception or an in-memory success flag. Real topology/write concern and reconciliation must be checked before activation. Local tests simulate writes succeeding or failing, not every network/write-ack ambiguity.

### Offline evidence and next sandbox prerequisites

`tests/services/retellRegistration.test.js`: 33 checks covering durable model/index contract, signature-verified server routing, persisted pending/active authorization, full serialized callback/tool HTTP, two businesses, forged args, foreign agents/versions/identities, expiry/end/supersession, duplicates/concurrency, persistence/index failures, provider error/timeout/late response, early start/end, restart via a new repository, privacy and disabled operation. Zero appointment/SMS effects. Existing scheduling, routing and helper compatibility tests also pass.

Exact affected command (run in both locations, offline fakes/loopback only):

```text
node --test --test-concurrency=1 tests/services/retellRegistration.test.js tests/services/retellReadOnlyTools.test.js tests/services/retellReadOnlyComposition.test.js tests/services/retellAvailabilityCompatibility.test.js realtime/voice-v2/tests/integration/structured-phone.test.js realtime/voice-v2/tests/integration/scheduling-integration.test.js realtime/voice-v2/tests/routing/isolated-live-routing.test.js realtime/voice-v2/tests/routing/phase8b-controlled-wiring.test.js realtime/voice-v2/tests/routing/twilio-transport-auth.test.js
```

Affected worktree and exact clean-HEAD overlay: **281/281 pass each**, no failures/skips/cancellations (33 lifecycle +248 prior affected tests; overlapping runs must not be summed). Fifteen JavaScript syntax checks, tracked/staged diff checks and new-file whitespace checks pass. Evidence: `C:\Users\sanch\AppData\Local\Temp\retell-lifecycle-dc81eb6f43904f7aae6b0bdcae2f3260` (`worktree.tap`, `clean-overlay.tap`, `inventory.txt`, before/final/overlay hashes). The overlay contains the prior 12 files plus these five:

```text
models/RetellCallRegistration.js
services/voice/retell/RegistrationRepository.js
services/voice/retell/CallRegistration.js
routes/retellLifecycleRoutes.js
tests/services/retellRegistration.test.js
```

This round changes those five new files plus `mountReadOnlyTools.js` and these two documents: **8 round files, 17 accumulated overlay files**. Unrelated adapter/test/lab/evaluation files are excluded.

Before one separately authorized connected sandbox: review the accumulated slice; verify Mongo unique indexes/write concern using an isolated test database; provision/pin the intended read-only agent and tool/callback contract; implement a no-retry provider transport with AbortSignal and sanitized projection; supply securely managed signing/registration configuration and verified business/agent mapping. Then authorize a specifically bounded register/callback/read sandbox to verify actual provider identity/version/metadata/signature delivery. Phone connection additionally requires a separate integration of the durable observation/claim/revocation seams with existing signed incoming/fallback and authenticated takeover, human-answer/end revocation and SIP handoff. No such handler, number, mobile or environment change is part of this slice; do not turn a successful offline registration into live telephony activation.

## Sandbox readiness follow-up — 2026-10-30

The earlier missing-transport and local-Mongo blockers are superseded by this section. [RETELL_SANDBOX_CHECKPOINT.md](RETELL_SANDBOX_CHECKPOINT.md) records the exact transport, callback compatibility, actual database evidence, constructor configuration names, one-call/two-minute proposed procedure, missing thin SIP handoff, success criteria and rollback. No production activation or execution is authorized.

Implemented `RegistrationTransport.js`: disabled default, injectable key/HTTP, fixed POST registration endpoint, pinned numeric agent/version, exact four-field serialized body, no redirects/retries, bounded response/deadline, safe identity-only projection and constant errors. Fake HTTP covers body/header hangs, errors, malformed/foreign responses, cancellation, disabled operation and privacy. The actual lifecycle uses this transport with fake HTTP in a regression proving an invalid response cannot bind or retry.

Callback version is now optional when absent from the documented callback example; any supplied conflicting version rejects. After provider identity is bound, absent metadata is resolved only by that exact existing ID plus agent. Before binding, supplied attempt metadata correlates the signed event; missing early metadata fails closed. No guessed business/version binding is created. Expiry is also checked inside the durable repository query against an injected application clock; the HTTP layer retains its final time checks.

**Database-backed, not mocked:** an already cached MongoDB 8.0.32 binary ran on loopback with a new temporary database. Actual indexes and duplicate-key enforcement, 20 competing claims, 10 competing supersessions, blocked late binding and exactly-at-expiry denial with the row still present all passed. The test child was closed. Deployment topology/write concern, permissions and failover remain unverified. No installation, download, configured DB URI or credential access occurred.

Worktree and exact accumulated clean-HEAD overlay: **300 tests /300 pass /0 fail, skip or cancel each**. Breakdown: 36 lifecycle, 15 fake-HTTP transport, one real isolated Mongo integration test, plus 248 previous affected checks. Eighteen JavaScript syntax checks, both Git diff checks and untracked-file whitespace checks pass. Runs overlap and must not be summed. No full-repository discovery or live provider acceptance is claimed.

Exact command adds `tests/services/retellRegistrationTransport.test.js` and `tests/services/retellRegistrationMongo.test.js` to the nine-file affected command above. Evidence: `C:\Users\sanch\AppData\Local\Temp\retell-sandbox-ready-4223425a36564ed1b8361bd4a2760d06` (`worktree.tap`, `clean-overlay.tap`, `inventory.txt`, before/final/overlay hashes). Mongo TAP diagnostics record the isolated server version and actual indexes. The clean overlay excludes both unrelated adapter/test modifications and standalone evaluation/lab work.

Exact proposed accumulated commit inventory (21 files):

```text
server.js
utils/ai/availabilityHelpers.js
models/RetellCallRegistration.js
routes/retellReadOnlyRoutes.js
routes/retellLifecycleRoutes.js
services/voice/retell/ReadOnlyBusinessTools.js
services/voice/retell/ReadOnlyRepositories.js
services/voice/retell/mountReadOnlyTools.js
services/voice/retell/agentTemplates.js
services/voice/retell/RegistrationRepository.js
services/voice/retell/CallRegistration.js
services/voice/retell/RegistrationTransport.js
tests/services/retellReadOnlyTools.test.js
tests/services/retellReadOnlyComposition.test.js
tests/services/retellAvailabilityCompatibility.test.js
tests/services/retellRegistration.test.js
tests/services/retellRegistrationTransport.test.js
tests/services/retellRegistrationMongo.test.js
docs/voice/RETELL_READ_ONLY_SLICE.md
docs/voice/RETELL_IMPLEMENTATION_TRACKER.md
docs/voice/RETELL_SANDBOX_CHECKPOINT.md
```

Proposed title: `feat(voice): add disabled read-only Retell registration and tools`. This follow-up touches nine of those files (three lifecycle/repository/test edits, transport plus two tests, and three documents). Everything remains unstaged/uncommitted. The registration transport is now available to inject, but no real phone handoff or provider-enabled composition exists in server.js. The minimum remaining connected checkpoint needs the specifically documented sandbox SIP handoff/termination seam, provisioned read-only agent, verified business mapping and explicit execution permission; a dashboard/web call cannot prove phone registration.

## Disabled sandbox SIP handoff round — 2026-10-30

Foundation committed at `8ffa9130d492ab68a9a87cfd37d250cd40351dcf`; this round remains unstaged. The [sandbox checkpoint](RETELL_SANDBOX_CHECKPOINT.md#disabled-sip-handoff-implemented-offline--2026-10-30) now documents an implemented but uninstalled composition, durable global experiment budget, bind-before-bridge and signed pre-connect screening, telephony duration control, failure hangup and disabled takeover. Its latest section supersedes earlier statements that handoff code is missing. Production still never calls the installer and no environment settings were added.

Exact 14-file round overlay on that clean starting HEAD:

```text
controllers/callController.js
routes/voiceWebhook.js
models/RetellCallRegistration.js
models/RetellSandboxBudget.js
services/voice/retell/CallRegistration.js
services/voice/retell/RegistrationRepository.js
services/voice/retell/SandboxBudgetRepository.js
services/voice/retell/SandboxHandoff.js
services/voice/retell/SandboxPhoneHooks.js
services/voice/retell/installSandbox.js
tests/services/retellSandboxHandoff.test.js
docs/voice/RETELL_SANDBOX_CHECKPOINT.md
docs/voice/RETELL_READ_ONLY_SLICE.md
docs/voice/RETELL_IMPLEMENTATION_TRACKER.md
```

Affected tests: **324/324 pass each in worktree and clean overlay**, no fail/skip/cancel. This is 24 new handoff checks plus the existing 300 affected checks; no full repository discovery is claimed. New checks use the actual Mongoose schemas/repositories against an already cached isolated Mongo 8.0.32 child plus fake provider and real loopback HTTP shared hooks. No production server boot/credential reads. Existing scheduling, structured-phone and routing regressions remain included. Eleven changed/new JavaScript syntax checks, tracked/staged diff checks and new-file whitespace checks pass. Reports, exact inventory and byte-matched overlay hashes are in `C:\Users\sanch\AppData\Local\Temp\retell-sip-4a1df0ac074643d4b0b76eb0928f7fed`.

Exact affected command adds `tests/services/retellSandboxHandoff.test.js` to the previous 300-test command. Unrelated adapter/test modifications, standalone lab/evaluation files and untracked engineering/assessment documentation are excluded. Normal booking/StructuredPhoneDriver are unchanged. Initial sandbox has no appointment/SMS executor, no custom-AI fallback after selection, and no automatic retry. Only signed, nonselected calls/default configuration retain normal route behavior; the selected account's explicit takeover is blocked until separately implemented.
