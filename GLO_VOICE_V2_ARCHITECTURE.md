# GLO VOICE V2 ARCHITECTURE CONTRACT

**Status:** Pre-coding architecture contract  
**Purpose:** Define the non-negotiable design rules for Glō Voice V2 before implementation begins.  
**Current V1 production baseline:** `ce38da23b4e805b54345d39b077f1f1bf41b62de`  
**V1 status:** Frozen reference implementation. Do not continue patching V1 except for an emergency production safety issue explicitly authorized outside this plan.

---

## 1. Executive decision

Glō Voice V2 exists to replace the **conversational coordinator**, not to rebuild Glō.

Voice V1 demonstrated that the current product can already:

- receive and route Twilio calls
- connect to OpenAI Realtime
- transcribe callers
- recognize English and Spanish
- resolve barber/business configuration
- check real availability
- generate real alternatives
- create appointments
- send confirmation SMS
- persist transcripts/outcomes
- power the existing mobile app and dashboard

The part that is not reliable enough for beta is the **semantic orchestration layer** between a finalized caller turn and the authoritative booking state.

The core V1 defect is:

> A finalized caller turn can be interpreted and mutated by multiple independent handlers before the turn is finished processing.

A caller can say one thing, one handler can correctly identify it as a time modification, and a later unrelated handler can still reinterpret or discard the same turn.

Voice V2 fixes this by enforcing one architectural rule above all others:

> **ONE FINALIZED CALLER TURN → ONE SEMANTIC INTERPRETATION → ONE CONTROLLED STATE TRANSITION.**

---

## 2. Why V1 is frozen

The latest repository audit classified the current coordinator as:

`V1_COMPLEXITY_LIMIT_REACHED`

The V1 coordinator contains transport ownership, confirmation classification, name handling, service handling, date/time parsing, alternative selection, availability state, response generation, retry/recovery, booking execution, and playback lifecycle inside one large semantic path.

A proper centralized transition system retrofitted into V1 would require replacing most of the semantic core while keeping legacy handlers alive during migration. That creates a higher production blast radius and risks two competing coordinators existing simultaneously.

Therefore:

- V1 remains available as a stable comparison baseline.
- V1 business logic may be reused behind adapters.
- V1 semantic orchestration must not be copied wholesale.
- No phrase-by-phrase V1 repair program continues in parallel with V2.
- All new architectural work goes into `voice-v2/`.

---

## 3. Production evidence that defines V2 requirements

### 3.1 English post-confirmation ownership failure

CallSid:

`CAd58bd75a2bf25f73c4cff10676e2c288`

State:

- intent: BOOK
- name: Esteban
- service: Haircut
- date: 2026-08-26
- time: 9:00 AM
- awaiting confirmation

Caller:

`Actually, wait, can we make that 9:30 instead?`

Observed:

- confirmation modification was recognized
- old confirmation authority was invalidated
- same transcript continued through later routing
- a name-related guard consumed the turn
- 9:30 slot replacement never completed

Required V2 action:

`MODIFY_TIME(time=9:30 AM)`

No name/service/alternative/confirmation handler may independently reinterpret that turn.

---

### 3.2 Spanish half-hour modification failure

CallSid:

`CA992b314ad18494f13421bb6c595736bb`

State:

- Roberto
- Haircut
- 2026-08-25
- 2:00 PM
- confirmation stage

Caller:

`Puedo cambiarla para las dos y media?`

Expected:

`MODIFY_TIME(time=2:30 PM)`

V1 contains Spanish half-hour understanding in some parser paths, but the utterance did not reach a single canonical modification transition.

Required V2 behavior:

English and Spanish may use different normalization rules, but they must resolve to the **same domain action model**.

---

### 3.3 Spanish unavailable-time flow that partially worked

CallSid:

`CAb4cc0a490516338e4050eb72ddc49660`

Observed working business behavior:

