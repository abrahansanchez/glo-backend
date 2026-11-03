# Retell booking envelope and development allowance - offline 2026-11-02

Starting branch experiment/voice-v2-realtime-conversation-lab, HEAD 865a595f086e0f7a1fce9536d6a79a340f31f3b4. No mobile changes. No provider requests, live queries/writes, flags, agent changes, SMS, budgets, commits or deployment were performed.

## Recorded failure and reproduced boundary

Operator evidence: call_7bf6ef787a33f334581fb9d14b1; proposal 73176746-e018-442a-9f1e-777d97033955. PREPARED at 2026-11-02 21:14:23 UTC, expiresAt 21:15:03. Caller confirmed and commit was called 21:14:41, receiving 413 / REJECTED / INVALID_REQUEST at 21:14:42. That request was before the recorded expiry. Actual live request bytes, Content-Length, headers and complete conversation envelope were not retained; do not claim a measured live body size or reconstructed transcript.

Source chain: server.js calls mountRetellStartup before its general express.json(5mb). The private /api/voice/retell prefix installs lifecycle, booking and read-only routers in that order. Only the matched booking route reads its body with express.raw: previously 32kb, inflate:false. Body-parser entity.too.large bypasses signature/JSON/args/commit code and reaches the booking router error handler, which returned exactly HTTP413 / INVALID_REQUEST. The lifecycle /events parser does not read unmatched tool paths, and the later read-only/global parsers cannot enlarge a booking body. This source plus a synthetic reproduction establishes the compatible rejection boundary, not the exact unrecorded live bytes.

Retell full payloads include call context/history, including transcript_object and transcript_with_tool_calls. Small args do not bound that body. A realistic synthetic prepare (601 serialized bytes) succeeded, then commit with growing conversation and prior tool results (57,147 bytes, 82-byte args) failed-before with 413 instead of200. After repair, same fixture passes and creates exactly one isolated appointment.

Smallest correction: booking-only 256*1024 raw-byte limit; no decompression. HMAC still uses the exact full Buffer before parsing. Full call ID/pinned agent/version/current binding, separate booking capability and strict args remain. Above-bound payloads now return 413 / PAYLOAD_TOO_LARGE, no raw body log. Invalid signatures remain401, malformed args400, foreign agent/version403. Read/lifecycle128KiB and global5MiB limits are unchanged. The 256KiB ceiling is an explicit bounded development accommodation, not proof that every possible provider envelope fits. Large read/lifecycle envelopes remain outside this patch; do not enable args-only.

## Development allowance design and exhausted-call behavior

New opt-in RETELL_SANDBOX_DEVELOPMENT_ENABLED requires exact true. Without it, the original single-use RETELL_SANDBOX_BUDGET_ID behavior is unchanged. An exhausted single-call budget currently returns selected-call Hangup without SIP or legacy V2; a duplicate claim also cannot return SIP again. Human ringing/answer remains before fallback and consumes no registration attempt.

Development mode additionally requires RETELL_SANDBOX_TEST_RUN_ID, a stable8..80 character [A-Za-z0-9_-] value. Reject checkpoint_001 and checkpoint_002's exact historical IDs as run IDs. Existing base sandbox/execution switches and verified business, pinned agent/version and valid BUDGET_ID settings remain required. The run ID replaces per-call operator budget rotation; the legacy BUDGET_ID is not the development counter namespace. RETELL_BOOKING_ENABLED and transcript policy remain independently unchanged. Fixed configured attempt limit10; no environment override to raise it. Nothing was enabled here.

New retelldevelopmentruns stores immutable run/business/agent/version/limit, used and at most ten embedded parent-call/epoch/registration-attempt reservations. Unique_id and one atomic conditional increment/push provide shared accounting across workers/reconstruction. Writes request majority; no process-local allowance or reset. Existing or incompatible scope/limit data fails closed. Reservations precede per-call budget claims and provider dispatch. Provider failures, uncertain outcomes and post-reservation storage failures do not refund attempts. Per-call budget IDs are dev_ + SHA256(JSON([runId,parentCallSid])); they cannot overwrite checkpoint_001/_002. Each retains the existing irreversible registration-consumption, SIP-reservation and callback checks. Same-call duplicates reuse its reservation and compete for one per-call claim; only one can register/return SIP. Zero automatic provider retries.

