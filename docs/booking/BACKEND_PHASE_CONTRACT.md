# Booking backend phase: contracts and checkpoint ledger

**Current shop/workspace completion:** [SHOP_WORKSPACE_API.md](SHOP_WORKSPACE_API.md) and [MOBILE_START_HERE.md](MOBILE_START_HERE.md) supersede earlier statements that shop setup, invitations or workspace discovery are missing. New backend contracts are implemented/offline-tested, default-off; commercial/provider configuration, native UI and live acceptance remain unverified. Existing independent ownership is preserved.


2026-11-04; starting HEAD a521beeaa5317f0a7ac58c1e618831a6f883db10. All implementation offline, default-off and uncommitted. This document is not a completion claim.

## A: source-grounded gap map

Barber is the existing authenticated account AND business/location owner. Appointment.barberId, Client.barberId, Subscription.barber and Retell registration.businessId refer to that tenant. Do not replace these IDs. There is no User, Shop, StaffMembership, customer authentication or calendar connection model. productType shop exists, but premiumIndividualOnboardingService/onboardingReadinessService/paymentFirstProvisioningGate explicitly reject shop setup. Existing staff must not be assigned another paid subscription or phone route as a side effect of membership.

Appointment.clientName is a recipient label, clientPhone a contact, neither a person identity. Client.hasConsent/isUnsubscribed is messaging policy, not management authority. Caller-ID/contact reuse is not delegation or SMS consent. Product decision confirmed: explicit appointment-level management delegation; new appointments may delegate to the agreed confirmed contact. Shared contact can manage multiple recipients only through separate explicit grants. Legacy appointments require authenticated owner grants. No automatic historical backfill or merging by phone/name.

Existing shared writers: controllers/appointmentController.js (create/update/hard delete), controllers/aiBookingEngine.js (create/update), controllers/smsController.js (cancel), utils/booking/createAppointment.js, createIdempotentAppointment and Retell BookingService. All converge on atomicScheduleMutation, which uses business/local-date fences and transactions. Current transaction helper protects interval conflicts, not staff selection, hours/future checks on every writer, expected appointment revisions or durable update command outcomes. SMS CANCEL currently chooses by phone before tenant resolution; do not reuse it for customer management.

Existing read models: /api/appointments range/upcoming/past/available-slots, protected by account and own subscription. No staff-scoped permissions. Existing create confirmation and hourly reminder paths are not a transactional notification outbox. MessageDelivery already provides durable submission/unknown state and idempotency: reuse it. Retell appointments remain notificationsSuppressed=true. No Google/OAuth integration exists.

## Stable domain distinctions

businessId = existing Barber tenant/location ID; accountId = authenticated Barber login ID (not a new tenant); membership = business/account/role/calendar permissions; staff calendar = scheduling identity, may exist without a login or personal paid subscription; contact = normalized E.164 communication address; recipient = appointment-local person label; appointment = original persistent record; command = durable action identity independent of appointment and provider delivery.

Independent legacy records retain implicit owner schedule, never silently assigned to a newly created staff calendar. Unassigned legacy occupying records conservatively conflict with every staff calendar until explicit owner-reviewed assignment. Staff conflict scope is business+calendar+local date; business/day fence remains shared across old/new writers for compatibility and shared-resource safety. Any-available policy: eligible active calendar IDs in lexical order, first verified available; selected calendar, service, duration, price and schedule revisions are frozen in a proposal and rechecked; no switch at commit. Only one catalogue item/explicit existing combination can be booked.

## Target application contracts (not all implemented yet)

Versioned base /api/booking/v1/businesses/:businessId under existing JWT authentication. Server verifies owner/membership and owner's billing entitlement, never staff personal billing. Owner has business administration; manager explicit calendar scope; staff own allowed calendars. Calendar connection ownership is individual account permission, not shop ownership. Phone routing/billing unchanged.

GET context: role, accessible calendars, capabilities, policy version. GET calendars/range?from&to&cursor&limit: bounded [from,to), max31days/100items, UTC instants+business timezone, source labels APPOINTMENT/EXTERNAL_BUSY; busy-only has no private titles/contact. POST staff/calendars, membership, services/hours/time-off mutations require owner/manager scoped permission and expected revision. Pagination uses opaque server cursors; no client-submitted tenant authority.