- Spanish booking intent recognized
- Haircut recognized
- requested time recognized
- slot correctly reported unavailable
- real future alternatives generated
- Spanish alternatives spoken

Yet the call later ended without a completed booking.

Required V2 lesson:

Do not rewrite the proven availability engine. Replace the conversational state orchestration around it.

---

### 3.4 Working English correction control

CallSid:

`CA07dcca1d0194d7168dfcb1f30c7fc36d`

Caller:

`Actually, let me change the time to 11 a.m`

Observed:

- modification recognized
- old slot state reset
- time replaced with 11:00 AM
- fresh availability path executed

Required V2 lesson:

Conceptually equivalent actions must behave equivalently regardless of wording.

---

### 3.5 True end-to-end successful booking

CallSid:

`CAa58ccbdaa986a54b9767f95e851f6d02`

Observed:

- unavailable requested time
- alternatives
- alternative selection
- name collection
- confirmation
- caller changes time
- fresh confirmation
- fresh affirmative
- exactly one appointment
- exactly one SMS
- final confirmation
- clean call termination

Required V2 lesson:

The underlying business and telephony stack is reusable and already capable of success.

---

## 4. V2 scope

### V2 WILL replace

- semantic caller-turn ownership
- booking proposal mutation logic
- correction handling
- alternative selection coordination
- confirmation authority coordination
- proposal-bound availability state
- response/proposal correlation
- deterministic semantic action routing
- call event journaling
- side-effect command ownership

### V2 WILL NOT rebuild unless later evidence requires it

- Twilio inbound routing
- Twilio Media Streams
- OpenAI Realtime connection
- barber lookup
- business configuration
- services/durations
- timezone rules
- business hours
- blackout logic
- availability algorithms
- appointment persistence
- SMS provider integration
- transcript storage
- authentication
- dashboard
- mobile app

---

# 5. Non-negotiable architecture invariants

These rules override convenience.

## INV-1 — One turn has one semantic owner

Every finalized caller turn receives a unique `turnId`.

Exactly one `CallerTurnInterpretation` is produced for that turn.

After interpretation:

`consumed = true`

No unrelated semantic handler may process the same turn afterward.

---

## INV-2 — Interpretation happens before mutation

No interpreter or extractor may mutate booking state.

Flow:

`raw transcript → normalize → classify → extract needed fields → validate interpretation → reducer`

Only the reducer may produce a new booking proposal.

---

## INV-3 — Action first, fields second

Do NOT ask all field extractors whether they match the turn.

Bad:

`ServiceExtractor + DateExtractor + TimeExtractor + ConfirmationExtractor all inspect same turn independently`

Correct:

1. classify one action
2. invoke only the extractor(s) required for that action

Example:

`MODIFY_TIME` → `TimeExtractor` only

`SET_NAME` → `NameExtractor` only

`SELECT_ALTERNATIVE` → `AlternativeExtractor` only

---

## INV-4 — VoiceCoordinator is stateless

`VoiceCoordinator.js` may sequence work.

It may not own booking facts.

It may not perform partial booking mutation.

It may not independently set confirmation/availability flags.

---

## INV-5 — CallSession is the sole stateful aggregate

All current call state belongs to one `CallSession`.

However, domain state should still be replaced atomically, not freely mutated.

Booking changes occur through:

`BookingReducer(currentProposal, action) → nextProposal + effects`

---

## INV-6 — BookingProposal is immutable by convention and replacement

Any material booking fact change creates a new proposal version.

Material facts:

- service
- date
- time
- caller name when confirmation depends on it

No module modifies those fields in place outside the reducer.

---

## INV-7 — Proposal version binds authority

Every availability result, critical response, confirmation delivery record, and booking command must be tied to a `proposalVersion`.

If the proposal version changes, older artifacts become stale automatically.

---

## INV-8 — Phase is derived, not authoritative mutable state

Do not reintroduce V1-style independently mutable phases such as:

- awaiting_name
- awaiting_confirmation
- awaiting_alternative
- collecting_service

