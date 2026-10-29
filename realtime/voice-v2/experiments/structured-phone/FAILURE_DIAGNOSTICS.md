# First initiating failure: offline observation only

The causes of CA7a82ff15c23255118ef8f673757ad56c and
CAc446b01b682e855eef56bc19a1e6d2e7 remain unverified. Call duration alone is not
evidence of a particular timer. No provider or live account was queried.

## Inspection of existing behavior (a–h)

a. The only direct producer of STRUCTURED_PHONE_FAILED is the current-generation
catch in StructuredPhoneDriver.turn. Business read/validation, connection factory
or ready rejection, context construction, request failure, JSON/schema/replay,
binding/eligibility/render rejection, local execution, speech handoff and result
submission can reach it. It closes the driver and asks the existing initializer
wrapper to enqueue termination. Other structured stops have distinct reasons:
STRUCTURED_MODEL_PROTOCOL_FAILED, STRUCTURED_DECISION_TIMEOUT, STRUCTURED_CALL_LIMIT,
STRUCTURED_SPEECH_LIMIT, STRUCTURED_STALE_EVIDENCE, STRUCTURED_EFFECT_REFUSED,
STRUCTURED_UNEXPECTED_MODEL_AUDIO and STRUCTURED_CALLER_SILENCE. Exceptions before
the driver's try (for example an unexpected throw in generation retirement) do
not themselves execute that catch or prove this generic stop occurred.

b. Existing STRUCTURED_DECISION_FAILED and SESSION_TERMINATING aggregation calls
the failure aggregator without last/failed boundaries; their defaults are UNKNOWN.
The initiating driver's sanitized STOPPED details are separate from that summary.
The new observation enriches only the requested two boundary values and adds
primaryFailureReasonCode. Other existing summary fields, root-category policy,
counts, appointmentId and finalOutcome retain their existing computation.

c. The 20-second setTimeout is armed at entry to an admitted driver turn, before
business read. It spans read, connection/configuration, context/request, execution,
speech handoff and tool-result submission. It can expire before any model request,
or after the model finishes while later work is pending. Finally clears its local
handle; interruption clears the stored handle and advances generation. The callback
checks current generation/not-closed, not model-in-flight. Completed work and
retired generations do not retain a live deadline in the tested paths. Its distinct
termination reason is STRUCTURED_DECISION_TIMEOUT. A 20.13-second whole call does
not establish that this per-turn timer fired.

d. Before MODEL_CONNECTION/MODEL_REQUEST, the existing paths include: retirement
of the prior generation; turn count increment/guard; business loader and catalogue,
timezone and clock validation; contract construction; revision invalidation;
connection-count guard, factory and configuration readiness. Read failures can be
unclassified exceptions. Closed/retired generation checks after awaits return
without another decision. Limits are 12 turns, one model request/turn, 12 model
requests/call, four decision connection constructions, 16 speech requests including
greeting, 180 seconds/call and 20 seconds/decision turn. TURN_LIMIT,
CONNECTION_LIMIT and MODEL_REQUEST_LIMIT reach the generic catch. The model limit
is normally subsumed by the equally bounded turn count, but remains independently
guarded. perTurnRequests is enforced by the single request call site, not a loop;
the one-function response guard separately rejects missing/multiple functions.
Call, decision and speech ceilings keep their distinct existing stop reasons.

e. Retiring an active generation revokes connection ownership, closes/nulls that
decision connection and clears its deadline. The next eligible turn uses current
application state and may create a new connection within the four-connection cap.
A completed, still-owned connection may be reused. A retired connection's late
callback is ignored operationally. Unexpected closure of the current owned
connection invokes the existing protocol failure stop, even between requests.
A closed driver stays closed; a racing later invocation cannot reopen it. These
rules are not changed by this instrumentation.

