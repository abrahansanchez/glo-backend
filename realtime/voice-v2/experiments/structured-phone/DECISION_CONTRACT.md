# Structured phone decision and recovery contract

This contract supersedes the historical rejection descriptions in the README.
It changes only the gated SIMULATION_ONLY driver. One caller turn still permits
one model decision; greeting permits zero. No extra planning or retry occurs.

## Audit: wire, instructions, validation and execution

Before this repair the wire schema allowed every intent with ordered changes,
preferences, alternative references, questions and confirmation meaning. The
instructions did not distinguish certain details from uncertain changes or
existing-appointment exploration. Runtime guards rejected CLARIFY with changes
**or questions**, QUESTION with changes, and several confirmation combinations;
safe partial input could consequently terminate as INVALID_PLAN.

The new wire requires changeCertainty (KNOWN/UNCERTAIN) and scope
(DRAFT/EXISTING_APPOINTMENT_EXPLORATION). These are proposed interpretations,
not trusted facts or authority. Missing fields are schema failures, not inferred
legacy defaults. Actual transport uses the same generic instructions and schema
tested by the contract suite. No scenario outcomes are included.

| Intent / combination | Before: wire / application | After: wire / instructions / application execution |
| --- | --- | --- |
| REQUEST + known ordered changes, preferences or selection | permitted / ordinary draft path | permitted and described / atomic temporary update, actual availability, collect missing facts or render current result |
| QUESTION + known changes and typed questions | permitted / changes rejected | permitted and described / isolated what-if copy and read-only PRICE, DURATION, AVAILABILITY; active draft and confirmation unchanged |
| CLARIFY + known changes or questions | permitted / CLARIFICATION_WITH_CHANGES rejection | permitted and described / preserve known details, answer verified questions, collect genuinely missing fields |
| CLARIFY with no information | permitted / alternatives or fatal fallback | permitted and described / current alternatives or owned clarification, never slot selection |
| Any intent + UNCERTAIN changes | not expressible distinctly | permitted and described / hold whole batch, owned clarification, preserve validated state |
| CONFIRMATION + CORRECTION/DENY + known changes | some combinations permitted / draft correction | permitted and described / temporary correction only, revoke old confirmation, recheck full bundle |
| CONFIRMATION + AFFIRM + changes | permitted / fatal rejection | permitted and described / hold whole batch, clarify, no consent |
| CONFIRMATION + typed questions | permitted / eligibility conflicts | permitted and described / answer current facts without granting consent |
| Pure CONFIRMATION meaning | permitted / playback-bound authority | permitted and described / unchanged playback-bound checks; early affirmative clarifies delivery gate; negative/unknown clarifies without authority |
| UNSUPPORTED | permitted / fatal unsupported plan | permitted and described / explicit capability clarification; no supported subset silently executed |
| Existing-appointment exploration | not expressible distinctly | explicit scope / isolated what-if copy plus capability disclosure, no active-draft mutation, canonical confirmation or real modification |

All information paths validate current business/turn/version/ordered-service
bindings. Each change is checked before any batch mutation, including changes
later overwritten in the same batch. Date/time preferences are not selected
slots. Current alternative IDs resolve before bundle changes; fresh complete
bundle availability is still required afterward. Unknown foreign IDs against
current evidence remain terminal. Expired/retired references stay silent.

Questions are retained across clarification. Questions about held changes are
marked target-uncertain and cannot borrow facts from the old draft. Missing
catalogue price/duration is explicitly unverified, not invented. Zero price is
still zero, not a claim that a service is free. An invalid atomic batch retains
the previous proposal and asks for clarification rather than dropping a member.

## Exploration isolation

QUESTION and EXISTING_APPOINTMENT_EXPLORATION evaluate on a separate session
facade with a cloned proposal, separate preferences, pending questions and
availability evidence. Its local replacement callback cannot call the active
session's replaceProposal, supersede playback, write a journal or revoke/grant
active confirmation authority. Even uncertain inquiry questions stay in that
copy. Actual facts and scheduling use its own ordered bundle and slot.

