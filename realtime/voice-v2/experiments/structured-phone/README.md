# Business-scoped structured phone experiment (offline preparation)

No deployment, calls, provider requests or live account lookups were performed.
This feature reuses the established Twilio webhook, mobile ring/AI takeover,
`/ws/media-v2`, V2 session admission, VAD/transcription, cancellation, TTS,
response/floor/playback registries and confirmation authority. No number, service,
onboarding or desktop capture application is added. The account email is never
routing authority; selection happens only after the existing production factory
resolves the called number and checks VOICE_V2_TEST_BUSINESS_ID.

## Selection and deployment prerequisites

New configuration, all disabled/empty by default:

- `ENABLE_VOICE_V2_STRUCTURED_PHONE`: only exact `true` enables selection.
- `VOICE_V2_STRUCTURED_PHONE_BUSINESS_IDS`: comma-separated verified 24-hex
  server-resolved business IDs; maximum 16. Empty/invalid/nonmatching lists keep
  the original V2 implementation. This does not bypass the existing V2 gate.
- `VOICE_V2_STRUCTURED_SERVICE_LABELS_JSON`: defaults to `{}`. Explicit trusted
  object keyed by business ID, then actual service ID, then `en`/`es`. For example
  the Spanish labels for the two intended real services must be supplied under
  their independently verified catalogue IDs. No name-based translation guesses.
  Missing labels retain the actual canonical name; unknown IDs or malformed
  selected-business labels fail closed rather than silently selecting another ID.

Existing `ENABLE_VOICE_V2_ROUTE=true` and `VOICE_V2_TEST_BUSINESS_ID` remain required.
Reuse existing APP_BASE_URL, Twilio authentication/configuration, OPENAI_API_KEY,
OPENAI_MODEL, OPENAI_TTS_MODEL/VOICE and the existing deployment service. Check that
the configured model supports text/function Realtime output. Keys are not passed
to model context or logs. TTS remains the existing configured adapter; no speed,
format, provider or pronunciation experiment is added.

Before any separately authorized phone test: verify the live
`probando@glo.com` -> Barber ID -> called-number mapping and actual catalogue IDs,
timezone, hours, prices and durations using the established authorized workflow.
Do not copy synthetic test IDs. Confirm the deployed commit contains the reviewed
feature and its import dependencies (the current HEAD alone does not). Preserve
the existing webhook/number/mobile registration. Verify a selected-route diagnostic
for the intended business before treating any call as simulation-only; a disabled
or mismatched selector deliberately retains the normal booking-capable route.
Confirm that the chosen incoming/fallback or app-takeover entry point actually
supplies the called/caller numbers in Twilio start parameters. The existing
controller builds those parameters from request.body; this task does not alter
that controller or establish the live app-takeover payload. The normal incoming
dial-fallback path has Twilio's caller/called fields. Provider recording/retention
settings and live start metadata have not been inspected.

Rollback: set the new enable flag false (or remove its allowlist), use the existing
Render configuration/restart workflow, and let active experimental sessions end
or explicitly end them. Never switch an active session to the old driver. Keep the
previous deployed revision available. No webhook/database schema changes to undo.

## Integration and evidence

The V2 production initializer constructs experimental dependencies only for an
allowlisted resolved business. V2 finalized-turn admission chooses exactly one
decision owner. Experimental turns return before the ordinary interpreter,
reducer/effect planner. A bounded separate text/function Realtime connection is
used for decisions, retaining the established intake connection unchanged. This
avoids changing the pre-existing shared adapter/protocol modifications. This is
an intentional extra connection, with its own latency/usage, not a claim that the
phone input and successful offline lab already share one protocol configuration.