The next required conversational step must be derived from current proposal facts and lifecycle state.

---

## INV-9 — Availability belongs to a proposal version

An availability result is valid only for the exact service/date/time proposal that produced it.

Proposal change ⇒ old availability cannot authorize anything.

After an authoritative availability result is applied, that transition also owns deterministic response-purpose selection: `AVAILABLE` derives the next collection or `PRE_BOOKING_CONFIRMATION` purpose from the resulting proposal; `UNAVAILABLE` with alternatives yields `OFFER_ALTERNATIVES`; `UNAVAILABLE` without alternatives yields `SLOT_UNAVAILABLE`; infrastructure failure yields `ERROR_RECOVERY`; and a stale result yields no response. The pre-check `NEEDS_AVAILABILITY` requirement remains distinct from every completed availability outcome.

---

## INV-10 — Confirmation belongs to a proposal version

A caller affirmative can authorize booking only when:

- it follows a confirmation for the current proposal version
- that confirmation response completed successfully
- its audio was submitted
- its playback belongs to the current proposal
- playback was not invalidated/interrupted
- confirmation authority is still current

---

## INV-11 — OpenAI completion is not playback completion

Maintain separate:

- OpenAI `ResponseRegistry`
- Twilio `PlaybackRegistry`

Do not merge these into one authority object.

A thin correlation layer may map:

`responseId ↔ markId ↔ proposalVersion`

but holds no booking authority itself.

---

## INV-12 — Side effects are commands, not arbitrary function calls

Appointment creation and SMS must execute only through explicit side-effect commands.

Every command requires:

- `commandId`
- `proposalVersion`
- `type`
- `idempotencyKey`
- `attempt`

---

## INV-13 — Unknown is safer than multi-handler guessing

If interpretation is not confident:

`UNKNOWN` or `CLARIFY`

Do not allow several semantic handlers to guess independently.

---

## INV-14 — LLM interpretation has zero authority

LLM fallback output is untrusted structured input.

It must conform to `CallerTurnInterpretation`.

The reducer validates it.

The LLM may never directly:

- modify a proposal
- mark a slot available
- authorize confirmation
- create an appointment
- send SMS

## INV-15 — Caller turns are serialized through semantic processing

Per call, only one finalized caller turn may be in-flight through interpretation and reduction at a time.

`TurnRegistry` owns turn serialization in addition to turn identity.

If a new caller turn arrives while the previous turn has not finished semantic processing:

- the new turn may be captured and queued
- it may interrupt active assistant playback according to lifecycle policy
- it may not race the previous turn through `TurnInterpreter` or `BookingReducer`
- proposal replacement from two turns may never execute concurrently

Semantic processing order must therefore be deterministic per call.

---

## INV-16 — CLARIFY and UNKNOWN never mutate the proposal

For `CLARIFY` or `UNKNOWN`, the reducer returns:

```js
{
  nextProposal: currentProposal,
  proposalChanged: false,
  effects: [
    {
      type: "REQUEST_CLARIFICATION",
      ...
    }
  ]
}
```

The exact clarification payload may vary by context, but:

- no authoritative booking fact changes
- no availability result is invalidated unless a separate prior action changed the proposal
- no confirmation authority is granted
- no booking side effect is emitted

---

## INV-17 — LLM fallback utilization is measured

V2 is deterministic-first, but the LLM fallback is treated as potentially load-bearing until production evidence proves otherwise.

Phase 2 and later acceptance runs must record:

- total finalized caller turns
- deterministic classifications
- LLM fallback classifications
- LLM fallback success rate
- LLM fallback `UNKNOWN`/`CLARIFY` rate
- action classes most dependent on fallback

The purpose is to measure whether the deterministic layer genuinely handles the common conversation surface.

If a large share of ordinary acceptance-matrix turns require LLM fallback, the LLM path must receive the same lifecycle, regression, and load testing attention as a primary interpreter path rather than being treated as exceptional.

---

---