f. After intake configuration, caller audio is forwarded to the existing Realtime
intake connection during greeting playback as well as other floor states. Before
configuration it is buffered (500 frames/80,000 bytes ceiling) and flushed by the
existing startup path. CONSENT_BOUNDARY starts a window after acknowledgment of
an input-expecting prompt, not at call connection. It measures inbound/forwarded
frames, speech/transcription/admission/persistence and consent/booking observations
within those playback-bound windows. Zero pre-greeting-window counts do not prove
no audio arrived. Its interpretationRan flag observes the legacy interpreter;
structured turns deliberately return before that interpreter runs.

g. The decision connection receives current accepted caller text and current
application context, with earlier accepted user/function items retained only when
the connection is reused. A replacement connection starts a fresh history with
current draft/evidence. No transcript text was added to diagnostic context. The
outbound user item does not set previous_item_id; decision messages follow local
accepted send order. Provider-assigned decision conversation item IDs are not
observed; the diagnostic sourceItemIds are intake transcript source IDs, not a
claim that those are the outgoing provider's message IDs. Audio offsets and
previous_item_id metadata are not used to sort decision requests. The unrelated
working-tree intake adapter instrumentation observes extra ordering metadata;
it is not included in this patch and is not a routing/admission policy change.

h. Missing/duplicate IDs, exit/terminal/terminated/ambiguity-limited state and the
existing active-other-speech overlap gate prevent semantic processing. In the
overlap case the caller audit write and TURN_ACCEPTED journal event precede
SUPERSEDED_CALLER_TRANSCRIPT_IGNORED / NEWER_CALLER_SPEECH_ACTIVE; that journal label
is not proof of structured turn admission. TURN_PROCESSING_STARTED and the driver
call occur only after that gate. Quarantine is not provider-history deletion: the
intake provider has already received the audio and can retain its own conversation
items. Quarantined text is not submitted to the separate decision model. No input
audio, VAD, admission, item deletion or history-reordering behavior changed here.

## New records

V2_STRUCTURED_PHONE_FAILURE is write-once per call. It is captured before cleanup,
with finite operation/boundary/reason/guard enums, known limits, current correlation
IDs, monotonic elapsed call/accepted-turn/decision times, request-start status,
reserved counters, generation/deadline state, sanitized provider metadata and
ID/count-only outbound-context observations. Call elapsed time starts at local
initializer construction, not an inferred Twilio/PSTN connection timestamp.
UNKNOWN is permitted for an unrecognized error code, never a fabricated cause.

New boundary events retain preceding evidence; a rolling twelve-boundary snapshot
is frozen into the first record. Existing trace/journal events are not removed or
rewritten. Up to 512 new boundary records and 64 secondary records are emitted;
secondary capacity is independent, so a long trail cannot hide cleanup. The first
record is immutable and later callbacks cannot replace it. Diagnostic payloads
are limited to 4,000 UTF-8 bytes; production logs serialize these new events as one
JSON line. No arbitrary exception string/stack, model decision, transcript, name,
phone number, service list, credential, raw envelope or header collection enters
these records. Nullable fields represent unavailable provider metadata.

V2_STRUCTURED_PHONE_SECONDARY distinguishes expected cancellation/withholding,
observed transport events and consequences after a first fault. Expected stale,
superseded, interrupted or retired output is not promoted to a system failure;
cleanup alone cannot become an initiating fault. Per-connection observation is
ownership-bound to prevent an old connection from accusing a replacement turn.
V2_STRUCTURED_PHONE_TERMINATION_REQUESTED identifies the existing requester before
the call-leg action. It is not a new termination path.

Fault tests cover all major boundaries and ceilings, pre-model and in-request
deadlines, deadline clearing, expected cancellations, context/quarantine metadata,
first-cause preservation, bounded privacy and summary compatibility. A committed
current-contract driver is compared with its observer disabled for ordered
actions, outbound model data and termination reasons (normalizing only fresh
random alternative IDs). Historical summary compatibility remains separately
tested. Diagnostic observer failures are swallowed. Recoverable semantic
outcomes and STALE_WORK withholding follow [DECISION_CONTRACT.md](DECISION_CONTRACT.md);
they do not create an initiating system failure.