The decision driver receives the actual admitted transcript, authoritative clock,
timezone, current proposal, opaque catalogue IDs and tool results. It has no
FixtureBusiness, scenario score, synthetic proposal state or answer guidance.
Whole completed tool batches are structurally checked before dispatch. Purpose
schemas reject arbitrary speech/fact fields. Tool state changes are atomic;
selected alternative references resolve against their originating version and
complete ordered bundle before ordered edits invalidate that evidence. The
selected date/time remains requested intent, not proof of availability. No time
is inferred from an affirmative. Ordinary rendering distinguishes requested intent
from verified availability and prefixes offers with known negative reasons.

LiveBundleAvailability loads actual business data; IDs and canonical names must be
unique. Currency prices must be nonnegative finite cents and every requested
duration a positive integer. Bundles above eight services/480 minutes or missing
facts are explicitly unsupported, never checked as only a primary service.
Sequential-service semantics are sum(durationMinutes); sum(price) uses cents.
The existing isSlotAvailable/getAvailableSlots helpers receive that exact duration
and unchanged business timezone/hours/blackouts/buffer and appointment-overlap
rules. Their existing scheduling scan steps by 30 minutes. Alternatives are
searched for at most seven days, maximum three, and individually rechecked using
the full bundle. Booking dates are bounded to the business-local current day plus
30 days. The experiment does not redefine appointment persistence to represent
bundles: real booking remains permanently disabled in this mode.

Evidence includes a fingerprint of current catalogue/prices/durations, scheduling
configuration and explicit labels, ordered IDs and proposal version. Availability
references expire after 60 seconds. Pending messages have a private application
binding with current turn and generation; the model cannot manufacture it.
Business and bundle availability are rechecked before synthesis, after synthesis,
after assistant transcript persistence immediately before media writes, and before
accepting confirmation marks. Late asynchronous results cannot refresh an old
generation. A changed business timezone ends the session rather than silently
rebinding immutable call identity.

Requested slots and alternatives must be strictly after the current instant in
the business timezone, using the availability port's injectable application clock.
Checks run before and after asynchronous scheduling reads and again at subsequent
speech/confirmation applicability checks, including after the final business
read. A stale business snapshot cannot freeze the clock. Past/equal requested
times remain requested intent but are unavailable and cannot receive canonical
confirmation. No additional lead-time interval is introduced.

External business/appointment reads are observations, not an atomic reservation;
another booking can still change a slot after a read. Applicability checks are
bounded to five seconds and discard late results; underlying database read APIs
are not represented as cancellable transactions. A future real booking integration
would still require its normal transactional recheck. This mode cannot book.

## Playback, effects and cancellation

All response wording, including greeting and complete localized bundle/price
confirmation, is application-owned. The existing exact speech validator, TTS
preparation and media/mark lifecycle remain authoritative. No decision-model
audio is delivered; unexpected intake-model audio ends the experimental session.
Driver callbacks do not hold the intake queue across model I/O. Incoming speech
immediately retires its generation; existing V2 cancellation aborts stale TTS,
invalidates/clears playback and revokes confirmation proof.

The experimental session exposes a Twilio facade rather than the raw adapter.
Its clear operation synchronously retires pending driver work, aborts pending
synthesis and invalidates affected response/playback/confirmation evidence before
sending clear. Returned or duplicate marks cannot turn cancellation into delivery;
mark validation also rechecks the registry after asynchronous applicability work.
The default nonexperimental Twilio interface is unchanged.

Only a current validated completed confirmation, successful submitted media and
the matching uninterrupted Twilio mark can grant existing confirmation authority.
Duplicate, foreign, cleared and stale marks cannot grant it. A current affirmative
must also pass the existing deterministic confirmation extractor as a veto; no
caller phrase rules are added. Early/uncertain/negative replies cannot authorize.
Language follows the resolved business preference (en fallback); this mode adds
no language-inference classifier or expanded consent grammar.

The best possible consent outcome is an explicit `WOULD_AUTHORIZE` simulation.
The rendered result says that no appointment or messages were created. There is
no switch enabling real effects in this mode. Unknown create/modify/cancel/SMS
tools are terminal. The V2 effect loop refuses all queued effects in experimental
sessions, with additional create/SMS handler guards. Existing shared booking/SMS
adapters must have zero executor calls, including failures and cleanup. Canonical
confirmation/consent authority is not bypassed to get a successful test result.