## INV-18 — Historical production failures become permanent tests

Every confirmed production failure must become a scenario fixture.

No fix is considered complete without preserving the failing CallSid scenario as regression coverage.

---

# 6. Final directory structure

```text
realtime/
└── voice-v2/
    ├── index.js
    ├── VoiceCoordinator.js          # stateless sequencer
    ├── CallSession.js               # sole stateful aggregate
    │
    ├── domain/
    │   ├── CallerAction.js
    │   ├── BookingProposal.js
    │   ├── BookingReducer.js
    │   ├── PostBookingReducer.js
    │   ├── AvailabilityState.js
    │   └── ConfirmationState.js
    │
    ├── interpretation/
    │   ├── TurnNormalizer.js
    │   ├── TurnInterpreter.js       # ONE semantic owner
    │   ├── LlmFallbackClassifier.js
    │   └── extractors/
    │       ├── NameExtractor.js
    │       ├── ServiceExtractor.js
    │       ├── DateExtractor.js
    │       ├── TimeExtractor.js
    │       ├── AlternativeExtractor.js
    │       └── ConfirmationExtractor.js
    │
    ├── lifecycle/
    │   ├── TurnRegistry.js
    │   ├── ResponseRegistry.js
    │   ├── PlaybackRegistry.js
    │   ├── ConfirmationAuthority.js
    │   ├── EffectQueue.js
    │   └── SessionWatchdog.js
    │
    ├── planning/
    │   ├── NextActionPlanner.js
    │   ├── ResponsePlanner.js
    │   └── SpeechValidator.js
    │
    ├── ports/
    │   ├── AvailabilityPort.js
    │   ├── BookingPort.js
    │   ├── SmsPort.js
    │   ├── TranscriptPort.js
    │   └── VoiceTransportPort.js
    │
    ├── adapters/
    │   ├── TwilioMediaAdapter.js
    │   ├── OpenAIRealtimeAdapter.js
    │   ├── V1AvailabilityAdapter.js
    │   ├── V1BookingAdapter.js
    │   ├── V1SmsAdapter.js
    │   └── V1TranscriptAdapter.js
    │
    ├── journal/
    │   ├── CallJournal.js
    │   └── JournalEvents.js
    │
    ├── prompts/
    │   ├── english.js
    │   ├── spanish.js
    │   └── criticalSpeech.js
    │
    └── tests/
        ├── unit/
        ├── transitions/
        ├── scenarios/
        ├── lifecycle/
        ├── integration/
        └── acceptance/
```

---

# 7. Module ownership contract

## VoiceCoordinator

Owns:

- sequencing only
- passing finalized turns to interpreter
- passing interpretations to reducer
- applying whole-session replacements
- dispatching reducer/planner effects

Must not own:

- booking facts
- semantic classification
- confirmation authority
- availability truth
- playback truth

---

## CallSession

Owns:

- current BookingProposal
- current registries
- journal cursor
- call identity
- immutable/reference replacement boundaries

Must not allow arbitrary modules to mutate booking facts directly.

---

## TurnRegistry

Owns:

- immutable `turnId` assignment
- finalized-turn ordering
- exactly-one semantic processing lease per call
- queueing of finalized turns that arrive while another turn is still being interpreted/reduced
- prevention of concurrent reducer execution for the same call
- consumed/completed semantic-processing status

TurnRegistry does not interpret caller meaning and does not mutate booking facts.

---

## TurnNormalizer

Owns canonical language normalization only.

Examples:

- casing
- punctuation normalization
- meridiem normalization
- spoken number normalization
- Spanish hour words
- `dos y media`
- ordinals
- dayparts
- common temporal forms

Does not decide the booking action.

---

## TurnInterpreter

Owns the single semantic decision.

Input:

- normalized turn
- current proposal/context

Output:

`CallerTurnInterpretation`

It alone chooses the action.

After action selection, it invokes only necessary extractors.

---

## Extractors

Extract values only.

They do not:

