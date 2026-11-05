# Booking phase API handoff for Mac Codex

**Current shop/workspace completion:** [SHOP_WORKSPACE_API.md](SHOP_WORKSPACE_API.md) and [MOBILE_START_HERE.md](MOBILE_START_HERE.md) supersede earlier statements that shop setup, invitations or workspace discovery are missing. New backend contracts are implemented/offline-tested, default-off; commercial/provider configuration, native UI and live acceptance remain unverified. Existing independent ownership is preserved.


**Current round:** see [PRIVATE_VERIFICATION_AND_CANARIES.md](PRIVATE_VERIFICATION_AND_CANARIES.md). It supersedes the historical missing-private-UI/reference and15second-polling findings below. Business canary admission is required in addition to global flags. All new work remains offline-tested, not live-validated.

Status 2026-11-04: endpoints below are IMPLEMENTED and exercised offline, not deployed or live-validated. Base HEAD a521beeaa5317f0a7ac58c1e618831a6f883db10 plus the unstaged booking-phase overlay. No mobile files changed. This is not permission to enable features or dispatch providers.

## Identity and authentication

Existing Barber JWT account and business/location IDs remain authoritative. Existing Subscription belongs to business owner, not staff members. An independent account implicitly owns calendar OWNER. A shop/calendar membership grants explicit read scope; manager can mutate its permitted calendars, staff can only read. Account access never follows caller phone, shared recipient contact or UI visibility. An authenticated owner can grant appointment-specific customer management; verification alone grants nothing.

The workspace routes use the existing Bearer JWT and business owner's active subscription, not a staff member's personal subscription. Workspace successes use `{data:...}`; domain failures use `{reasonCode}` with 403/409. Owner grants return a direct typed status; notification-policy returns a direct `{enabled,historicalConsentUnchanged}` object. Existing authentication returns401 `{message}`; existing owner subscription middleware can return `{code,message}`. Do not assume every error has one universal envelope. No client tenant claim overrides server checks. Use a fresh explicit confirmation after every material proposal change. UNKNOWN means reconcile/repeat the SAME command; do not create a replacement.

## Implemented workspace and scheduling

Enable only after prerequisite review: `GLO_BOOKING_API_ENABLED=false` by default; private `GLO_BOOKING_CURSOR_KEY` >=32 bytes. `GLO_STAFF_SCHEDULING_ENABLED=false` preserves the smaller calendar foundation API; enabling either mounts authenticated foundation routes. Missing indexes/configuration refuses activation. No extra login subscription or phone route is created for staff.