Retained side effects: existing call/transcript finalization and persistence,
diagnostic logs, existing app missed-call pushes, and provider audio/transcription
processing. No new microphone/audio-file recording is introduced. Unrelated
existing reminder jobs and other accounts' normal functionality are not disabled.
New logs contain build/call identity, selected mode, counters, bounded tool status,
timings, interruption and mark disposition; no raw model arguments, provider
envelopes, keys or authorization headers. Existing production recording/logging
policies remain in force.

## Limits and testing

Per call: 12 admitted decision turns, one decision request/turn and 12 total,
512 output tokens/request, one decision call/completed response, four decision transport
constructions maximum (plus one unchanged intake connection), 16 TTS requests
including greeting/recovery, zero retries, 20-second decision deadline,
60-second TTS preparation deadline and 180-second call deadline. Existing 30-second
caller-silence/playback watchdogs remain; experimental caller silence ends the call
instead of inserting an old single-service confirmation. Startup, model, effect,
deadline and disconnect failure close active resources and invalidate pending work.
These limits do not establish a dollar spending cap. Twilio marks are transport
playback completion evidence, not direct measurement of when a human heard audio.
Known TTS body delays remain possible; this task makes no latency promise.

Offline tests use actual V2 session interfaces, fake Twilio/input/model sockets,
fake TTS, and injected real-port business data/availability. They exercise both
languages, non-fixture IDs, both combined-change orders, invalid batches, unsupported
bundles, state changes during synthesis and persistence, old/foreign marks,
interrupted pending speech, negative/early consent, simulated valid consent,
request/turn/deadline limits, default selector composition and zero effect calls.
The old lab inventory guard was narrowed to recognize the two now-authorized
production composition files; it still protects package/summary files and blocks
synthetic-lab imports from production. It is a local legacy-lab test adjustment,
not a dependency of the minimal phone-feature commit.

Proposed minimal commit inventory: the four JavaScript modules and this README
in this directory; initializeVoiceV2Session.js;
production/createVoiceV2ProductionInitializer.js; and
tests/integration/structured-phone.test.js. Exclude the pre-existing shared adapter
and speech-undici test edits, evaluation artifacts, and the standalone lab files.
No files have been staged or committed during preparation.

## Live-failure diagnostics

Decision failures log a bounded stage/category/code and allowlisted provider
code/type/parameter, plus turn/request/connection counts. Business read/validation,
connection/configuration, request, argument validation, tool dispatch, plan and
speech submission are distinguished before cleanup. Unknown values are UNKNOWN
or UNCLASSIFIED; no arbitrary exception messages, stacks, model arguments, raw
provider payloads or headers are emitted. A configuration rejection is evidence
only for its reported parameter, not proof of a particular schema defect.

Failure callbacks are bound to the owning decision connection. Delayed failures
from retired connections cannot terminate their replacement; a failure on a reused
current connection still stops the call. Existing cancellation/limits are retained.
Structured admitted turns now enter turn counters after overlap quarantine, and
explicit structured failures are classified even after a delivered greeting.
Structured HTTP speech byte counters describe successful media submission, not
provider-generated chunks or proof of audible playback.

Greeting speech is currently requested after Twilio start and intake configuration
acknowledgment, then waits for complete HTTP WAV delivery, conversion/validation
and persistence before media submission. This is not an immediate or streaming
greeting guarantee. Missing earlier phase logs or saved WAV evidence cannot prove
the cause of provider/header delay or a subjective slow-speech report. This repair
does not change synthesis format, speed, pacing, prompts or startup authority.

## Catalogue compatibility