- own routing
- mutate state
- return early from coordinator
- authorize booking

Example:

`TimeExtractor("a las dos y media") → 2:30 PM`

---

## LlmFallbackClassifier

Runs only when deterministic interpretation is `UNKNOWN` or low-confidence.

Output must conform to exact action schema.

No richer interface.

No state mutation.

---

## BookingReducer

Pure or as close to pure as practical.

Input:

- current proposal
- validated caller action

Output:

- next proposal
- proposalChanged
- effects
- derived next needs

It is the sole authority for pre-booking proposal transitions.

---

## PostBookingReducer

Owns deterministic interpretation of authoritative completed booking-effect results, including:

- successful creation and idempotent replay
- idempotency conflict and booking failure
- terminal booking outcome
- post-booking follow-up effect decisions
- response-purpose selection

It may also remain the separate reducer for post-booking actions such as:

- cancel
- reschedule

It does not execute appointments, send SMS, interpret caller speech, own confirmation authority or business identity, call Twilio/OpenAI, or replace `BookingReducer`'s pre-booking responsibility. Booking terminality does not itself finalize the voice session or transcript; session lifecycle owns final response delivery/persistence and transcript finalization. If the final response fails, times out, or is interrupted by disconnect after booking succeeds, session recovery/termination must still finalize the transcript exactly once rather than wait indefinitely for successful delivery.

Do not overload either reducer into another giant switch.

---

## ResponseRegistry

Owns OpenAI response lifecycle identity.

Tracks:

- responseId
- proposalVersion
- purpose
- status
- invalidation/staleness

---

## PlaybackRegistry

Owns Twilio playback identity.

Tracks:

- markId
- responseId
- proposalVersion
- bytes submitted
- clear/interruption
- acknowledgement

---

## ConfirmationAuthority

Owns the question:

> Can this caller affirmative authorize this exact current proposal?

It does not infer general booking intent.

---

## EffectQueue

Owns effect execution ordering, retry policy, dedup semantics, and attempt tracking.

---

## SessionWatchdog

Owns timeout classes such as:

- caller silence
- availability timeout
- response-generation timeout
- playback timeout
- effect timeout

No other module invents independent timeout behavior.

---

# 8. CallerAction contract

Initial action vocabulary:

```text
BOOK_REQUEST

SET_SERVICE
SET_NAME
SET_DATE
SET_TIME

MODIFY_SERVICE
MODIFY_DATE
MODIFY_TIME

SELECT_ALTERNATIVE

REQUEST_LATER_TIME
REQUEST_AVAILABLE_TIMES_FOR_DATE

AFFIRM_CONFIRMATION
REJECT_CONFIRMATION

CANCEL
RESCHEDULE

CLARIFY
UNKNOWN
```

Suggested schema:

```js
{
  action,
  confidence,       // explicit | contextual | low
  service?,         // canonical service ID/name
  name?,
  date?,            // YYYY-MM-DD
  time?,            // canonical local time
  alternativeIndex?,
  sourceTurnId
}
```

---

# 9. BookingProposal contract

Suggested conceptual shape:

```js
{
  proposalId,
  proposalVersion,

  service,
  name,
  date,
  time,

  source: {
    serviceTurnId,
    nameTurnId,
    dateTurnId,
    timeTurnId
  },

  availability: {
    proposalVersion,
    status,          // unknown | checking | available | unavailable
    alternatives
  },

  confirmation: {
    proposalVersion,
    status,          // none | planned | generated | played | authoritative
    responseId,
    playbackMarkId,
    affirmedByTurnId
  },

  terminal: false
}
```

This is conceptual; implementation may normalize nested state differently if invariants remain intact.

---

# 10. Proposal version rules

Increment `proposalVersion` whenever an authoritative booking fact changes.

Examples:

- 9:00 → 9:30
- Tuesday → Thursday
- Haircut → Haircut + Beard
- name changes if confirmation must reflect it

When version changes:

- previous confirmation is stale
- previous availability is stale
- previous planned speech is stale
- previous affirmative cannot authorize current proposal
- pending booking command for old proposal must not execute

---

# 11. Command identity model

Example:

```js
{
  commandId: "cmd_102",
  type: "CHECK_AVAILABILITY",
  proposalVersion: 7,
  idempotencyKey: "...",
  attempt: 1
}
```

Retry:

```js
{
  commandId: "cmd_102",
  type: "CHECK_AVAILABILITY",
  proposalVersion: 7,
  idempotencyKey: "...",
  attempt: 2
}
```

`proposalVersion` identifies which facts the command belongs to.

`commandId` identifies the logical operation.

`attempt` identifies execution retries.

---

# 12. Interpretation pipeline

```text
RAW FINAL TRANSCRIPT
        ↓
TurnNormalizer
        ↓
NormalizedTurn
        ↓
Deterministic classification
        ↓
if confidence sufficient
        ↓
ONE ACTION SELECTED
        ↓
required extractor(s) only
        ↓
CallerTurnInterpretation
        ↓
Reducer validation
        ↓
BookingReducer
```

Fallback:

```text
Deterministic result = UNKNOWN/LOW
        ↓
LlmFallbackClassifier
        ↓
strict schema result
        ↓
same validation path
```

---

# 13. Business adapter contract

V2 reuses existing proven business logic through ports.

Example:

```text
AvailabilityPort
    ↓
V1AvailabilityAdapter
    ↓
existing availability implementation
```

Same for:

- booking
- SMS
- transcript persistence

Adapters should hide V1 implementation details from V2 domain code.

---

# 14. Prohibited V1 patterns in V2

The following are explicitly forbidden:

- one transcript processed sequentially by many independent semantic handlers
- a global not-name gate that can discard a non-name turn before its actual action executes
- independent mutable `phase`
- generic `awaitingCorrection` without field-specific semantic action
- direct booking-state mutation from interpreter modules
- direct availability resets scattered throughout unrelated handlers
- confirmation flags manually cleared in many code paths
- duplicate alternative state stores
- direct appointment/SMS calls from arbitrary conversation handlers
- OpenAI `response.done` treated as proof of caller-heard playback
- stale response events allowed to affect current proposal
- phrase-specific fixes added without scenario regression coverage

---

# 15. Historical CallSid regression policy

Create one scenario fixture per important production call.

Initial required scenarios:

```text
CAd58bd75a2bf25f73c4cff10676e2c288
CA992b314ad18494f13421bb6c595736bb
CAb4cc0a490516338e4050eb72ddc49660
CA07dcca1d0194d7168dfcb1f30c7fc36d
CAa58ccbdaa986a54b9767f95e851f6d02
CAc9e2539d9a387fae116ae831451da0b0
```

Scenario tests should replay meaningful caller turns directly through:

`TurnInterpreter + BookingReducer`

before transport integration exists.

Each fixture must assert:

- action sequence
- proposal versions
- final proposal
- stale-authority behavior
- expected effects
- no unsafe booking path

Every future confirmed production failure gets a new permanent fixture before the repair is accepted.

---

# 16. Required reducer invariants

These should be encoded in tests from Phase 1.

1. A proposal cannot be confirmed if required booking facts are missing.
2. Changing service/date/time invalidates confirmation.
3. Changing service/date/time invalidates previous availability.
4. Affirmative for proposal N cannot authorize proposal N+1.
5. Availability result for proposal N cannot mutate proposal N+1.
6. Booking cannot execute unless current proposal is authoritative.
7. Booking command is emitted at most once per authoritative proposal/idempotency key.
8. SMS command is emitted at most once per successful appointment.
9. Unknown/invalid actions cannot partially mutate proposal.
10. A reducer call either returns a fully valid next proposal or no change.
11. `phase` is never independently stored as domain authority.
12. `MODIFY_TIME` preserves service/date/name unless action explicitly changes them.
13. `MODIFY_DATE` preserves service/time/name unless action semantics explicitly invalidate time.
14. `MODIFY_SERVICE` preserves date/time/name but forces availability revalidation.
15. `SELECT_ALTERNATIVE` must select only from alternatives tied to the current proposal version.