The outbound top-level binding, draft and availability always remain active.
The separate exploration context exposes its hypothetical draft, preferences,
pending questions and alternatives, source active version and canAuthorize:false.
There is no second model connection or request for this local evaluation.

Exploratory speech has ordinary application-owned speech purpose, never canonical
confirmation. Its private binding couples the exact exploratory snapshot to the
unchanged active proposal, business revision, caller turn and generation. The
existing before/after-synthesis, media and mark freshness checks delegate to that
snapshot's real availability checks. Cancellation or replacement withholds late
work and cannot commit an exploratory result into active/replacement state.

An explicit DRAFT REQUEST/CORRECTION may adopt a current exploratory alternative.
The application resolves its bundle/date/time as requested intent, validates the
whole active change batch and checks fresh active availability. It never promotes
exploratory availability into active evidence. Unavailable adoption retains the
requested slot and truthfully offers current alternatives. Stale/foreign option
rules still apply; an affirmative alone does not adopt exploratory changes.

Verification retained the four original EN/ES isolation regressions and added
320 actual wire/driver execution cases. Before isolation: 24 state violations and
56 current-confirmation eligibility violations (overlapping). After isolation:
zero of each. The older 320-case serialization test is not itself execution proof.

## Outcomes

| Outcome | Meaning / handoff |
| --- | --- |
| CONTINUE | Accepted information with verified local results; owned speech only |
| COLLECT | Partial valid information; ask an actually missing supported field |
| CLARIFY | Semantic ambiguity, held invalid batch, unsupported capability or unavailable catalogue fact; no consent, session remains open |
| WITHHOLD | Stale/foreign binding, expired alternative, canceled/superseded or asynchronously stale work; no speech, no successful interpretation |
| TERMINAL | Malformed JSON/schema, multiple decisions, unknown foreign current alternative, infrastructure/protocol error, exhausted limits/deadlines; precise bounded failure and cleanup |

CLARIFY is not a catch-all exception handler. Recoverable results retain explicit
REJECTED/PARTIAL interpretation status and bounded reason. No raw decision or
caller wording is added to failure diagnostics. No supported appointment/SMS
executor exists here. Temporary draft updates do not modify an appointment.

Stale speech retires only its current owner and clears its playback; an obsolete
owner cannot clear replacement output. Incomplete/canceled audio gets no final
confirmation mark. Synthesis, media submission and clear completion do not
acknowledge confirmation. A current completed mark and subsequent genuine
affirmative are still required even for simulated WOULD_AUTHORIZE.

## Offline evidence and limits

Four EN/ES wire reproductions failed against starting HEAD: known CLARIFY details
with missing time, and CLARIFY price/duration questions. They pass after repair.
The bounded matrix serializes 320 combinations of five intents, certainty, scope,
four meanings, changes and questions. Multi-turn EN/ES tests exercise actual
transport serialization, production-shaped catalogue IDs, real scheduling
helpers with a fake appointment reader, tools, fragmented WAV conversion and
Twilio marks using fake providers only.

Example: “A haircut tomorrow.” / “Un corte mañana.” retains the supplied service
and date and asks for time. The next clear afternoon preference checks actual
availability and offers verified slots. An uncertain correction instead holds
the whole batch and asks for clarification; a subsequent known correction can
continue. Price/duration questions use catalogue facts. Ordered selection,
correction to five and adding beard trim preserve both services, with a fresh
combined check and missing-name collection before canonical readback.

Live CAaf939bee4a45e3cad0b4f305d43cb34d proves the initiating guard was
CLARIFICATION_WITH_CHANGES, not a fired deadline. Its exact changes/questions
were not retained, so their correctness remains unknown. Fake provider-shape
coverage proves application behavior, not live natural-language interpretation,
provider schema acceptance or latency. Greeting delay remains outside this repair.