Existing production readers accept stored name/price/durationMinutes entries
without a subdocument ID. For those entries only, the structured adapter derives
an opaque `legacy:` plus SHA-256 handle from the exact stored name. It is stable
across catalogue ordering and is not a claimed/persisted database ID. Existing
IDs are preserved; malformed supplied IDs, duplicate IDs and duplicate names stay
rejected. Hash collisions are also rejected by the ID uniqueness check.
No names, prices, durations or translations are filled in. Zero prices remain
zero; missing/invalid bundle price or duration remains unsupported. Canonical
names remain usable without Spanish localization configuration.

Catalogue rejection diagnostics include only allowlisted catalogueField and
catalogueCategory values (list/size, ID, or name failures). They contain no service
names/IDs, account data, service lists or transcripts. The synthetic missing-ID
compatibility defect is reproduced from an existing production test fixture;
the supplied aggregate live error alone does not prove which live guard failed.

Preservation tests use Mongo service ID `507f1f77bcf86cd799439011` unchanged through
draft selection, ordered bundle checks, alternative selection and canonical
confirmation. ID-less handles are deterministic; accepted catalogues always have
unique handles, and a collision with a supplied ID or another handle rejects.
Raw catalogue records are not mutated, and the simulation never writes handles
as database IDs. These synthetic proofs do not identify CA0543's live guard.

## Bounded latency preparation

The observed 9.902 seconds from turn readiness to speech admission comprised
5.783 seconds of model requests and 1.282 seconds of measured tools, leaving
approximately 2.837 seconds of application/freshness work and other overhead.
This residual is not provider compute time and is not a promised saving.

The original availability tool still discovers alternatives. Subsequent freshness
checks use the same full-duration slot predicate for the requested slot and up to
three selected alternatives, rather than regenerating full-day alternative lists.
They preserve ordered services, exact prices/durations, timezone, buffer, business
revision, proposal/turn generation, future-time checks and final business reads.
The adjacent duplicate outer pre-synthesis check is removed; requestResponse owns
that check. Post-synthesis, pre-media and mark-boundary checks remain independent.
Simulated authorization also rechecks its slot without discovering alternatives.
No freshness result is cached across an asynchronous release boundary.

Finite freshness start/completion and speech-handoff events record current/failed,
timed-out or retired-generation outcomes and bounded request bindings. A handoff
PREPARATION_ACCEPTED event means local TTS preparation was accepted, not that HTTP
headers, speech delivery or playback occurred. Existing transport events provide
those later boundaries. No transcripts, wording or provider payloads are added.

Proposed header-wait policy, NOT implemented here: abort a still-current speech
attempt after five seconds without headers, with zero retries; use the existing
validated local recovery asset and controlled end only if the caller has not
interrupted and the generation remains current. Missing local assets fail closed.
Retire old delivery evidence before recovery and never reuse confirmation proof.
This would bound the observed 12.055-second wait but can discard a response that
would later succeed; it does not identify the remote cause or impose a cost cap.
Streaming after headers cannot remove a pre-header wait. Existing header/time
budgets, provider/model/voice settings and interruption behavior are unchanged.

## Confirmation readiness recovery

The recorded Wednesday 09:00 helper checks returned available. The old
FRESH_BUNDLE_REQUIRED response conflated missing name with missing, expired,
revision-mismatched, proposal-mismatched or ordered-service-mismatched evidence,
and with an unavailable result. The private tool envelope and name presence were
not logged, so missing name is a source-based inference, not a recorded account fact.

Eligibility now returns bounded eligibilityReason, missingFields, available,
evidenceCurrent and nextAction fields. Missing draft information is not proof that
the caller omitted it. Availability OK describes a completed check, not necessarily
an available slot or permission to confirm.

The current single-decision path interprets the whole caller turn once, then
uses application-owned tools and rendering. The earlier fourth-response recovery
loop and follow-up response-plan requests are no longer used. Ready evidence
produces canonical readback, missing draft fields produce the existing collection
question, and unavailable results produce verified explanation/current alternatives.
Unknown/stale evidence cannot produce confirmation. All asynchronous release and
mark freshness checks remain independent; neither rendering nor submission grants
consent, delivery acknowledgment or booking authority.
Ordinary offers omit service enumeration; canonical readback retains it. Generic
unavailability describes the requested time, without inventing an hours or closure
cause. Only a verified BUSINESS_CLOSED result supplies a closure explanation.

