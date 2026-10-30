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