POST appointment prepare/commit: idempotency key, expected revision, exact summary/proposal, explicit confirmation; cancel/reschedule preserve original ID and transactionally write command settlement and outbox. Unknown commit requires same-command reconciliation, not a new booking. Appointment details include allowedActions plus independent notification and externalSync state; UI controls never confer permission.

Retell tool tenant is ONLY verified durable call binding. Independent gates for delegation, verify, lookup, cancellation and reschedule; bookingAllowed is not management permission. Verification binds business/contact/purpose/session, expiring challenge and single-use proof; proof plus persisted appointment delegation yields scoped selection references. Owner can issue legacy appointment-specific grants using JWT. No phone/name/appointment-ID shortcut. Shared recipients remain distinct. Changed contact does not silently change existing authority.

Google: provider interface only Google implemented. OAuth confidential server code flow, one-use state and PKCE, exact redirect/return allowlists, encrypted refresh tokens, minimum selected capabilities. Select blocking calendars and at most one writable destination per staff calendar. Personal sources store busy intervals only. Notifications trigger sync work; bounded full/incremental sync, cursor410 reset, recurrence expansion, DST/all-day/free/cancelled events and complete range freshness required. External copies are separate mappings, not Appointments. Local mutation+outbox transactional; deterministic Google event IDs and stale-job checks, reconcile uncertain submissions. External edits mark divergence, never silently alter appointments. External freshness rechecked before local transaction; no provider HTTP in Mongo transaction; residual cross-system race explicitly remains.

Notifications: separate explicit appointment notification consent, opt-out recheck, per-action/revision/recipient outbox. Confirmation/contact reuse is NOT messaging consent. Historical suppression never lifted; no back-send. Verification messages separate from transactional appointment notifications and marketing. Provider submission != delivery; unknown submission not automatically resent. Reminder capability separately gated and current revision/status rechecked.

## Acceptance and rollout

LIVE_VALIDATED baseline only: call_0265d05d767e0f6a90c9298db21; proposals2491af9b-597c-4e02-8847-5ebba69c088b and0487a712-e1f1-42f9-a85e-3db74275dcc7; exactly one confirmed appointment per command, correct tenant/contact/hashes, suppression true, finalized35-turn transcript, terminal registration/budget and matching300second deadlines. No historical records altered.

Retell publishedV2 contact collection configured with US/run glo_retell_contact_dev_002 but NOT LIVE_VALIDATED. Preserve both this pending acceptance and unresolved greeting observation. New tools require a separately reviewed published version and explicitly approved matching test scope. Never repin/reset existing runs. No live configuration changed.

Historical initial checkpoint status (superseded by the continuation ledger below): A discovery implemented; B-H were incomplete. Live acceptance must cover new-call management, individual selected cancellation, atomic rescheduling, specific/any staff, Google busy/export/update/delete, SMS actual receipt/callback, revoked permissions and deferredV2 collection. No backend phase completion claim until required external prerequisites and live acceptance pass.

Official references checked2026-11-04: https://developers.google.com/identity/protocols/oauth2/web-server ; https://developers.google.com/workspace/calendar/api/guides/sync ; https://developers.google.com/workspace/calendar/api/guides/push ; https://developers.google.com/workspace/calendar/api/guides/create-events . Provider pagination/cursors/notifications do not imply cross-system atomicity.

## Checkpoint B foundation: implemented subset and exact API

GLO_STAFF_SCHEDULING_ENABLED defaults false. The disabled boot returns before loading models/routes/billing dependencies. Enabled boot mounts /api/booking/v1 through existing JWT protect. Billing is checked against the BUSINESS owner's existing Subscription, not a staff member's personal subscription. This is not shop onboarding activation; current shop signup gate remains unchanged.

All paths below begin /api/booking/v1/businesses/:businessId. Implemented: GET /calendars; POST /calendars; PUT /calendars/:calendarId; POST /memberships; POST /availability; POST /appointments/prepare; POST /appointments/commit. No Google, SMS or Retell management endpoint is exposed by these routes.