For CA3865975fc7f03273342a90b5638cb712, confirmation-turn requests 11–14
took 2.275, 1.974, 1.674 and 2.826 seconds (8.749 seconds total).
Request 13 returned successful canonical eligibility; request 14 merely selected
the corresponding plan. Consent request 15 returned WOULD_AUTHORIZE; request 16
took another 2.020 seconds to select the simulation explanation. These successful
single-tool results now use application-owned rendering without those subsequent
model requests. Offline EN/ES journeys prove confirmation 4→3 requests and
delivered consent 2→1 with the same rendered meaning. These counts do not promise
live latency savings or change TTS, freshness, interruption or request limits.

## One decision per accepted caller turn

The old tool/response-plan schema required model continuations and could not
express an explicit later-than bound or a question answer in the renderer.
Only submit_turn_decision is now sent to the decision model. It contains current
turn/version/business/ordered-service/language bindings; up to eight ordered
changes; REQUEST, QUESTION, CONFIRMATION, CLARIFY or UNSUPPORTED intent; proposed
confirmation meaning; typed PRICE, DURATION or AVAILABILITY questions; and an
optional supported missing-field request. No predicted outcome or arbitrary speech
field exists. Unsupported questions/intent must be explicit UNSUPPORTED and stop,
not be reduced to a supported subset. Model interpretation remains fallible.

Changes support existing catalogue operations, exact ISO calendar dates, explicit
bounded ISO date ranges, exact times, names, current alternative references,
MORNING/AFTERNOON and an explicit AFTER HH:mm bound. A date range is held separately
from the proposal date: it never silently selects its first day. Range alternatives
retain an explicitly requested time and are filtered at discovery and release.
The existing seven-day bounded alternative search remains; it does not prove
unavailability throughout a longer range. Exact date/alternative selection ends a
date preference; a later exact time correction replaces an older time preference.

The driver validates the whole decision and current bindings before dispatch.
Atomic ordered changes run first, then actual full-bundle availability, then
application eligibility/rendering. No model request follows a local result. Genuine
current affirmative meaning still goes through existing caller-evidence veto,
message-bound completed playback authority, fresh availability and simulation-only
checks. Blocked affirmative renders the existing delivery gate. Unsafe, foreign,
ambiguous, unsupported or rejected decisions with no supported clarification stop
with bounded diagnostics; they do not get another model attempt. Tool results and
pending questions are returned in one function output and next-turn context.

PRICE and DURATION answers use validated catalogue money/duration; AVAILABILITY
answers use current bundle evidence and retain independent release checks. A
question needing a missing service/date stays pending while the application asks
for that information. Existing canonical text, localized ordered services and
confirmation authority are retained. No caller phrase lists or scenario answers
are supplied. Greeting uses zero decision requests. Speech synthesis and its
headers/body waits, the single model request wait, transcription/turn admission
and independent freshness work remain. These offline counts are not live speed
measurements.

## Incremental accepted-sentence audio

Only structured-phone plans with private current bindings opt in to early WAV
decoding. The provider request remains WAV; headers must identify 24 kHz mono
16-bit PCM. The existing three-sample averaging/G.711 converter is reused on
aligned groups, retaining split sample bytes across HTTP chunks. Complete 160-byte
PCMU frames are submitted; a final short frame is released only after successful
body/format validation, without padding or duplicated audio. WAV headers and
metadata never become Twilio payloads. Header parsing and retained audio are
bounded to 64 KiB and 32 MiB respectively. Other speech consumers keep the existing
complete-buffer behavior.