- GET `.../context`: role, account/business, timezone, clock, 30-day window, service IDs, accessible calendars/capabilities. No credentials. Staff can use this contract before mobile UI completion.
- GET `.../calendars`: bounded list including services, exact price/duration, hours, timeOff and revision.
- POST `.../calendars`: `{label,active,services:[{serviceId,price,durationMinutes}],hours:{sun:{isClosed,open,close},...all7},timeOff:[{startAt,endAt}]}`. Owner creates; trusted catalogue IDs only. New calendar explicitly enables staff scheduling on that business; no historical appointment reassignment.
- PUT `.../calendars/:calendarId`: `{calendar: <same complete shape>,expectedRevision}`. Owner or scoped manager; revision CAS.
- POST `.../memberships`: `{accountId,active,calendarIds,role:"manager"|"staff"}`. Owner only, existing account only; never changes subscription/routing.
- POST `.../availability`: `{calendarId:"OWNER"|"ANY"|calendarId,serviceId,startAt:offsetISO}`. OWNER only when business has not enabled staff scheduling. ANY selects first eligible active calendar in lexical ID order. One catalogue item, including an existing combination, only. Returned staff/price/duration/time are authoritative; zero price remains numeric zero.
- POST `.../appointments/prepare`: same selection plus `{clientName,contactNumber:fullE164,managementConsent?:"AGREED",notificationConsent?:"AGREED",reminderConsent?:"AGREED"}`. Optional capabilities must actually be configured. Separate agreements, never infer one from another. Returns PREPARED, opaque proposalId, expiresAt (~60s), exact summary, requiresExplicitConfirmation.
- POST `.../appointments/commit`: `{proposalId,confirmation:"AFFIRMATIVE"}`. Returns BOOKED/appointmentId/replayed or UNKNOWN. Frozen selected staff/service facts and current schedule/authority are rechecked transactionally. Duplicate command creates once.
- GET `.../calendars/range?from=offsetISO&to=offsetISO&limit=1..100&calendarId=...&cursor=...`: [from,to), maximum31days; optional calendar, signed opaque nextCursor, ten-minute validity bound to account/tenant/filter/membership revision. Start a new read after a permission change. Calendar day/week uses same endpoint. Returns items + timezone + sourceHealth. APPOINTMENT includes allowedActions/revision; EXTERNAL_BUSY is readOnly and has no appointment mutation identity. Private titles appear only to the connection's owning account with details visibility; shop owner does not inherit personal titles. Legacy missing interval fields remain explicitly null, not fabricated durations. Pagination is a current read, not a cross-request snapshot.
- GET `.../appointments/:id`: minimal appointment details, current allowedActions, managementDelegated flag, notification delivery state and externalSync state. No tokens, proof codes or raw provider payloads. Do not treat allowedActions as authority; prepare/commit enforce again.
- POST `.../appointments/:id/actions/prepare`: `{kind:"CANCEL",expectedRevision}` or `{kind:"RESCHEDULE",expectedRevision,selection:{calendarId,serviceId,startAt}}`. Returns exact summary and60second proposal. No cancellation/recreation gap.
- POST `.../actions/commit`: `{proposalId,confirmation:"AFFIRMATIVE"}`. CANCELED/RESCHEDULED/UNKNOWN, idempotent same-command settlement; original appointment ID/history retained. Concurrent cancellation/reschedule/owner edits cannot both apply to the same revision.

Existing `/api/appointments` stays available. For new managed records, update/delete requires expectedRevision and server owner authorization; delete becomes history-preserving cancellation. Protected fields cannot be changed through body spreading; unchanged read-only echoes are ignored. Legacy SMS/AI mutation writers without management authority cannot cancel newly delegated/outbox/staff/external-managed records. Legacy unmanaged behavior is retained.

## Verification and appointment management

See MANAGEMENT_API.md for complete signed Retell tool schemas/paths and private verification endpoint. `GLO_APPOINTMENT_MANAGEMENT_ENABLED=false` mounts owner grant foundation independently of Retell: POST `.../management-grants` `{appointmentId,contactNumber,actions:["LOOKUP","CANCEL","RESCHEDULE"],expectedRevision,revoked}`. Only actual authenticated business owner; legacy appointments receive no implicit grant. Retell capabilities independently default-off and are snapshotted at call registration.

Current private verification contract: backend customer page `/customer/verification/`, one-use fragment-token exchange `/customer/verification/session`, secure cookie/CSRF code completion `/customer/verification/complete`. Explicit permission covers a separate private-link SMS and Verify code. Status tool takes `{}`; private references/OTPs never enter tools. Old `/api/voice/retell/management/verification-complete` returns410. See PRIVATE_VERIFICATION_AND_CANARIES.md for complete implemented flow, default-off gates, canary scope, rate limits and still-unverified provider/device acceptance.

## Google Calendar (implemented; unprovisioned)

`/api/calendar/businesses/:businessId` uses JWT, membership scope, business billing; connections belong to individual account, not all shop owners. Exact HTTPS client return destinations configured; CORS only those origins. No Google tokens in API responses.