Calendar create JSON: {label:string<=128,active:boolean,services:[{serviceId:existing catalogue subdocument ID,price:nonnegative currency with cents,durationMinutes:integer1..480}],hours:{sun..sat:{isClosed:boolean,open:HH:mm,close:HH:mm}},timeOff:[{startAt:ISO,endAt:ISO}]}. One hundred services/time-off entries maximum. Closed-day open/close may be omitted. Calendar update wraps {expectedRevision:positive integer,calendar:<same complete JSON>}. All catalogue IDs must belong to that business. Unknown fields reject. No arbitrary service-name translation. No staff subscription or phone routing is provisioned.

Membership JSON: {accountId:existing authenticated-account ObjectId,role:manager|staff,active:boolean,calendarIds:[owned calendar IDs]}. Only the actual business owner can issue/revoke memberships. Managers can edit/book only explicitly allowed calendars. Staff currently have scoped read/availability access only. No staff invite/login flow or independent staff subscription is created. Empty calendar scope grants no calendar access.

Availability JSON: {calendarId:ObjectId|ANY,serviceId:catalogue ID,startAt:ISO8601 with Z or explicit offset}. Returns selected calendar/service/time/duration/price/revision, never a booking. ANY scans active eligible calendars in lexicographic ID order (currently bounded100 calendars); no claim is made that this supports arbitrary resource pools. Business and staff hours must both permit the entire appointment, staff time-off must not overlap, and existing business buffer rules apply. Future instant/timezone checks are server-side.

Prepare JSON adds {clientName,contactNumber:valid explicit E.164} to availability fields. Only owner/manager mutation permissions apply. Returns PREPARED, proposalId, expiresAt<=60seconds, exact summary and requiresExplicitConfirmation:true. No price/staff/time substitution at commit. Commit JSON: {proposalId,confirmation:AFFIRMATIVE}. Same authenticated account/business, current permission, proposal expiry, business catalogue/hours hash, staff revision, current hours/absences and conflicts are rechecked. The existing shared transaction creates the appointment and settles the proposal together, using inherited appointment idempotency key. Unknown commit is reconciled by the original key; absent settlement remains UNKNOWN.

StaffCalendar/StaffMembership/StaffBookingProposal are additive collections, no TTL on durable proposals. Appointment gains optional staffCalendarId/staffServiceId/staffRevision/staffPrice and scheduleRevision. No historical appointment assignment/backfill occurs. Business/day ScheduleFence continues to serialize old/new writers; assigned staff conflicts include same staff plus every unassigned legacy blocker. Different explicit staff may occupy the same time. Business, staff-calendar and membership document fences also serialize configuration/revocation with staff booking transactions. Internal native fields bookingConfigurationFence/bookingFence/accessFence are server bookkeeping, never client-writeable API properties.

Shared atomic create/update now validate explicit staff assignments even for existing owner/AI writers, preserve tenant identity, forbid clearing an existing assignment, and advance update revisions. Cancellation of existing assigned appointments can free capacity without requiring that the old slot is still future. Existing unassigned appointments retain legacy behavior. Generic transaction hooks now support beforeUpdate/afterUpdate/afterCreate for future durable command/outbox work; their existence is NOT cancellation/reschedule implementation.

All new staff bookings currently notificationsSuppressed=true. This does not implement the later explicit notification policy or new booking delegation. Existing Retell booking/contact schemas and prompts are unchanged by this checkpoint. Retell does not yet select staff through this new foundation; that integration is NOT_COMPLETE. Owner range pagination, staff invitation lifecycle, shared-resource allocation and shop onboarding are also NOT_COMPLETE. Do not deploy/activate this partial phase as a completed shop-booking product.

## Checkpoint C authority core: implemented subset

AppointmentManagement.js adds explicit per-appointment contact-HMAC grants, expiring call/business/purpose-bound verification challenges and durable rate buckets. VerifyTransport implements Twilio Verify Services/Verifications and VerificationCheck via injected HTTP, ten-second request signal, no retries and allowlisted response fields; disabled mode does not read credentials or HTTP dependencies. ManagementAuthority verifies strict full E.164, uses HMAC with an injected minimum32byte key, never stores OTP codes, and checks direct expiry independent of TTL cleanup. Limits: five contact sends/hour, two session sends/hour, at least60seconds between contact sends, five checks/challenge. Unknown dispatch stays non-authorizing. Single successful challenge check cannot be replayed; the resulting verified scope can read only separately delegated appointment IDs/actions. Same contact does not grant all matching appointments. Ended calls and revoked grants deny access.

