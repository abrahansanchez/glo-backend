# Retell callback and handoff review - 2026-11-03

Base d2cfce59f4e74c42759ab8faf92605e1818b2afa. Offline only; all work unstaged.

## Preserved verified live milestone
Operator inspection: call_0265d05d767e0f6a90c9298db21; parent CA321c03aeccc7cf5106edbd916eb2cebd; SIP child CAb80267008fdafb9613203e2c6dbd0102. Both proposals BOOKED, exactly one confirmed appointment per command, correct tenant/hash/contact, notificationsSuppressed=true. Registration SUPERSEDED; budget ENDED; duration300 and equal deadlines. Transcript finalized, 35 turns. glo_retell_booking_dev_001 used4/remaining6 AT THAT INSPECTION. No records were queried or changed here.

## Callback chain and demonstrated defect
server.js mounts voiceWebhook under /api/voice after URL-encoded parsing. The three sandbox routes delegate through SandboxPhoneHooks to SandboxHandoff.webhook; they bypass generic HTTP auth but enforce their own official Twilio SDK signature check over the configured public URL and all parsed form parameters. AccountSid participates in the signature; there is no separate account-ID equality guard in this callback path. Exact path checks reject unexpected queries. Durable parent, child, epoch, current registration and budget checks are independent of authentication. SequenceNumber is diagnostic, not authorization or an arrival-order guarantee.

Before repair, a correctly signed in-progress callback preceding /screen persistence returned403 because childCallSid was not yet pinned. The retained test failed403 versus expected200. After repair only an exact signed outbound-dial SIP target for the current persisted registration/attempt may be observed before screening. It returns empty XML without pinning a child, marking screening complete, changing budgets or granting tool access. Only /screen authorizes the bridge. Wrong targets/parents, signatures, expired/superseded owners and early terminal events remain rejected. Concurrent screening and duplicate status are tested. Bound status returns empty XML; complete remains the Dial action that retires ownership. Sanitized CALLBACK_RESULT reports reason, callback kind/status, valid child SID, numeric sequence, UTC receipt/completion and monotonic duration. No signature/header, phone number, raw payload or exception text is logged.

The historical403 is NOT diagnosed conclusively: signature headers and screening order were not recorded. The call continued to two bookings; no claim is made that this response hung up the call or interrupted greeting audio.

## Greeting evidence and limits
Retell owns greeting generation/playback. This route has no backend Speech request, greeting gate, redirect or call update. SIP screen executes after answer and before bridge; asynchronous database screening can overlap provider startup, but missing greeting/media timestamps prevent attributing the reported gap to it. Selected Retell takeover is blocked before the existing Twilio update. Status callbacks are asynchronous notifications, not the Dial action control. No backend audio defect was established; no mobile implementation is justified.

Minimum additional evidence: screen HTTP start/end plus SCREEN_ACCEPTED duration (separates screening wait); signed-status result reason and timing (separates auth/binding/order); Retell call-start, assistant utterance start/interruption events; a short two-channel greeting recording (distinguishes prebridge clipping, silence and noise barge-in). Native decline invocation/completion timing is needed only if that evidence points to the client. Never share auth headers or full raw envelopes.

A historical local V0 export has interruption_sensitivity=0.9; this does not establish current published V1 configuration. Proposed separately authorized one-variable experiment: confirm current value, then lower0.9 to0.8 if applicable; keep barge-in enabled and all other settings unchanged. Compare quiet background, controlled non-speech noise and deliberate interruption using interruption timestamps and recording. Do not disable interruption or apply greeting playback gates. Four subjective observations cannot prove causation. No setting or agent was changed.

Official references: https://www.twilio.com/docs/voice/twiml/sip ; https://www.twilio.com/docs/voice/twiml ; https://www.twilio.com/docs/usage/webhooks/webhooks-security ; https://www.retellai.com/learn/how-ai-voice-agents-handle-interruptions-and-natural-turn-taking

## Contact rollout and exact contract
RETELL_CONTACT_COLLECTION.md retains complete application-generated EN/ES prompts and exact legacy/new JSON schemas; bookingAgentTemplates.js is their source. Legacy E.164 remains accepted. CALLER_NUMBER requires callerNumberConsent=AGREED with no contactNumber; PROVIDED_NUMBER requires contactNumber with no callerNumberConsent. Trusted original caller number is resolved server-side; it is not identity or booking consent. Optional RETELL_BOOKING_DEFAULT_COUNTRY remains unset unless explicitly verified/configured. Preserve backend-first rollout and published numeric version pinning. Do not repin/reset glo_retell_booking_dev_001 or silently create another run. A changed published agent requires separately approved version-matched scope. SMS/reminder suppression, explicit booking confirmation and deadlines remain unchanged.

## Combined inventory
- docs/voice/RETELL_CONTACT_COLLECTION.md
- docs/voice/RETELL_IMPLEMENTATION_TRACKER.md
- docs/voice/RETELL_LOOKUP_CANCELLATION_PLAN.md
- docs/voice/RETELL_SANDBOX_CHECKPOINT.md
- package-lock.json
- package.json
- routes/retellBookingRoutes.js
- services/voice/retell/BookingContact.js
- services/voice/retell/BookingService.js
- services/voice/retell/bookingAgentTemplates.js
- services/voice/retell/bookingTools.js
- services/voice/retell/installSandbox.js
- services/voice/retell/startup.js
- tests/services/retellActionsHarness.js
- tests/services/retellBookingContact.test.js
- tests/services/retellBookingTranscripts.test.js
- tests/services/retellStartup.test.js
- services/voice/retell/SandboxHandoff.js
- tests/services/retellStatusCallback.test.js
- docs/voice/RETELL_CALLBACK_AND_HANDOFF_REVIEW.md

## Mobile source distinction
Read-only local glo-mobile/src/voice/twilioVoiceService.js:467-485 exposes letAiHandleIncomingCall: it requests /voice/ai-takeover before rejecting the invite. The backend callController.js:422 rejects selected Retell takeover with409 before its Twilio call update at451. Native decline is not established to use this helper, and the tested SIP call did proceed. No causal link is proven. No mobile edits or Mac implementation task are justified; capture which action was actually invoked if further evidence points here.

## Completed validation
Focused realistic callback tests11/11. Full affected suite471/471 in this worktree and exact combined20-file clean starting-HEAD overlay, zero failures/skips/cancellations. Includes cached isolated Mongo-backed HTTP/callback tests and fake provider boundaries, existing booking/contact/transcript/registration/budget/duration/routing/scheduling regressions. Thirteen JavaScript syntax checks and both Git diff checks pass. before.tap retains the original failing-before403 reproduction; focused.tap, affected.tap, overlay.tap, checks.json, inventory.json and hashes.json are outside all worktrees under the retell-callback-audio-20261103 temporary evidence directory. Docs finalized after runtime validation; runtime/test hashes remain unchanged. No staged changes.