The provider guard independently resolves the application-owned attempt to its registration and per-call budget before consuming dispatch. Direct lifecycle invocation without a run/per-call reservation cannot send a request. Different business/agent/version cannot reuse a run. The ten-attempt limit applies to registration/fallback attempts, not answered human calls. It permits concurrent tests and bounds at most ten120-second connected calls (up to1200 connected seconds across the run), not ten dollars or ten wall-clock minutes. Existing setup deadline30s, SIP answer timeout20s and Dial timeLimit120 stay unchanged; backend bridge-expiry checks conservatively begin at reservation. No new timers or retries.

Exhausted development calls: no provider request or SIP, new selected registration is superseded, application-owned existing error wording then Hangup. Never return null/fall through to legacy V2. Sanitized RETELL_SANDBOX_ALLOWANCE log carries event RETELL_DEVELOPMENT_ALLOWANCE, reasonCode DEVELOPMENT_ALLOWANCE_EXHAUSTED, limit10, used10, remaining0, no account values/transcripts/provider error. Duplicate callbacks still do not consume attempts; late/expired callbacks cannot reauthorize tools. The stable run remains exhausted after restart; no automatic reset/replenishment/deletion. Operators must not rotate run IDs to bypass approved limits.

## Additive provisioning and settings (future separately approved operations)

One new collection: retelldevelopmentruns, required default unique _id only. No extra secondary or TTL index. Existing retellsandboxbudgets unique_id and registration attempt/provider-call unique indexes remain prerequisites and are not altered. Auto-index/auto-create are disabled on the new model; no init occurs in disabled development mode. Runtime explicit run insert may create its collection if authorized Mongo permissions permit; provision/verify it additively before activation rather than relying on that behavior. Do not sync/drop, migrate historical budget rows, insert allowance documents manually or reset counters.

After review/commit/deployment with flags off, provision only that missing collection and verify _id_ if required. Do not touch glo_retell_checkpoint_001 or glo_retell_checkpoint_002. Select one approved stable development run ID with configured test business and pinned agent/version. Set RETELL_SANDBOX_DEVELOPMENT_ENABLED=true and RETELL_SANDBOX_TEST_RUN_ID=<approved_stable_run_id> only through a separately authorized operation. Existing sandbox and booking switches require their own approval; this document does not enable them. Retell dashboard tools, schemas, prompt and publication do not need changes for this patch. Exact raw signed envelope still required.

## Next controlled booking test and rollback

First use the read-only command below to inspect the failed proposal, exact durable command match and checkpoint002. A 413 means this handler did not invoke commit for that request, but is not proof of no previous/later effect. An absent command is not settled failure. UNKNOWN/COMMITTING require existing reconciliation, never create a replacement blindly. Do not reuse an expired old proposal or reset checkpoint002.

After separate authorization and deployment/configuration/index review, check approved run usage, place one call through the existing number/mobile fallback with one supported catalogue item and known synthetic customer, prepare/read back/explicitly confirm within expiry, verify BOOKED corresponds to exactly one persisted command/appointment and notificationsSuppressed=true. Check transcript ingestion per existing policy. Conflict/unknown paths must not claim success. SMS stays suppressed; no published agent edit or provider rerun was performed here. Further calls within the same approved run consume its remaining allowance; stop at10. Authorize any appointment cleanup separately.

Rollback: turn off either base sandbox flag and drain/end in-flight calls through approved operations, or disable booking separately to retain reads. Disabling development mode reverts to the original configured single-use budget (an exhausted checkpoint still rejects), not a fresh allowance. Do not delete/reset run, per-call budget, registration or command rows; disabling startup alone does not hang up remote legs. Preserve uncertain commands for reconciliation.

## Read-only Render inspection and configured usage

Run from deployed Render Bash shell; final NODE must be alone. Uses native read methods only, no model init/index/write, no credentials/raw args/customer facts. No secrets are printed. This command is supplied but NOT executed:

```bash
node --input-type=module <<'NODE'
import mongoose from 'mongoose';
let client;
try {
  if (!process.env.MONGO_URI) throw Error();
  client = new mongoose.mongo.MongoClient(process.env.MONGO_URI, {serverSelectionTimeoutMS:5000});
  await client.connect(); const db = client.db();
  const proposalId = '73176746-e018-442a-9f1e-777d97033955';
  const callId = 'call_7bf6ef787a33f334581fb9d14b1';
  const proposal = await db.collection('retellbookingproposals').findOne({_id:proposalId}, {
    projection:{_id:1,callId:1,parentCallSid:1,businessId:1,status:1,expiresAt:1,createdAt:1,updatedAt:1,
      factsHash:1,confirmedAt:1,confirmationFactsHash:1,appointmentId:1}
  });
  console.log('proposal', JSON.stringify(proposal ? {
    proposalId:proposal._id,status:proposal.status,expiresAt:proposal.expiresAt,
    confirmedAt:proposal.confirmedAt ?? null,appointmentId:proposal.appointmentId ?? null,
    matchesRecordedCall:proposal.callId===callId,
    confirmationMatchesFacts:Boolean(proposal.confirmationFactsHash && proposal.confirmationFactsHash===proposal.factsHash)
  } : {status:'NOT_FOUND'}));
  const appointments = await db.collection('appointments').find({
    'bookingCommand.idempotencyKey':`retell:${proposalId}`,
    ...(proposal ? {barberId:new mongoose.Types.ObjectId(proposal.businessId)} : {})
  }, {projection:{_id:1,status:1,bookingCommand:1,notificationsSuppressed:1}}).limit(2).toArray();
  console.log('commandOutcome',JSON.stringify({appointments,
    interpretation:appointments.length ? 'PERSISTED_MATCH_REQUIRES_STATUS_REVIEW' : 'NO_MATCH_OBSERVED_NOT_PROOF_OF_SETTLED_FAILURE'}));
  const budgetProjection={_id:1,status:1,parentCallSid:1,ownerEpoch:1,registrationAttemptId:1,
    childCallSid:1,setupExpiresAt:1,bridgeExpiresAt:1,endedAt:1};
  const checkpoint=await db.collection('retellsandboxbudgets').findOne({_id:'glo_retell_checkpoint_002'},{projection:budgetProjection});
  console.log('checkpoint_002',JSON.stringify(checkpoint || {status:'ABSENT'}));
  const development=process.env.RETELL_SANDBOX_DEVELOPMENT_ENABLED==='true';
  if(development){
    const id=process.env.RETELL_SANDBOX_TEST_RUN_ID;
    if(!/^[A-Za-z0-9_-]{8,80}$/.test(id || ''))throw Error();
    const run=await db.collection('retelldevelopmentruns').findOne({_id:id},{projection:{businessId:1,agentId:1,agentVersion:1,limit:1,used:1}});
    const scopeMatches=!run || (run.businessId===process.env.RETELL_SANDBOX_BUSINESS_ID
      && run.agentId===(process.env.RETELL_SANDBOX_AGENT_ID || 'agent_1da974cf19d41a0b0e64b012d5')
      && run.agentVersion===Number(process.env.RETELL_SANDBOX_AGENT_VERSION) && run.limit===10);
    const validCount=!run || (Number.isInteger(run.used)&&run.used>=0&&run.used<=10);
    console.log('configuredAllowance',JSON.stringify({mode:'DEVELOPMENT',configuredLimit:10,
      scopeMatches,used:scopeMatches&&validCount?(run?.used ?? 0):'UNKNOWN',
      remaining:scopeMatches&&validCount?10-(run?.used ?? 0):'UNKNOWN',
      status:!run?'ABSENT':!scopeMatches||!validCount?'INCOMPATIBLE':run.used===10?'EXHAUSTED':'AVAILABLE'}));
  } else {
    const id=process.env.RETELL_SANDBOX_BUDGET_ID;
    if(!/^[A-Za-z0-9_-]{8,80}$/.test(id || ''))throw Error();
    const row=await db.collection('retellsandboxbudgets').findOne({_id:id},{projection:{_id:1}});
    console.log('configuredAllowance',JSON.stringify({mode:'SINGLE_CALL',configuredLimit:1,used:row?1:0,remaining:row?0:1}));
  }
} catch(error){
  console.error(JSON.stringify({event:'RETELL_READ_ONLY_INSPECTION_FAILED',mongoCode:Number.isInteger(error?.code)?error.code:null}));
  process.exitCode=1;
} finally {if(client)await client.close().catch(()=>{});}
NODE
```