These C core libraries are NOT mounted and have no live flag/provider/client composition yet. No placeholder OTP Retell tool was added. No new booking delegation, authenticated owner-grant endpoint or private customer code-entry UI has been wired. Those are the next required C steps before D. OTP must not be spoken into retained provider transcripts or logged; secure code entry and provider retention configuration require explicit integration. Twilio Verify service/configuration, fraud/rate policy and real delivery acceptance remain external prerequisites. Historical A2P30034 is not current approval evidence. Verification SMS remains separate from appointment notifications/marketing.

## Explicit remaining checkpoint status

A IMPLEMENTED discovery/contracts. B foundation IMPLEMENTED/OFFLINE_TESTED, broader B/Retell integration NOT_COMPLETE. C authority core IMPLEMENTED/OFFLINE_TESTED, C end-to-end NOT_COMPLETE. D later-call lookup/cancel/reschedule NOT_IMPLEMENTED. E Google connection/import NOT_IMPLEMENTED (official docs researched only). F combined external availability/export NOT_IMPLEMENTED. G new appointment notification outbox/dispatch NOT_IMPLEMENTED. H complete UI handoff/acceptance NOT_COMPLETE. Do not call this consolidated phase complete or ready for live acceptance.

Next ordered implementation: complete C persisted owner-issued/new-booking delegation and secure verification composition; D scoped opaque lookup/proposals and transactional cancel/reschedule settlement; E/F connector and durable sync; G notification consent/outbox; H integrated APIs and acceptance. All existing runs and the deferred V2 contact test remain untouched.

## Additive provisioning / read-only prerequisites (future operator commands; NOT executed)

These commands apply only to the partial B/C schemas, not a complete-phase deployment. Do not activate the feature until remaining integration/review is complete. Current server staff startup checks collection/index existence read-only and refuses to mount if the unique membership index is missing/incompatible; no index creation occurs during startup. No changes to any historical appointment/phone/budget record or index deletion are needed.

Render Bash read-only inspection, native collections only:

```bash
node --input-type=module <<'NODE'
import mongoose from 'mongoose';
let client;
try {
  client=new mongoose.mongo.MongoClient(process.env.MONGO_URI,{serverSelectionTimeoutMS:5000,socketTimeoutMS:10000});
  await client.connect(); const db=client.db();
  for(const name of ['staffcalendars','staffmemberships','staffbookingproposals','managementgrants','managementchallenges','managementrates']) {
    const exists=await db.listCollections({name},{nameOnly:true,maxTimeMS:5000}).hasNext();
    if(!exists){console.log(name,'COLLECTION_MISSING');continue;}
    const indexes=await db.collection(name).listIndexes({maxTimeMS:5000}).toArray();
    console.log(name,JSON.stringify(indexes.map(i=>({name:i.name,key:i.key,unique:i.unique===true,expireAfterSeconds:i.expireAfterSeconds}))));
  }
  const hello=await db.admin().command({hello:1});console.log('TRANSACTION_TOPOLOGY',JSON.stringify({replicaSet:typeof hello.setName==='string',mongos:hello.msg==='isdbgrid'}));
} catch {console.error('PREREQUISITE_INSPECTION_FAILED');process.exitCode=1;} finally {await client?.close().catch(()=>{});}
NODE
```

Future separately approved additive provisioning from these exact model definitions (no syncIndexes, drops, record inserts or unrelated auto indexing):

