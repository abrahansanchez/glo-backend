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

Per call: 12 admitted decision turns, four decision requests/turn and 48 total,
512 output tokens/request, eight calls/completed response, four decision transport
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