The exact application sentence is validated and persisted before first media.
The existing fresh evidence check runs before each received converted batch;
turn/proposal/floor/cancellation ownership is also checked at each frame write.
Mid-body failure clears partial playback through the existing failure path.
Interruption or changed evidence prevents further frames. Post-synthesis and
mark-acknowledgment checks remain. There is no mark, completed response or
confirmation delivery proof for a partial body. One final mark follows successful
EOF, conversion and submission of every frame; it still requires a genuine Twilio
acknowledgment. Deleting/clearing queued audio cannot undo sound already consumed.

Controlled fixtures: first HTTP byte 20 ms, first decodable sample group 45 ms,
first complete-frame submission 50 ms, body completion/final mark 100 ms. The
buffered control first submits at 100 ms. An all-at-end fixture has first byte,
decodable audio and first media at 100 ms and gets no earlier start. These are
virtual fixture times, not live latency measurements or audible playback times.
The supplied CAd5c2809f5a74903fca7e0582f64af0e8 evidence does not locate decodable
samples inside HTTP chunks, so live early-audio availability remains unverified.
No second request, retry, voice/rate change or timeout change is introduced.
At the streaming commit, the separate 3 PM INVALID_PLAN hangup and spoken-time/date formatting were outside that patch; the bounded follow-up is documented below.

## Offered-time corrections and spoken slots

The streaming change above was committed independently. A later offline repair
proves a schema/execution mismatch: CONFIRMATION/CORRECTION with explicit ordered
changes was schema-valid but rejected before applying a valid current alternative
or exact time. Such decisions now execute only their validated changes, fresh
bundle check and application rendering; they never submit consent. AFFIRM with
changes remains rejected. CLARIFY with no missing field and current alternatives
re-renders those verified alternatives without selecting or mutating a slot.
Without current alternatives it still stops. Explicit availability questions may
offer actual current slots without requiring an invented exact requested time.

The exact live decision for CAd5c2809f5a74903fca7e0582f64af0e8 was not saved.
These synthetic reproductions do not establish its initiating INVALID_PLAN guard.
TRANSCRIPTION_UNRESOLVED in the summary does not identify that initiating cause.
DECISION_REJECTED now records only an allowlisted guard, local stage, turn and
existing call/build correlation. Structural, foreign, stale, unsafe and unsupported
decisions do not receive generic successful recovery. No raw decision, rejected
string, transcript, catalogue or provider payload is added to these diagnostics.

Phone-only spoken slots group consecutive same-day alternatives and use business
clock/timezone-relative today/tomorrow or an explicit weekday/month/day (year when
needed). English uses 12-hour AM/PM, noon and midnight. Spanish uses natural hour
phrases, mediodía and medianoche. Canonical phone readback retains service order,
name, price and its booking question; only its date/time presentation changes.
Internal ISO dates, 24-hour times, opaque alternative IDs and authority remain
unchanged. The shared production confirmation renderer is not modified.
Date-bearing speech is also bound to its business-local reference day so a
midnight crossing cannot release stale relative wording or acknowledge it.

Example alternatives: "I can offer tomorrow at 2 PM or 2:30 PM or 3 PM. Which
would you prefer?" / "Puedo ofrecer mañana a las dos de la tarde o a las dos y
media de la tarde o a las tres de la tarde. ¿Cuál prefieres?"
The whole-conversation latency issue remains open. This repair changes no model,
speech transport, timeout, speaking rate, scheduling policy, request ceiling or
booking/SMS execution boundary. Part 2 remains unstaged for independent review.

EN/ES offline journeys now use one request for each of eight turns. Baseline
comparable turns used 2 (missing date), 3 (afternoon), 3 (correction/name), 2 (early
affirmative), 2 (repeat confirmation), and 1 (delivered affirmative). The explicit
later-than and combined price/duration question turns are new contract coverage;
there is no equivalent complete baseline meaning/count to claim. Legacy compound
changes alone used three requests but did not answer those questions. Canonical
wording is checked byte-for-byte against the unchanged canonical renderer.