```bash
node --input-type=module <<'NODE'
import mongoose from 'mongoose';
mongoose.set('autoIndex',false);mongoose.set('autoCreate',false);
try {
  await mongoose.connect(process.env.MONGO_URI,{autoIndex:false,autoCreate:false,serverSelectionTimeoutMS:5000});
  const [{default:Calendar},{default:Membership},{default:Proposal},management]=await Promise.all([import('./models/StaffCalendar.js'),import('./models/StaffMembership.js'),import('./models/StaffBookingProposal.js'),import('./models/AppointmentManagement.js')]);
  for(const Model of [Calendar,Membership,Proposal,management.ManagementGrant,management.ManagementChallenge,management.ManagementRate]) {
    try{await Model.createCollection();}catch(error){if(error.code!==48)throw error;}
    await Model.createIndexes();
    console.log(Model.collection.name,JSON.stringify((await Model.collection.indexes()).map(i=>({name:i.name,key:i.key,unique:i.unique===true,expireAfterSeconds:i.expireAfterSeconds}))));
  }
} catch {console.error('BOOKING_FOUNDATION_PROVISIONING_FAILED');process.exitCode=1;} finally {await mongoose.disconnect();}
NODE
```

Neither command has been executed against Render/production. Index inspection is not a proof of transaction support: isolated Mongo transaction/concurrency tests are separate evidence. Management challenge/rate TTLs are cleanup only; service explicitly checks expiry. Grants/proposals/command identity have no TTL recycling.

## Rollback and UI implementation limits

No new feature flag was enabled. GLO_STAFF_SCHEDULING_ENABLED is the only mounted new capability and defaults off. Turning it off removes new staff UI routes on restart; it must NOT disable protection of already assigned staff appointments in shared atomic writers. Reverting code after staff records exist therefore needs reviewed handling of those records, not blind rollback to an older scheduler that treats them as unassigned. No historical backfill is automatic.

Do not publish any new Retell tools/prompt for this partial slice. Existing exact bilingual booking/contact templates, signatures and four tools remain unchanged and are documented in docs/voice/RETELL_CONTACT_COLLECTION.md. No supported lookup/cancellation/reschedule tool is being claimed from these libraries. Management UI can use the approved explicit-delegation policy but must show pending implementation instead of fake successful verification/mutation/calendar/SMS states. No mobile files changed.

External prerequisites still needed later: Google OAuth project/consent/scopes/allowed callback plus encrypted refresh-token key policy; Twilio Verify service/fraud and delivery approval; separate appointment SMS consent/opt-out/A2P verification; secure private code-entry UI; separately approved version-matched Retell test scope; live acceptance. None was configured or contacted here. Booksy remains unsupported; no scraping or inferred full appointment from Google busy time.

## Checkpoint D core continuation (still NOT connected end-to-end)

ManagementService plus ManagementSelection/ManagementAction now implement bounded authorized lookup, opaque session/business/proof-bound selections, expiring cancellation/reschedule proposals, explicit-confirmation commits, optimistic snapshot/revision protection and durable action settlement within the shared scheduling transaction. Cancellation preserves Appointment and its original bookingCommand; reschedule updates the same record and excludes itself from overlap checks. Failed conflict leaves original untouched. Duplicate settled command returns its own result; uncertain commits reconcile the same action and never silently create a replacement. Revocation/proof expiry are rechecked on replay and transaction commit. Prepared cancellation timestamps are not passed off as actual commit times. Selection TTL is cleanup; action identity is not TTL recycled.

Required injection fenceBinding must implement durable call-row fencing inside the transaction; the service refuses construction without it. Tests inject current-call fake fencing alongside real isolated Mongo transactions, so they do NOT prove production durable-call fencing composition. Rescheduling requires an application-owned resolver; no absent resolver is treated as success. That resolver must recheck current catalogue/pricing/hours/staff/external source facts immediately before dispatch; a production resolver/Retell route is not wired. No caller/model appointment ID is a selection authority. Grant/verification and action libraries remain unmounted. D core tests are implementation evidence, not a claim that later-call phone management is usable yet.

C/D core isolated Mongo tests now10/10: six proof/grant tests and four lookup/cancel/reschedule tests. Verify transport fake HTTP tests6/6. Staff foundation tests24/24. Final combined and clean-overlay results/hashes are in external glo-booking-phase-20261104 evidence. The prior D NOT_IMPLEMENTED status means end-to-end tool/composition; it is superseded only for this tested core library.

Final saved checkpoint evidence: combined511/511 and exact clean starting-HEAD overlay511/511, no failures/skips/cancellations. New staff24/24; Verify HTTP6/6; management Mongo10/10. All changed JavaScript syntax and both diff checks passed. Exactly20 task files; final inventory/hashes and per-checkpoint inventories live outside worktrees in %TEMP%/glo-booking-phase-20261104. Documentation finalized after runtime validation; no runtime changes afterward. No feature was activated, no credentials accessed, no production/provider operations performed. The consolidated phase remains IN_PROGRESS, not READY or LIVE_VALIDATED.