---

# 17. Event journal contract

Every important action must be reconstructable.

Minimum event classes:

```text
CALL_STARTED
BUILD_IDENTITY

TURN_STARTED
TRANSCRIPT_FINALIZED
TURN_INTERPRETED

PROPOSAL_CREATED
PROPOSAL_CHANGED

EFFECT_QUEUED
EFFECT_ATTEMPTED
EFFECT_SUCCEEDED
EFFECT_FAILED

AVAILABILITY_REQUESTED
AVAILABILITY_RESULT

RESPONSE_PLANNED
OPENAI_RESPONSE_CREATED
OPENAI_RESPONSE_COMPLETED

AUDIO_SUBMITTED
PLAYBACK_MARK_SENT
PLAYBACK_ACKNOWLEDGED
PLAYBACK_INTERRUPTED

CONFIRMATION_AUTHORITY_GRANTED
CONFIRMATION_AUTHORITY_INVALIDATED

BOOKING_COMMAND_CREATED
BOOKING_SUCCEEDED
BOOKING_FAILED

SMS_COMMAND_CREATED
SMS_SUBMITTED
SMS_FAILED

CALL_COMPLETED
```

Logs should include immutable build identity whenever available.

---

# 18. Development phases

## Phase 0 — Architecture

Status:

**This document is the Phase 0 contract.**

Exit criteria:

- architecture reviewed by ChatGPT
- architecture reviewed independently by Claude
- extractor-ownership rule explicit
- state-ownership rule explicit
- V1 freeze explicit
- implementation phases agreed
- no V1 defect recreated under different filenames

---

## Phase 1 — Domain core

Build only:

- CallerAction
- BookingProposal
- BookingReducer
- proposal versioning
- domain invariants
- transition tests

Do NOT connect:

- Twilio
- OpenAI
- Mongo
- SMS
- real availability

Exit:

Reducer behavior deterministic and fully tested.

---

## Phase 2 — Turn interpretation

Build:

- TurnNormalizer
- TurnInterpreter
- deterministic classification
- action-specific extractors
- LLM fallback contract
- English/Spanish action equivalence tests
- historical text scenario replay tests

Exit:

- Conceptually equivalent English/Spanish turns produce equivalent actions.
- Known historical failure phrases resolve through stable regression coverage.
- Interpreter telemetry/tests report deterministic-vs-LLM fallback utilization.
- The team explicitly reviews whether LLM fallback is exceptional or load-bearing before Phase 3 is considered complete.

---

## Phase 3 — Business adapters

Create ports/adapters for:

- availability
- booking
- SMS
- transcript persistence

Use existing V1 business algorithms behind the adapters.

Exit:

V2 can run complete booking state transitions against fake or isolated business adapters without telephony.

---

## Phase 4 — Lifecycle and confirmation authority

Build:

- TurnRegistry
- ResponseRegistry
- PlaybackRegistry
- ConfirmationAuthority
- EffectQueue
- SessionWatchdog
- ResponsePlanner
- SpeechValidator

Exit:

Stale response/playback/confirmation authority is structurally impossible to apply to a newer proposal.

---

## Phase 4.5 — Fake transport integration

Before real Twilio/OpenAI:

- fake Twilio adapter
- fake OpenAI adapter
- in-memory full call cycles
- interruption simulation
- timeout simulation
- stale-event simulation
- retry simulation

Exit:

Full conversation scenarios work end-to-end without external telephony.

---

## Phase 5 — Real voice transport

Connect existing:

- Twilio Media Streams
- OpenAI Realtime

Behind:

- test number
- feature flag
- or explicit V2 routing

Do not replace V1 production traffic.

Exit:

One controlled English happy-path live booking.

---

## Phase 6 — Natural/adversarial conversation

Live and integration coverage for:

- corrections
- fillers
- pauses
- interruptions
- unavailable times
- alternatives
- “later”
- another date/day
- English
- Spanish
- Spanglish
- repeated corrections
- confirmation rejection
- confirmation re-affirmation after proposal change

---

## Phase 7 — Acceptance gate

Minimum:

- 10 normal English bookings
- 10 missing/split-information calls
- 10 unavailable/alternative/correction calls
- 10 interruption/pause/noisy-audio calls
- 10 Spanish/Spanglish calls

Required:

- at least 48/50 fully correct
- 50/50 safe
- zero wrong bookings
- zero duplicate bookings
- zero stale bookings
- zero accidental confirmations
- zero deadlocks
- every failure preserves diagnostics
- repeat full matrix twice without changing code

---

## Phase 8 — Controlled migration

Progression:

1. test number
2. owner/internal testing
3. one beta barber
4. small controlled percentage
5. wider beta only after evidence

V1 remains rollback until V2 acceptance is proven.

---

# 19. Definition of V2 success

V2 is not successful because one happy-path booking works.

Success means callers can speak naturally without knowing Glō's internal state.

Example English:

```text
"I need a haircut tomorrow."
"Maybe around four."
"Actually what do you have later?"
"The second one works."
"Wait, Thursday instead."
"Yeah that works."
```

Example Spanish:

```text
"Quiero un corte mañana."
"Como a las dos."
"Mejor dos y media."
"¿Qué tienes más tarde?"
"La primera."
"Sí."
```

Each finalized caller turn must produce one explainable domain action and one controlled transition.

---

# 20. Implementation governance

Every Codex implementation task must begin with:

> Read `GLO_VOICE_V2_ARCHITECTURE.md` first. Do not violate its invariants.

For each phase, Codex must report before commit:

- files created/changed
- architecture invariants touched
- tests added
- test results
- whether V1 was modified
- whether any new mutable state was introduced
- whether any new semantic handler can independently consume a finalized turn
- whether any direct side-effect path bypasses the EffectQueue/ports

No phase proceeds merely because code compiles.

Architecture review occurs at the end of every phase.

---

# 21. Final pre-coding rule

Before Phase 1 begins, all reviewers should be able to answer YES to these questions:

1. Can one finalized caller turn be semantically consumed more than once?  
   **Must be NO.**

2. Can an extractor mutate booking state?  
   **Must be NO.**

3. Can VoiceCoordinator own booking facts?  
   **Must be NO.**

4. Can a proposal change leave old confirmation authority valid?  
   **Must be NO.**

5. Can OpenAI completion alone authorize confirmation?  
   **Must be NO.**

6. Can an LLM fallback directly mutate authoritative state?  
   **Must be NO.**

7. Can appointment/SMS side effects be called outside explicit commands?  
   **Must be NO.**

8. Can `phase` disagree with booking facts because it is independently mutable?  
   **Must be structurally NO.**

9. Can English and Spanish equivalent intents resolve to different state machines?  
   **Must be NO.**

10. Are historical production failures permanent regression scenarios?  
    **Must be YES.**

11. Can two finalized caller turns race through interpretation/reduction for the same call?  
    **Must be structurally NO.**

12. Can `CLARIFY` or `UNKNOWN` partially mutate the proposal or emit booking side effects?  
    **Must be NO.**

13. Will Phase 2 measure deterministic-vs-LLM fallback utilization instead of assuming the LLM path is rare?  
    **Must be YES.**

Only then should Phase 1 coding start.

---

## Final architecture decision

**Freeze Voice V1.**

**Build Voice V2 as a parallel conversational coordinator.**

**Reuse proven V1 business and transport capabilities behind explicit interfaces.**

**Do not reuse V1's multi-owner semantic orchestration.**

**The unit of authority in V2 is: one caller turn → one action → one proposal transition.**