- GET `/connections` -> safe ID/provider/mode/status/revision.
- POST `/oauth` `{mode:"busy"|"read"|"export",returnUrl,connectionId?}` -> authorizationUrl, expiresAt. Browser uses system OAuth/universal HTTPS return; no Google password collection.
- GET `/connections/:id/calendars` -> bounded provider IDs/labels/accessRole/timezone.
- PUT `/connections/:id/sources` `{sources:[{calendarId,staffCalendarId:null|id,visibility:"busy"|"details",required:boolean,exportEnabled:boolean}]}`. One writable destination per staff mapping. Busy-only never stores private titles/attendees/descriptions.
- GET `/connections/:id/health` -> selected-source freshness/status and bounded export mapping status.
- POST `/connections/:id/sync` `{}` -> bounded sync; authenticated watch endpoint `/api/calendar/google/notifications` treats hints as dirty state, not authoritative event data.
- POST `/connections/:id/reconcile-export` `{mappingId}` -> read-first reconciliation, no blind retry after uncertain write.
- POST `/connections/:id/disconnect` `{}` -> local token removal/cache purge immediately, remoteRevocation ACCEPTED/UNKNOWN independently. Required sources remain blocking until explicitly unselected; disconnect is not permission to advertise free time. Billing lapse does not prevent disconnect.

Owner-only POST `/api/calendar/businesses/:businessId/sources/:sourceId/detach` explicitly removes a blocking/export mapping without exposing staff tokens or titles. Connection owners can disconnect even after business membership/billing is lost; required sources remain blocking. Empty sources selection needs no provider access and can explicitly unselect after disconnect. No automatic calendar fallback.

Google callback `/api/calendar/google/callback` consumes single-use state and validates PKCE, callback replay, scopes, tenant/account. `RECONNECT_REQUIRED` is an explicit reconnect state. Only Google implemented. Booksy/other providers require separately verified supported access; no scraping or borrowed credentials.

Required source maximum cache age30seconds and complete range (including buffer). Stale/missing/unavailable/revoked/dirty source -> AVAILABILITY_UNVERIFIED, never empty availability. Local mutation+export outbox is atomic in Mongo; Google write is not. Residual simultaneous external booking race remains. APPOINTMENT success is independent of external SYNCED/PENDING/FAILED/UNKNOWN/DIVERGED. Manage original through Glo; external edits/deletions never silently mutate local appointments. Restore external copy to local facts then explicit reconcile, or unselect/disconnect through reviewed policy; no automatic adoption of remote edits.

## Notification policy and UI

PUT `.../notification-policy` `{enabled:boolean}`: owner only, mounted with notification foundation. Enables collection for NEW explicitly consented appointments; never unsuppresses history, inserts consent for old records or back-sends. Default false per business and all dispatch flags false. No endpoint grants consent from phone-contact agreement.

Detail `notifications.deliveries` has purpose/revision/status/providerStatus/errorCode/staleAfterSubmission. Provider acceptance/submission is not delivered; callback may confirm delivered or identify failed/undelivered/unknown/conflicting state. Notification failure never reverses booking. Reminders need separate consent and dispatch gates. Private values, phone numbers and SMS body are not operational logs. STOP is sender-wide suppression (safe with shared senders); START does not override application consent or revive an unordered prior STOP. Owner-assisted opt-out recovery remains required; no automatic consent reactivation from callback order.

## Representative synthetic states and frontend behavior

- PREPARED: show server summary + expiry; accept affirmative only for it.
- BOOKED/CANCELED/RESCHEDULED: show exact returned result; delivery/external sync have separate indicators.
- INVALID_ARGUMENTS/INVALID_RANGE/INVALID_CURSOR: correct input/restart pagination, no silent repair.
- FORBIDDEN/BUSINESS_SUBSCRIPTION_REQUIRED: no disclosure or alternate tenant shortcut.
- STAFF_SELECTION_REQUIRED/STAFF_NOT_ELIGIBLE/MISSING_CATALOGUE_FACTS: ask supported choice or owner configuration, never invent price/duration/staff.
- UNAVAILABLE/SCHEDULE_CONFLICT: show only freshly verified alternatives.
- STALE_REVISION/APPOINTMENT_CHANGED/BUSINESS_REVISION_CHANGED/PROPOSAL_FACTS_CHANGED: refresh, prepare new summary and reconfirm; original unchanged.
- PROPOSAL_EXPIRED/VERIFICATION_REQUIRED/CALL_NOT_AUTHORIZED: no mutation, restart only authorized stage.
- UNKNOWN/SETTLEMENT_UNKNOWN: reconcile SAME command, no replacement booking or automatic resend.
- AVAILABILITY_UNVERIFIED/RECONNECT_REQUIRED/DIVERGED: show blocking calendar/reconnect/sync status; do not label free.

