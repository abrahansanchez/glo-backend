# Read-only Retell sandbox checkpoint — prepared, not executed

Baseline: branch `experiment/voice-v2-realtime-conversation-lab`, HEAD `fe2f0fc24a70f3da739a6488899805c861c479cc`. Production `server.js` still mounts with no options: disabled. No environment setting, credential loader, production selector or telephony change is introduced. This is a proposed checkpoint requiring separate execution authorization, not a runnable phone handoff today.

## What is verified offline

The registration model uses a unique parent `_id`, unique `attemptId`, and partial unique `providerCallId`; no TTL index. Repository initialization explicitly creates indexes before claims. A conditional `findOneAndUpdate` consumes OBSERVED status with the exact owner epoch and future expiry. Supersession advances the epoch and retires status; it never opens a new attempt. Repository reads and the final HTTP authorization gate check current time directly. Expired rows remain present and cannot admit a replay.

The existing cached `mongod-x64-win32-8.0.32.exe` was started on loopback with a fresh temporary database directory. `retellRegistrationMongo.test.js` inspected actual server version/indexes, verified duplicate attempt/provider IDs reject, 20 competing claims yield one winner, 10 competing supersessions yield one winner, late binding fails, and expiry denies access at the exact expiry instant without deleting the row. The child is terminated during cleanup. No downloads, external DB URI, environment changes or credentials. This proves standalone local Mongo behavior, not deployment replica-set failover, write concern, permissions, operational index rollout or lost write acknowledgments.

## Provider transport

`createRetellRegistrationTransport({enabled, apiKey, http, deadlineMs})` remains disabled by default. It never reads environment values. Explicit enablement takes an injected key and HTTP function (native fetch by default). One POST to `https://api.retellai.com/v2/register-phone-call`, JSON content type, one Bearer header, redirects forbidden. No SDK and no retry loop.

Exact outbound body:

```json
{
  "agent_id": "SERVER_PINNED_AGENT",
  "agent_version": 3,
  "direction": "inbound",
  "metadata": {"glo_registration_attempt": "SERVER_GENERATED_UUID"}
}
```

The service constructs this from its persisted server-resolved business mapping, not model arguments. No phone number or business ID is sent as provider authority. The transport requires a phone-call response with nonempty bounded call ID, exact agent/version and registered status; only those identity fields leave it. Response body is bounded to 64 KiB. Request/body deadline defaults to 3000 ms, bounded configuration 10–10000 ms, with propagated AbortSignal, body cancellation and no automatic retry. Header/body/network/HTTP/parse failures all produce a constant safe UNKNOWN error; raw errors, response envelopes and secrets are never logged. UNKNOWN registration remains terminal/non-authorizing even if a late response arrives. HTTP status 200 or 201 is accepted only with a valid response identity.

## Callback compatibility and races

Callbacks use the exact-byte signature verifier before parsing and only project lifecycle identity. The optional callback `agent_version` is checked if supplied; if omitted, no model-derived version replaces the persisted pinned version. After binding, optional metadata may also be absent: the exact provider call ID and matching agent locate the existing registration. No callback can create a row. A conflicting supplied attempt/version/agent/call ID rejects.

Before the registration response is persisted, the supplied metadata attempt UUID can correlate an authentic callback to the durable claimed attempt. An early start is held without read authority until the returned identity is validated and bound; an early end prevents binding. If an early callback omits the attempt metadata, it cannot be safely correlated and grants nothing. The official contract retains supplied metadata, but actual delivery remains to be verified; absence before binding can therefore leave this attempt unavailable rather than guessing/rebinding. UNKNOWN, ENDED and SUPERSEDED never promote on a delayed start. Terminal events revoke even when their status snapshot is still registered, as in the official example. Duplicate events are state-idempotent. Signature freshness is not a registration idempotency guarantee.

Official public sources rechecked 2026-10-30:

- [Register Phone Call](https://docs.retellai.com/api-references/register-phone-call), including supported metadata and returned registered phone identity; [official SDK types](https://github.com/RetellAI/retell-typescript-sdk/blob/main/src/resources/call.ts) expose numeric agent versions. No registration idempotency guarantee is assumed.
- [Webhook overview](https://docs.retellai.com/features/webhook-overview): event/call envelope, supplied metadata, retrying nonblocking lifecycle notifications. A callback example omits agent_version, so that optional callback field is not mandatory here.
- [Secure webhook](https://docs.retellai.com/features/secure-webhook): raw bytes, designated webhook-verification key, HMAC/timestamp contract.
- [Custom telephony](https://docs.retellai.com/deploy/custom-telephony): connect the registered identity to `sip:{call_id}@sip.retellai.com` within five minutes. Registration alone does not initiate a conversation. A dashboard playground or web call creates/exercises a different path and cannot prove this registered-phone binding works.

## Exact configuration interface (not environment switches)

These are existing constructor/mount properties. No environment-variable parser has been added; production defaults stay false. Supply secrets only through a separately reviewed secure composition, never in documents, logs, URLs or model tools.

| Component | Property | Sandbox value shape/default |
| --- | --- | --- |
| Registration transport | `enabled`, `apiKey`, `http`, `deadlineMs` | false by default; explicit true only in isolated sandbox; injected registration key; reviewed HTTP implementation; 3000 ms |
| Registration service | `enabled`, `repository`, `provider` | false by default; same durable repository and transport when explicitly enabled |
| Registration service | `agentsByBusiness` | object keyed by verified server-resolved 24-hex business ID, value `{agentId, agentVersion: integer, language: 'en' or 'es'}`; exactly one sandbox business |
| Registration service | `twilio.authToken`, `twilio.appBaseUrl` | injected verification key and authoritative public HTTPS origin; actual signed `/api/voice/incoming` form; no off/observe admission |
| Registration service | `lifetimeMs`, `deadlineMs` | default 600000 and 3000 ms; sandbox may tighten expiry, never extend through a callback |
| Read-only mount | `config.enabled` | false/missing by default, true only for separate sandbox app |
| Read-only mount | `config.signingKey`, `config.allowedBusinessIds` | designated webhook verification key; array containing exactly one verified 24-hex business ID |
| Read-only mount | `registration: {repository, lifecycle}`, `models` | same registration store/service; isolated synthetic Barber/Appointment repositories/models initially |

## Smallest connected procedure — blocked on the following thin handoff

No public binding creator/test bypass exists. The missing sandbox-only component must:

1. Receive an authentic signed Twilio incoming request for the existing approved test route, resolve its business through the existing resolver, and call `observeIncoming`. Keep mobile ringing and human answer intact.
2. At the approved AI fallback boundary only (never after completed human answering), claim/register once, persist the returned Retell ID and only then build the SIP dial for that exact ID. Authenticated takeover must use saved original parent-call ownership and explicitly supersede the previous owner; this task does not wire takeover.
3. Enforce the one-call/two-minute budget below with actual cleanup/hangup, and retire the durable registration on human answer, parent call end, takeover, abort or shutdown. Expose no arbitrary call/business/agent bootstrap endpoint.

This is minimal telephony handoff code still missing, not a reason to enable production or invent a binding. An alternative SIP test harness would still need an independently trusted signed parent call/business admission; it cannot bypass that source of identity. No handoff code or call was executed in this preparation.

After that seam is reviewed and separately authorized:

1. Use one verified test business and pinned read-only agent/version, a public HTTPS callback/tool endpoint, isolated synthetic business/appointment records with matching authoritative routing, and the same durable registration repository. Keep all mutation tools absent. Verify server/index permissions first.
2. Place exactly one explicitly approved SIP-connected test using the existing number/workflow. Inspect that registration was accepted and its returned ID is persisted **before** bridging. Confirm signed start event activates only that identity.
3. Ask the agent for catalogue facts, then one full-bundle availability query. Save sanitized status/identity/revision evidence and verified results, not raw call envelopes or credentials. Expect one context read and one availability read; no appointment/SMS effects.
4. In the same call ask for another business: neither model metadata nor added businessId arguments can change scope. A forged-argument tool request must reject; ordinary requests remain bound to the original business. Do not read the other business's records. A fabricated local signature is an offline negative probe, not proof of authentic provider delivery.
5. End the call, verify END revocation and that repeated signed requests no longer authorize. No automatic retry, second registration or second call after any failure/ambiguous result.

Budget: **one registration, one connected call, at most two connected minutes, zero automatic reruns**. The missing handoff must enforce this before use, including terminating the parent leg. Agent maximum duration should also be set/verified during sandbox configuration; no such setting was changed here. Tool endpoint currently has bounded request work but no total per-call read quota; observe a planned two successful reads plus one cross-business denial, and stop on unexpected traffic. These are planned operational limits, not already implemented telephony or hard dollar caps. Pricing/charges and actual provider acceptance remain unverified; get budget approval before execution.

Success requires accepted registration, durable identity, authentic signed lifecycle/tool delivery, correct catalogue/full-bundle results, cross-business denial, end revocation and zero mutations. Missing fields, signatures or ambiguous registration stop this checkpoint; do not weaken binding to obtain a pass.

Rollback: leave/revert both explicit enabled properties and read-only mount to false/absent, retire any active sandbox owner via `supersede`, stop the isolated handoff and end its test call. Do not delete registration rows to re-enable retries. Existing production routing requires no rollback because it has not been changed or enabled. No number/webhook/mobile configuration changes are authorized by this document.

Proposed accumulated commit title: `feat(voice): add disabled read-only Retell registration and tools`.

## Disabled SIP handoff implemented offline — 2026-10-30

Starting HEAD `8ffa9130d492ab68a9a87cfd37d250cd40351dcf` now contains the foundation above. This section supersedes the earlier **missing handoff code** blocker; provisioning, deployment review and real provider/telephony acceptance remain unverified. No call or provider request has been made.

### Composition and existing phone routing

`installRetellSandbox(app, options)` is **not called by server.js**. Both `enabled === true` and `executionEnabled === true`, one explicit server-resolved `businessId`, a stable `budgetId`, exactly one pinned `agentsByBusiness` entry and injected configuration/dependencies are required. No environment-variable parser or credential lookup was added. Call the installer only in a separately reviewed sandbox boot, before general JSON parsing, because it composes the existing raw-body read/callback mount. It installs `app.locals.retellSandbox` only after configuration succeeds. The normal production boot has no such object.

Existing `handleIncomingCall` still performs forwarding verification and business resolution, then observes the selected call and returns the same mobile Client dial. Failed observation does not prevent a human answering; it prevents later sandbox registration. Normal nonselected calls and default-disabled routes retain existing behavior. A completed human dial retires the observation and hangs up without consuming the experiment budget or registering Retell.

Only signed `/api/voice/dial-fallback` for the selected business may register. The handler checks the trusted called-number resolver again, the previously persisted incoming identity/epoch and the allowed dial outcomes (no-answer/busy/failed/canceled). Unsigned selected requests reject; legacy URL aliases cannot bypass this canonical-URL verification. The selected branch returns before custom AI or the normal missed-call push and clears the existing active-call map. Selected registration, persistence or bridge failures use existing application-owned failure wording plus Hangup; they **never** fall through into the custom voice engine. Normal nonselected missed-call notifications remain unchanged. Selected account takeover returns `RETELL_SANDBOX_TAKEOVER_DISABLED`; no owner transition to custom AI is enabled.

### Durable budget and bridge boundary

`RetellSandboxBudget` has one unique `_id = budgetId` per explicitly approved experiment, shared across calls/processes, no TTL deletion. A create-only CLAIMED row pins the business, parent CallSid and owner epoch **before registration**. Duplicates/concurrent losers never retry or return another SIP dial. A second parent and a new process using the same budget cannot acquire it. Never change/delete the budget ID to retry an uncertain run; a new ID requires a separately authorized experiment.

At actual provider dispatch, a second atomic predicate consumes `registrationAttemptId` only once and checks the exact registration attempt/agent/version/current owner against the budget. Even calling the internal lifecycle directly cannot bypass that fence. Bridge reservation requires this consumed registration field. A blocked direct call grants no provider execution or tools.

After provider identity is validated and persisted, two conditional writes reserve the sole bridge and bind its deadline to the current registration. Final async reads recheck registration status, business, epoch, identity and expiry immediately before returning TwiML. The SIP URI is built only from the persisted validated call ID, with a restricted URI-safe ID shape. An ambiguous failure consumes the budget and safely withholds the bridge.

Returned TwiML contains:

```xml
<Dial timeLimit="120" timeout="20" answerOnBridge="true"
      action="https://APP_ORIGIN/api/voice/retell-sandbox/complete" method="POST">
  <Sip url="https://APP_ORIGIN/api/voice/retell-sandbox/screen" method="POST"
       statusCallback="https://APP_ORIGIN/api/voice/retell-sandbox/status"
       statusCallbackMethod="POST" statusCallbackEvent="answered completed">sip:PERSISTED_CALL_ID@sip.retellai.com</Sip>
</Dial>
```

The signed called-leg screening callback rechecks current ownership and durably pins the **first child CallSid** to this budget; another child rejects, including one caused by replayed TwiML. It requires the documented child `ParentCallSid` to match the saved parent. Missing/foreign fields fail closed. Empty screening TwiML allows the bridge; Hangup rejects it. Tools require bridge reservation **and successful persisted screening**, in addition to the existing authenticated Retell ACTIVE binding. No model or submission completion grants that state.

The final check cannot atomically control Twilio after an HTTP response is exposed. Screening is the remote-boundary recheck; ownership loss after screening still revokes tools immediately on subsequent repository reads but cannot retract a bridge already consumed remotely. Real delivery/order, actual SIP compatibility and carrier behavior remain live-test requirements. No instantaneous remote disconnect on arbitrary later ownership loss is claimed: the Twilio duration limit remains the independent maximum, and takeover remains disabled.

### Enforced limits versus setup timing

- **One application registration attempt and one bridge reservation** per persisted budget. Atomic Mongo ownership survives duplicate webhooks and restarts. Screening permits only one child leg. Failed/uncertain attempts are not restored.
- **120 seconds connected:** Twilio `<Dial timeLimit="120">` is the documented telephony control, not a Node timer. The Dial action always returns Hangup after revocation. Twilio's action response controls the original parent leg; the extra Hangup following Dial is not relied on because an action URL takes over TwiML execution.
- **Setup:** budget admission/screening must complete within 30 seconds of claim. SIP Dial timeout is 20 seconds; Twilio documents an additional five-second timeout buffer. Registration retains its bounded three-second request deadline. Retell separately requires connecting the registered ID within five minutes. These setup bounds are distinct from the connected duration and do not promise exact wall-clock termination under provider/network failure.
- **Tool access:** a stricter deadline starts at bridge reservation and ends 120 seconds later, so setup time reduces the usable tool window. It never extends on a delayed answered/start callback. Expiry is checked from time directly, with rows retained; this is conservative and may deny tools before the full connected limit.
- Signed child completion, Dial completion, existing Retell end events, supersession or direct expiry remove read authorization. Late callbacks cannot restore it. If callbacks are unavailable, direct time checks still deny after the conservative deadline. No call-duration callback or process timer is trusted to extend authority.

No booking, modify/cancel appointment, SMS, calendar or custom structured-driver execution capability was added. Existing booking rules and StructuredPhoneDriver are unchanged. No new number/mobile onboarding, audio path or transcription implementation was added.

### Exact added configuration and activation prerequisites

Existing constructor properties above remain injectable. The installer adds these exact properties (not environment-variable names):

| Property | Value/default |
| --- | --- |
| `enabled`, `executionEnabled` | both false by default; both must be explicit true in the separately authorized sandbox boot |
| `businessId` | one verified lowercase 24-hex server-resolved business ID; never an email/model argument |
| `budgetId` | stable approved experiment identifier, 8–80 characters `[A-Za-z0-9_-]`; reuse unchanged across restarts, never automatically rotate |
| `agentsByBusiness` | exactly one entry keyed by that business ID, with pinned agent/version/language |
| `provider` | explicitly injected registration transport; no provider construction in this installer |
| `twilioAuth` | injected `authToken`, authoritative HTTPS `appBaseUrl`; canonical routes must match signed URLs |
| `signingKey` | designated Retell webhook-verification key, injected without logging |
| `models`, `RegistrationModel`, `BudgetModel` | existing read-only models plus shared durable registration/budget models; isolated models used in tests |
| `resolveBusiness`, `now` | existing application resolver/clock by default; synthetic resolver/clock for offline tests |

Before the first connected test: review/commit this exact patch separately; verify shared deployment Mongo indexes/write concern and approved single business/number mapping; provision the read-only EN/ES agent and pinned version with existing two tool schemas and public URLs; verify the Retell webhook key/config; explicitly compose the sandbox before JSON parsing in a separately authorized boot. Existing `/api/voice/incoming` and `/api/voice/dial-fallback` stay on the existing number. Ensure the public signed screening/status/complete endpoints are reachable. No provider/account/webhook configuration or deployment was changed here. The initial two-read/one-denial checklist above remains the target; no per-call total read quota or hard dollar cap is claimed.

Rollback: remove/disable the explicit installer (both flags false/absent), retire the current registration, end the test call through the existing approved telephony workflow, and leave the consumed budget row intact. Do not re-enable the custom owner for that in-flight call. Normal routes remain the default for future calls; no new number or service rollback is needed.

### Offline evidence and inventory

Affected worktree and exact clean-starting-HEAD overlay: **324/324 pass each**, no failures/skips/cancellations. This includes 24 new handoff checks using fake provider requests, real loopback HTTP hooks and isolated Mongo concurrency/restart tests, plus 300 existing affected tests. Original controller/router code is source-checked against the actual shared hooks; tests do not boot the production server or import its dotenv/provider/database startup. Eleven changed/new JavaScript syntax checks and both diff/whitespace checks pass. No provider acceptance, live call duration or real phone routing is claimed.

Current official Twilio sources: [Dial timeLimit, timeout and action](https://www.twilio.com/docs/voice/twiml/dial), [Sip screening and progress callbacks](https://www.twilio.com/docs/voice/twiml/sip), and [child ParentCallSid request field](https://www.twilio.com/docs/voice/twiml). These contracts justify emitted controls; offline TwiML assertions cannot prove carrier execution or live callback timing.

Evidence directory: `C:\Users\sanch\AppData\Local\Temp\retell-sip-4a1df0ac074643d4b0b76eb0928f7fed` (worktree/clean-overlay TAP, exact inventory, SHA-256 hashes and status). The exact 14-file round overlay is listed in the slice document; it excludes unrelated adapter/test edits, engineering documentation and standalone evaluation/lab directories.

## Actual export and startup completion — 2026-10-30

Starting HEAD: `4245db4dd3bee2763c93383265c410fd53991efb`. This uncommitted round supersedes earlier statements that the boot composition/environment parser is missing. `server.js` now awaits `mountRetellStartup(app)` at the existing pre-JSON location, after Stripe's raw webhook mount. It chooses exactly one disabled-prefix or enabled-sandbox composition. Production remains **disabled by default**; nothing was deployed or enabled during preparation.

### Actual local agent export

Read `C:\Users\sanch\Downloads\Retell Glō — Read-Only Test v0.json` without modifying/copying it into the repository. SHA-256: `64e91a5ba61ecd00dfd680de1194c992f063150ea02caf2fce360feb9400d7e6`. Its empty `agent_id` remains empty. The intended separately dashboard-supplied ID is `agent_1da974cf19d41a0b0e64b012d5`; neither export nor local configuration verifies ownership at Retell.

Both custom tools match: exact names, POST, the two intended Render URLs, JSON schemas, required availability arguments, `args_at_root: false`, empty custom headers, 3500 ms timeout and zero retries. The context schema omits `required: []`, which is semantically equivalent to the template. A leading tab in its description has no protocol effect. Built-in `end_call` is also present and does not grant appointment/SMS authority. The webhook URL matches `/api/voice/retell/events`; **webhook_events is absent**, so actual selections cannot be inferred. Select/verify call_started and call_ended separately.

Preserved export settings: cascading model `gpt-6.1-terra` standard tier; voice `retell-Claudia`; languages `en-US` and `es-419`; agent-first Spanish greeting `Hola, soy Glō, tu asistente virtual. ¿En qué puedo ayudarte?`; data storage `everything`, retention 30 days; caller DTMF enabled with empty options; timezone America/Los_Angeles; maximum agent duration 3600000 ms. No backend code overrides these, the prompt or response-engine configuration. The independent Twilio limit remains 120 seconds. Agent timezone is not the authoritative booking timezone: the tools supply business clock/timezone. Backend label-language configuration does not disable Retell's bilingual conversation.

The export prompt differs from the initial simple templates (including natural translation of familiar service labels); it is user-selected and unchanged. The connected tool set is read-only even though its prompt describes future action capabilities conditionally. No model/voice/provider compatibility, actual behavior or publication state beyond the saved export is inferred.

### Publication/version findings

The export's agent V0 and referenced Retell LLM V0 both say `is_published: false`. Current official [version documentation](https://docs.retellai.com/agent/version) permits draft versions for testing/phone-number use and states publishing preserves the number; [publish API](https://docs.retellai.com/api-references/publish-agent) publishes a chosen draft in place. The [phone registration contract](https://docs.retellai.com/api-references/register-phone-call) supports explicit version selection; it does not establish a published-only restriction. Therefore unpublished V0 is not a demonstrated protocol rejection. Registered SIP acceptance of this actual draft has not been tested.

For the repeatable checkpoint, use the dashboard's version panel to open the reviewed V0, verify tool/event settings, click Publish and confirm **V0**. Publishing V0 does not imply V1. Pin `RETELL_SANDBOX_AGENT_VERSION=0` only after confirming this is the reviewed version; if a different draft is chosen, configure that verified number explicitly. No publication action was taken. Publication is an immutable-configuration checkpoint recommendation, not a newly invented backend/API restriction; the parser accepts explicitly configured numeric zero.

`response_engine.version` selects the referenced LLM revision; `agent.version` selects the containing voice-agent revision. The [agent response contract](https://docs.retellai.com/api-references/get-agent) exposes both independently. Both happen to be zero here. Do not substitute the LLM version for the agent pin or assume future numbers match. Verify the published agent references the reviewed LLM/tools revision in the dashboard. The backend sends agent_id/agent_version only; it does not override the response engine.

The [custom-function contract](https://docs.retellai.com/build/single-multi-prompt/custom-function) documents name/args/call including call_id, agent_id, agent_version and ongoing status, matching our tool handler. [Lifecycle documentation](https://docs.retellai.com/features/webhook-overview) has an event/call wrapper; callback agent_version is optional here and known calls can omit metadata after binding. Registration supplies the attempt metadata for early-event correlation. Raw signature verification follows the [designated webhook key/raw-body contract](https://docs.retellai.com/features/secure-webhook). No missing provider field is synthesized or authentication weakened; actual signed deliveries remain unverified.

### Implemented boot configuration

`services/voice/retell/startup.js` reads only the two flags initially. Unless both are exactly lowercase `true`, it mounts the disabled prefix without reading secret properties or importing registration models. Missing/malformed required configuration also mounts that single disabled prefix; no provider request or phone ownership change occurs. Enabled setup creates `RegistrationTransport`, stages the installer on a private router, and attaches that one router/current phone hooks only after successful setup. This prevents the previous disabled-prefix shadowing problem and partial installation. It never imports the export file at startup.

Non-secret settings (no values were set in this task):

| Name | Required value shape/default |
| --- | --- |
| `RETELL_SANDBOX_ENABLED` | exact `true` to opt in; otherwise disabled |
| `RETELL_SANDBOX_EXECUTION_ENABLED` | independent exact `true`; otherwise disabled |
| `RETELL_SANDBOX_BUSINESS_ID` | required verified lowercase 24-hex business ID from trusted routing; no guessed value supplied |
| `RETELL_SANDBOX_BUDGET_ID` | required stable 8–80 character `[A-Za-z0-9_-]` approved experiment ID; never rotate/reset automatically |
| `RETELL_SANDBOX_AGENT_ID` | intended dashboard ID above by default; explicit override must match `agent_[A-Za-z0-9_-]{1,100}`; never read from the blank export ID |
| `RETELL_SANDBOX_AGENT_VERSION` | required canonical nonnegative safe-integer string, including `0`; no latest/tag/default version |
| `RETELL_SANDBOX_LANGUAGE` | `en` or `es`, default `es`; catalogue label projection only, not an agent language override |
| `APP_BASE_URL` | existing authoritative HTTPS origin, no credentials/path/query/fragment; intended `https://glo-backend-yaho.onrender.com` |

Secret **names only**, supplied through the backend service's secure runtime configuration:

- `RETELL_API_KEY`: registration API credential for the intended Retell workspace. A suitable existing workspace key may be reused; none was inspected.
- `RETELL_WEBHOOK_SIGNING_KEY`: key designated by Retell for webhook verification. It may be the same key only if that existing key has the webhook-verification designation for this workspace; no silent fallback to the registration key.
- `TWILIO_AUTH_TOKEN`: reuse the existing token for the Twilio account signing this number's requests. The sandbox enforces verification independently of legacy off/observe mode.
- Existing `MONGO_URI`: unchanged database startup configuration. Registration/budget repositories use that shared connection; deployment unique indexes/write concern and permissions still need verification. No new database secret or external store is added.

Keys are neither logged nor included in returned startup state. No key/provider/model/voice settings from the export are copied into environment configuration automatically. The registration request remains the same four-field identity/metadata body and zero-retry transport; no agent_override or speech request is added.

### Verification and future deployment/rollback

Worktree and exact seven-file clean-HEAD overlay: **341/341 affected tests pass each**, zero fail/skip/cancel (17 new startup checks plus 324 existing affected checks). Five changed/new JavaScript syntax checks, both diff checks, new-file whitespace and overlay SHA-256 checks pass. The enabled startup test uses the actual private-router installer, fake registration HTTP, real loopback signed raw JSON/form requests and an isolated cached Mongo child: configured V0/agent pass to registration, bind precedes SIP, screening/start activate tools, both read tools succeed, duplicates cannot dispatch again and completion denies further reads. Disabled/missing/invalid settings preserve normal HTTP routes and issue zero provider requests. No production server/dotenv/live database boot is run by these tests.

Exact round inventory:

```text
server.js
services/voice/retell/startup.js
tests/services/retellStartup.test.js
tests/services/retellReadOnlyTools.test.js
tests/services/retellReadOnlyComposition.test.js
docs/voice/RETELL_SANDBOX_CHECKPOINT.md
docs/voice/RETELL_IMPLEMENTATION_TRACKER.md
```

Evidence directory: `C:\Users\sanch\AppData\Local\Temp\retell-startup-8e631745e42b495bbcbe48e93443aad1` (export comparison, test TAP, inventory, overlay hashes/status). Unrelated adapters, engineering documents, evaluation/lab directories and the downloaded export are excluded from the overlay.

Remaining code: no additional boot/SIP handoff implementation is currently identified for this read-only checkpoint. Remaining operational steps: review/commit this patch separately, verify the authoritative business/number/account mapping and shared deployment database, publish/freeze the reviewed agent version and inspect lifecycle selections, deploy the approved build with both flags absent/false first, then separately authorize configuring one stable budget/agent/business plus secure keys and both true flags. Existing number/mobile routes remain; verify their canonical signed URLs and public tool/lifecycle/SIP callbacks. Do not execute a dashboard/web test as proof of phone registration. Retell model/voice acceptance, authentic signatures, early-event metadata, SIP connection, carrier timing and the real 120-second cutoff remain connected-test requirements.

Rollback: set `RETELL_SANDBOX_ENABLED=false` (or remove either opt-in flag) and restart the backend through the approved deployment workflow. Retire/end any active sandbox call using the existing authorized workflow; disabling startup does not itself hang up an already connected remote leg. Keep budget rows and the stable consumed ID; do not reactivate custom AI on that in-flight call. Default future calls use normal routing. No deployment, configuration, agent publication, provider request or call was performed in this task.


## 2026-11-02 booking/transcript offline slice

The operator-reported read-only checkpoint succeeded; budget glo_retell_checkpoint_001 remains consumed/ENDED and registration SUPERSEDED. The next separately gated single-catalogue-item prepare/commit and opted-in final transcript slice is implemented offline. See [RETELL_BOOKING_AND_TRANSCRIPTS.md](RETELL_BOOKING_AND_TRANSCRIPTS.md) for exact contracts, index/configuration requirements, checkpoint identities, privacy/retention and Mac/mobile facts. RET-B02/B03/B04/B05 and RET-O14 advance only for this bounded offline subset; RET-B06 covers SMS suppression only. General bundles, customer verification, existing-appointment mutations, durable inbox/PII policy and controlled real booking remain incomplete. RET-B07 remains BLOCKED pending separate deployment/effect approval. This dated entry supersedes earlier no-booking/no-transcript statements only for the described patch; no live acceptance or activation is claimed.

Validation: 389/389 affected checks pass in both worktree and exact task-only clean e4e8db8 overlay; zero failures/skips/cancellations. 23 JavaScript syntax checks and both diff checks pass. Isolated local Mongo replica-set transactions/indexes were exercised, not production. Exact 26-file inventory and remaining enablement/privacy/index/live prerequisites are in RETELL_BOOKING_AND_TRANSCRIPTS.md; external evidence directory is recorded there. Nothing staged, committed or activated.


## 2026-11-02 bounded booking envelope and development allowance

The reported PREPARED -> commit413 boundary is reproduced offline: full call history exceeds the prior booking-only32KiB parser limit before HMAC/commit. Booking parser is now bounded256KiB with exact raw signature/strict authorization retained. Actual live bytes remain unrecorded. Added a separately opt-in durable ten-attempt development run over unchanged single-use per-call budgets; immutable business/pinned-agent/version scope, atomic majority reservations, no retry/refund/reset and120-second per-call cap. Historical checkpoint001/002 remain untouched. See [RETELL_DEVELOPMENT_ALLOWANCE.md](RETELL_DEVELOPMENT_ALLOWANCE.md) for source chain, exact settings/provisioning, exhausted-call behavior, read-only proposal/command/checkpoint/usage command, controlled test and rollback. No activation, provisioning, dashboard publication or provider calls. Final validation evidence follows there.

Validation for this round: 404/404 affected tests pass in worktree and exact task-only clean865a595 overlay, zero fail/skip/cancel; nine changed-JavaScript syntax checks, both diff checks and new-file whitespace pass. Independent Mongo-client reconstruction and real isolated concurrent counters were exercised. Before-fix payload test retained413 versus expected200. Exact12-file inventory and evidence are in RETELL_DEVELOPMENT_ALLOWANCE.md. Development activation/provisioning, live booking confirmation and Render inspection remain separately authorized operations; checkpoints001/002 must not be reset.


## 2026-11-03 development duration snapshot

The latest offline patch selects300sec only for newly admitted explicit development calls, with120sec retained for single-call and historical unsnapshotted calls. Registration and per-call budget persist the selected duration and share one immutable bridge deadline. Proposal freshness remains60sec capped by remaining authorization; setup30sec, answer20sec, pinned identity, ten-attempt quota and SMS suppression remain unchanged. No new flag/index/provisioning, reset or activation. Preserve glo_retell_booking_dev_001 and consumed checkpoints. This dated policy supersedes earlier120sec statements only for new development admissions. See [RETELL_DEVELOPMENT_DURATION.md](RETELL_DEVELOPMENT_DURATION.md) for evidence limits, complete deadline trace, read-only call/proposal/outcome inspection, exact reviewed inventory, deployment and controlled-test/rollback procedure.

Duration-slice validation:429/429 affected checks pass in worktree and combined clean db5ab5b overlay, zero fail/skip/cancel; ten new duration cases pass. Exact16-file round versus19-file combined diagnostic overlay inventory and hashes are documented in RETELL_DEVELOPMENT_DURATION.md. Syntax/diff checks pass. All changes remain unstaged/uncommitted; no activation, production records, allowance/run ID, Retell dashboard or mobile settings changed.