## Offline verification

Tests use fake provider/telephony and the existing cached Mongo executable in an isolated loopback replica set. No production URI or credentials. Coverage: realistic enlarged booking envelope; before413/afterBOOKED; exact signature, strict args, foreign version and256KiB rejection; unchanged other parser limits; ten-of-fourteen concurrent attempt accounting; duplicate fallback/screen/completion; reconstructed durable repositories; uncertain provider dispatch; storage failure after reservation; preserved checkpoint rows; scope pinning; disabled/single-call and human-answer behavior; direct guard bypass and expiry/late callbacks. This does not establish exact live body bytes, deployed indexes/majority topology, provider or carrier acceptance. Final totals/overlay inventory are appended after validation.

## Final results and exact round inventory

Worktree and exact clean 865a595 overlay: **404/404 affected tests pass each**, zero failures/skips/cancellations. Includes the full prior389-test affected scope plus two booking-envelope regressions, nine development-allowance checks and four startup-setting checks. Nine changed JavaScript syntax checks, both Git diff checks, new-file whitespace and the read-only inspection command syntax pass. Before-fix targeted regression failed413 versus expected200; retained in payload-before.tap. No completed test was substituted with a fake success. The recovery test uses a fresh independent Mongo client/model repository against the same isolated database; it reconstructs durable state without killing a deployed service. No deployed database capability or live provider compatibility is claimed.

Exact12-file task-only inventory (unrelated adapter edits, engineering and lab/evaluation work excluded):

```text
docs/voice/RETELL_DEVELOPMENT_ALLOWANCE.md
docs/voice/RETELL_IMPLEMENTATION_TRACKER.md
docs/voice/RETELL_SANDBOX_CHECKPOINT.md
models/RetellDevelopmentRun.js
routes/retellBookingRoutes.js
services/voice/retell/DevelopmentBudgetRepository.js
services/voice/retell/SandboxHandoff.js
services/voice/retell/installSandbox.js
services/voice/retell/startup.js
tests/services/retellBookingTranscripts.test.js
tests/services/retellDevelopmentAllowance.test.js
tests/services/retellStartup.test.js
```

External evidence: C:/Users/sanch/AppData/Local/Temp/retell-payload-development-20261102 (payload-before.tap, affected-final.tap, overlay.tap, inventory.json, hashes.json, checks.json). SHA256 before values are starting-HEAD Git blob bytes, after values are final working-tree bytes. Code overlay was tested without excluded adapter/lab files. Docs were updated with final results afterward; no runtime/test content changed afterward.


## 2026-11-03 development duration snapshot

The latest offline patch selects300sec only for newly admitted explicit development calls, with120sec retained for single-call and historical unsnapshotted calls. Registration and per-call budget persist the selected duration and share one immutable bridge deadline. Proposal freshness remains60sec capped by remaining authorization; setup30sec, answer20sec, pinned identity, ten-attempt quota and SMS suppression remain unchanged. No new flag/index/provisioning, reset or activation. Preserve glo_retell_booking_dev_001 and consumed checkpoints. This dated policy supersedes earlier120sec statements only for new development admissions. See [RETELL_DEVELOPMENT_DURATION.md](RETELL_DEVELOPMENT_DURATION.md) for evidence limits, complete deadline trace, read-only call/proposal/outcome inspection, exact reviewed inventory, deployment and controlled-test/rollback procedure.

Duration-slice validation:429/429 affected checks pass in worktree and combined clean db5ab5b overlay, zero fail/skip/cancel; ten new duration cases pass. Exact16-file round versus19-file combined diagnostic overlay inventory and hashes are documented in RETELL_DEVELOPMENT_DURATION.md. Syntax/diff checks pass. All changes remain unstaged/uncommitted; no activation, production records, allowance/run ID, Retell dashboard or mobile settings changed.