No proposed unimplemented endpoint is presented as implemented above. Real-device private verification acceptance, Google OAuth app/domain verification, provider/sender approval, agent publication and all live acceptance remain separately pending. Shop commercial onboarding is still blocked by existing premium onboarding gate; this phase does not invent a subscription or number.


## Integration-review corrections and fixtures

See INTEGRATION_READINESS.md for the full mounted production trace and ordered rollout. UI_FIXTURES.json contains clearly synthetic, fixed-clock example requests/responses for Mac Codex mocks; do not send example IDs to a live server.

`context.capabilities.googleProvider` names a supported provider; `googleEnabled` indicates its API composition is mounted, not that live OAuth/dispatch/acceptance succeeded. Handle CALENDAR_DISPATCH_DISABLED. `notificationPolicyAdministration` and ownerGrant are advertised only when their compositions are actually enabled. `appointmentDelegation`, `notificationConsent` and `reminderConsent` indicate collection contracts, never guaranteed delivery. Owner-only recipient editing uses existing PUT `/api/appointments/:id` with `{clientName,expectedRevision}`; scoped managers have no recipient-edit route and editRecipient=false. Do not implement an invented manager-edit endpoint.

For new managed/external-connected appointments, legacy status=rescheduled is normalized to confirmed for in-place updates; they continue occupying the new interval and must pass current staff/external checks. RESCHEDULED is a command result, not permission to free a live appointment. Unmanaged legacy semantics are preserved.

Workspace schedule conflicts now return409 `{reasonCode:"SCHEDULE_CONFLICT"}` instead of REQUEST_FAILED. All action preparation uses explicit expectedRevision; confirmation uses the exact proposalId returned by that preparation. Unknown settlement never authorizes replacement work.

Calendar successes use `{data}`; errors normally use `{reasonCode}` with403/409, invalid JSON400 and oversized body413. Browser-origin rejection may be plain403. OAuth callback is a303 redirect only on success,400 OAUTH_REJECTED otherwise. Notification-policy and owner-grant routes also have400 argument errors/404 unavailable state. Signed Retell tools are server/provider integrations, not mobile endpoints: never ship signing keys to clients. Domain REJECTED/UNSUPPORTED/UNKNOWN may arrive with HTTP200; evaluate typed status as well as transport status.

Private verification completion returns only `{status:"VERIFIED"}`, never appointment details or a browser authorityRef. Bad shape400, rejected/expired/disabled/origin403, oversized413; no-store/no-referrer headers apply. The signed live-call status tool retrieves authorityRef and lookup then intersects its verified contact digest with explicit current appointment grants. A different call cannot reuse that proof. Server-granted customer management is not equivalent to a business-owner JWT.

Safe to implement now against mocks: workspace/context/roles/calendar administration, bounded day/week reads, appointment details/actions, create/cancel/reschedule prepare-confirm-commit, Google connection/selection/health, separate notification consent/status, and the backend-hosted customer verification flow described in PRIVATE_VERIFICATION_AND_CANARIES.md. Do NOT claim live delivery or device acceptance, publish verification tooling, invent OAuth success or expose delivery guarantees. Production provisioning/provider acceptance remains pending.


Private completion changes durable state only; it does not push a model event. The caller returns to the live call and indicates completion without speaking the code; the agent checks its current challenge via the signed status tool. Google worker now inspects due sources every5seconds, with20second successful-source spacing and durable60request/minute connection accounting; approve quota/load before activation. Bounded slow batches can still fail the unchanged30second freshness check. Explicit sync without push configuration is supported as POLLING_ONLY and makes no watch request.
