# Voice V2 Floor Owner Protocol

`CallSession.floorOwner` is the single call-owned arbitration authority for conversational output. It does not replace `ResponseRegistry`, `PlaybackRegistry`, `ConfirmationAuthority`, `EffectQueue`, or `SessionWatchdog`; those remain the owners of provider lifecycle, Twilio playback truth, booking authority, effects, and deadlines.

## States and production owners

- `LISTEN`: no assistant response owns the caller's ear. `initializeVoiceV2Session.acceptTurn` may claim and process one current transcript.
- `SPEAKING`: one admitted response owns generation, buffering, Twilio submission, and its playback mark. `requestResponse` admits the plan; response/TTS handlers must match its request, response, proposal, and mark IDs.
- `AWAIT_CONSENT`: an exclusively delivered `PRE_BOOKING_CONFIRMATION` owns the next non-stale caller turn. The state carries the exact request/response/mark/proposal correlation.
- `BOOKING`: the already-authorized booking command owns progress. No conversational response may compete until booking settlement returns.
- `TERMINATING`: `SessionLifecycle` owns cleanup, transcript finalization, media closure, and the independent call-leg termination request.

Purposes are reduced to `COLLECT`, `CONFIRM`, `REASK`, `POST_BOOK`, and `EXIT`. OpenAI Realtime is used only for ordinary `COLLECT` responses. Production composition supplies `OpenAISpeechAdapter`; `CONFIRM`, `REASK`, `POST_BOOK`, and `EXIT` use its application-rendered text through the existing buffered PCMU/Twilio path.

## Admission and replacement

`requestResponse` must obtain floor admission before creating a provider request. A plan arriving while the floor is occupied is rejected with `FLOOR_PLAN_REJECTED`; there is no second response queue. Every audio delta, completion, buffer release, mark, and acknowledgement must still match the admitted owner.

Caller interruption delegates response/playback invalidation to `VoiceCoordinator`, then releases or replaces the floor. Cleared, stale, invalidated, or replaced owners cannot regain authority through late provider events or Twilio marks. A proposal change resets the corresponding floor authority after existing response/playback artifacts are invalidated.

## Caller turns and consent

`TurnRegistry` records active caller items. If item B starts before older item A's transcript completes, A may be persisted for audit but is quarantined before interpretation, reduction, ambiguity accounting, response planning, or termination.

After exclusive confirmation playback is acknowledged, the floor enters `AWAIT_CONSENT`. The next complete current item is claimed once and evaluated through the existing interpreter, confirmation authority, reducer, and effect pipeline:

- affirmative: existing authority verification and booking path;
- negative: application-owned request for the desired change;
- booking correction: normal proposal replacement, authority invalidation, and availability recheck;
- first unclear response: one application-owned full-identity yes/no re-ask;
- second unclear response: one application-owned controlled exit.

The re-ask and exit use the existing response and playback watchdogs. No retry scheduler or unbounded queue/counter is introduced.

## Confirmation and termination

A confirmation mark may grant authority only when `ResponseRegistry` and `PlaybackRegistry` pass their existing checks and `FloorOwner.mayGrantConfirmation` proves the same request, response, mark, proposal, and exclusive owner. Acknowledgement then transitions `SPEAKING(CONFIRM)` to `AWAIT_CONSENT`.

Conversational termination follows acknowledged `EXIT` or `POST_BOOK` playback, bounded synthesis/delivery failure, caller transport loss, or an existing fatal condition. `SessionLifecycle.terminate` atomically moves the floor to `TERMINATING`; cleanup and finalization stay idempotent.

## Compact evidence

The call journal and `V2_CALL_TRACE` export `FLOOR_TRANSITION`, `FLOOR_PLAN_ACCEPTED`, `FLOOR_PLAN_REJECTED`, `FLOOR_OWNER_REPLACED`, `CONSENT_TURN_CLAIMED`, `CONSENT_REASK_PLANNED`, and `EXIT_PLANNED`. Events contain bounded correlation/state fields only—never transcript text, caller identity, service text, or audio.