## Consolidated continuation checkpoint ledger (2026-11-04)

C/D IMPLEMENTED and OFFLINE_TESTED: agreed appointment-specific delegation persists with actual Retell or owner booking in the shared transaction. Separate private code-entry, real Verify HTTP adapter with fake transport, durable challenge/rate state, production registration/epoch/screening/deadline fences, signed scoped tools, owner grants for legacy appointments, current proof/grant/revision rechecks, idempotent cancellation and in-place rescheduling. No blanket phone-match authorization. Owner foundation no longer depends on enabling phone sandbox. The customer private UI and safe challenge-reference handoff are still external UI acceptance dependencies; do not solicit OTP in provider transcripts or invent a delivered link.

E/F IMPLEMENTED and OFFLINE_TESTED: encrypted one-use OAuth/PKCE, account-owned Google selections, busy/details privacy, bounded full/incremental import with recurrence/DST/cursor410, authenticated watch hints/renewal and periodic reconciliation. Required-source freshness is30seconds and complete buffered range; permission/disconnect/outage fails closed. Shared scheduling checks and transaction write fences protect all new managed writers. Durable local mutation/export outbox, deterministic remote copy, ETag updates/removal, unknown reconciliation and divergence policy. No cross-provider/Mongo atomicity claim. No connected provider acceptance.

G IMPLEMENTED and OFFLINE_TESTED: explicit appointment SMS/reminder consent distinct from contact/delegation, business policy opt-in, shared MessageDelivery outbox, real Twilio message HTTP adapter with fake transport, current-revision/opt-out checks, signed callbacks with monotonic/conflicting state, bounded known429 retry and no unknown resend. Historical suppression preserved. Legacy immediate/reminder paths exclude outbox records. Booking remains successful independently of delivery. STOP sender-wide; automatic START application re-consent intentionally unsupported to avoid unordered resurrection. Current sender/A2P/Verify/carrier status uninspected.

H IMPLEMENTED and OFFLINE_TESTED: authenticated independent/staff context, calendar administration and scoped day/week/range pagination, private busy blocks, appointment details/allowedActions, prepare/commit booking/cancel/reschedule APIs and status/error contracts. Retell staff selection uses current public catalogue and freezes staff-specific price/duration (including zero), one catalogue or existing combination only. Shop commercial onboarding stays behind the existing onboarding gate; this phase adds no subscription/number side effects.

Usable Mac Codex contract: UI_API_HANDOFF.md. Full management tool contracts: MANAGEMENT_API.md. Complete unprovisioned EN/ES templates: services/voice/retell/phaseAgentTemplates.js. Configuration, additive future provisioning, retention/rollback and controlled acceptance: OPERATIONS_AND_ACCEPTANCE.md. Exact task inventory, checkpoint categories and hashes are recorded with the final continuation evidence; excluded adapter/lab work remains untouched.

Status distinction: offline backend implementation is ready for independent review, not a claim the whole phase is LIVE_VALIDATED. Actual OAuth/client verification, private customer code-entry UI, production prerequisite checks/provisioning, provider sender approval, reviewed agent publication/version-matched bounded scope and controlled acceptance remain BLOCKED_BY_EXTERNAL_PREREQUISITE. Existing verified live two-booking milestone and deferred contactV2 acceptance remain exactly as recorded above; no new provider requests or live writes performed.


## Integration-readiness review qualification

The80-file offline implementation was hash-verified against its saved569-test evidence. Subsequent narrow composition/security/UI corrections and their failing-before probes are recorded in INTEGRATION_READINESS.md. Customer private reference delivery is an unimplemented integration seam, not just an undeployed page; no connected later-call management can be claimed until it and private customer UI are implemented/accepted. Exact published version, provider/database readiness and live acceptance remain pending. Workspace API fixtures are UI_FIXTURES.json; the final review manifest records the updated accumulated inventory and tests. Original milestone, deferredV2 acceptance, unrelated edits and all budgets remain unchanged.
