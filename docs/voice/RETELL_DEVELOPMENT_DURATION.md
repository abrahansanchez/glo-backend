# Retell development-call duration snapshot - offline 2026-11-03

Base/local HEAD db5ab5bf3c9e5696e05c664c802ed6a3a3188603, branch experiment/voice-v2-realtime-conversation-lab. Existing uncommitted handoff diagnostics and unrelated adapter/test/lab work preserved. No mobile, provider/dashboard, environment, production DB, call, allowance reset, commit, push or deployment changes were made.

## Live evidence versus cause

Operator supplied call_08b97b9f5e820a8a58d576095e3 start2026-11-03T01:48:42.438Z, end01:50:42.601Z:120.163 seconds. First proposal d135b57d-fa5e-4e9a-9edc-2e6f99ce6a95 requested Nov7 10AM; caller corrected to3PM. Revised5cc6f87e-e435-4a8c-8ac2-cac4d1781d16 PREPARED01:50:26.626Z, expiry01:50:42.056Z:15.430 seconds available, consistent with the remaining backend bridge authorization window. No commit appears in supplied provider logs. Retell User_hangup and timing do not independently prove who terminated transport. The inspection command below can correlate persisted deadlines/outcomes, not establish remote causation. Do not assume absence of a provider-log request proves absence of an appointment.

## Complete duration/deadline trace

| Boundary | Existing policy | Patched policy |
| --- | --- | --- |
| Registration provider request |3-second request deadline, no retry | unchanged |
| Registration identity lease |10min from signed incoming observation | unchanged; bridge/proposals cannot outlive it |
| Budget setup |30sec from fallback claim | unchanged |
| SIP answer timeout |20sec | unchanged |
| Selected bridge duration |120sec for all sandbox calls | new explicitly enabled development admissions300sec; single-call120sec |
| Dial timeLimit |120 connected seconds | snapshotted call duration120 or300; no dashboard override |
| Budget bridge deadline |reservation time+120sec | first reservation time+snapshotted duration, capped by registration lease |
| Registration bridge deadline |separate reservation time+120sec | same persisted absolute budget deadline, never later than registration lease |
| Tool authorization |ACTIVE/current/screened and both registration/bridge unexpired | unchanged guards; returned binding expiry is explicit minimum of lease/bridge |
| Booking proposal |min(prepare time+60sec, binding expiry, registration bridge deadline) | unchanged, never five minutes just because the call is longer |
| Commit |fresh authorization/proposal/business/availability, transaction ownership/expiry fence | unchanged |
| End/late lifecycle |Retell end marks registration ended; Twilio completion supersedes/retires registration and ends budget | unchanged; late events cannot restore expired/terminal authority |

Backend authorization conservatively starts its bridge clock at reservation, before SIP answer. Twilio timeLimit counts connected time; therefore actual useful authorized conversation can be less than300 seconds by setup/answer delay. This preserves existing conservative semantics and does not promise300 seconds measured from Retell start. No external carrier/provider cutoff was tested or changed. A lower Retell dashboard duration or any independent caller/provider termination may still end earlier.

## Snapshot mechanism and backwards compatibility

Optional bridgeDurationSeconds enum120/300 is stored in RetellCallRegistration when the call is first admitted. installSandbox chooses300 only for developmentEnabled===true, otherwise120. Duplicate observation does not overwrite it. The per-call budget copies that snapshot at claim. No duration is inferred from current configuration during reservation, callback, authorization or restart.

Missing historical snapshots mean120, without migrating or rewriting historical rows. Invalid snapshots fail closed. The budget reserves one absolute deadline once under CLAIMED/status/epoch/setup/snapshot predicates. Registration uses that exact deadline once under current ownership and unreserved bridge predicates. Both remain capped by the existing registration lease. Already reserved budgets/registrations cannot reserve again. Changing development mode before bridge reservation leaves the admitted duration unchanged; reopening repositories cannot extend deadlines. Older120-second calls and already expired proposals remain120/expired after deployment. Never try to revive the reported terminated call.

Only fields and helper logic are added: no new indexes, TTL, collections, environment variables, provider model/settings, tool schemas or retries. Existing RETELL_SANDBOX_DEVELOPMENT_ENABLED remains the selector; no adjustable duration setting is introduced. Stable run glo_retell_booking_dev_001 and fixed10 attempts remain; no counters/IDs/checkpoints are reset or replenished. Across ten attempts the new maximum is50 connected minutes, not a dollar cap. Booking idempotency/explicit confirmation, signature, tenant, pinned agent, screening, current ownership and persisted SMS suppression remain unchanged.

## Deployment and one controlled happy-path verification (not executed)

1. Review and separately commit the tested duration patch, preserving the existing diagnostics in shared SandboxHandoff. If those diagnostics remain uncommitted, include their intended dependent files in the reviewed commit set; exclude unrelated adapters and standalone lab/evaluation work. No commit or push was performed here.
2. Use the read-only command below first. Inspect both old proposals and exact command matches. BOOKED/PERSISTED or UNKNOWN/COMMITTING requires existing review/reconciliation before any replacement booking. A no-match read alone is not settled failure. Preserve all records and original deadlines.
3. Drain existing test calls before the separately authorized deployment to the existing Render backend service/branch. Deploy the reviewed commit, verify its build SHA (not merely the old base), and preserve current environment settings. No new provisioning/indexes or mobile build is required. Do not change Retell dashboard maximum duration or publish a different agent.
4. Confirm the existing sandbox/execution/development switches are explicitly true for the planned development test, booking is separately enabled, configured business is verified, agent/version matches the existing run, and glo_retell_booking_dev_001 has remaining attempts. Do not change its pinned version, create another run, or reset checkpoints. If exhausted, stop. Single-call mode correctly remains120sec. No activation/configuration was done here.
5. After separate live-effect authorization, make one call through the already working existing number/forwarding/mobile-fallback route. Use a known synthetic customer and one supported catalogue item at a verified future available slot. A new admission must record bridgeDurationSeconds300 in registration and derived per-call budget, equal bridgeExpiresAt, and return Dial timeLimit300. Human answer remains a bypass; no new number or mobile change.
6. Exercise the time correction, receive a new PREPARED summary, and explicitly confirm that current proposal within its60-second-or-shorter expiry. Old proposal must not commit. Expect one commit request, BOOKED only after one persisted appointment/command and notificationsSuppressed=true. Verify exact outcomes via existing read-only inspection; no SMS. No retries/new proposal may disguise UNKNOWN. Beyond120sec tools should remain authorized only while screened/current, before the call deadline. Do not deliberately consume another attempt merely to prove cutoff if happy-path evidence suffices.
7. Observe end-call settlement and remaining quota. Retain evidence of actual duration/termination; do not claim the original User_hangup cause or a guaranteed live fix from offline tests. Authorize any appointment cleanup separately.

Rollback: separately redeploy prior code or disable the existing experimental selector/drain through approved operations. No allowance reset/record rewrite is necessary. Stored deadlines never extend on restart/config changes; old calls are not upgraded. Prior code has a fixed120-second TwiML limit for new bridges and honors stored bridge expiry for authorized records, so drain active tests before rollback. Disabling a flag alone does not hang up an existing remote leg. Do not reset glo_retell_booking_dev_001 or consumed checkpoint records.

## Sanitized read-only Render correlation command

Supplied for manual execution only. Uses native read methods, no model initialization/index writes, inserts, commits, bookings, provider requests or secret printing. Customer names/contacts/transcript are excluded. Final NODE alone on its line. The deployed build SHA may differ after the separately reviewed patch is committed; verify the intended deployment SHA through the normal workflow.

```bash
node --input-type=module <<'NODE'
import mongoose from 'mongoose';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
let client;
try {
  let sha;try{sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{sha=process.env.RENDER_GIT_COMMIT;}
  console.log('build',JSON.stringify({sha:/^[a-f0-9]{40}$/.test(sha || '')?sha:'UNKNOWN',baseSha:'db5ab5bf3c9e5696e05c664c802ed6a3a3188603'}));
  if(!process.env.MONGO_URI)throw Error();
  client=new mongoose.mongo.MongoClient(process.env.MONGO_URI,{serverSelectionTimeoutMS:5000,socketTimeoutMS:15000});
  await client.connect();const db=client.db();
  const callId='call_08b97b9f5e820a8a58d576095e3';
  const ids=['d135b57d-fa5e-4e9a-9edc-2e6f99ce6a95','5cc6f87e-e435-4a8c-8ac2-cac4d1781d16'];
  const runId='glo_retell_booking_dev_001';
  const registration=await db.collection('retellcallregistrations').findOne({providerCallId:callId},{projection:{_id:1,businessId:1,agentId:1,agentVersion:1,ownerEpoch:1,revision:1,attemptId:1,status:1,providerCallId:1,observedCallId:1,expiresAt:1,bridgeRequired:1,bridgeDurationSeconds:1,bridgeReservedAt:1,bridgeScreenedAt:1,bridgeExpiresAt:1,bookingAllowed:1,bookingProposalId:1,createdAt:1,updatedAt:1}});
  console.log('registration',JSON.stringify(registration?{...registration,
    recordedDurationSeconds:registration.bridgeDurationSeconds ?? null,
    legacyEffectiveSeconds:registration.bridgeDurationSeconds===undefined?120:null
  }:{status:'ABSENT',callId}));
  const proposals=await db.collection('retellbookingproposals').find({_id:{$in:ids}},{projection:{_id:1,callId:1,parentCallSid:1,businessId:1,status:1,expiresAt:1,createdAt:1,updatedAt:1,factsHash:1,confirmedAt:1,confirmationFactsHash:1,appointmentId:1,'facts.date':1,'facts.time':1}}).toArray();
  for(const id of ids){
    const p=proposals.find(p=>p._id===id);
    console.log('proposal',JSON.stringify(p?{proposalId:p._id,callId:p.callId,matchesRecordedCall:p.callId===callId,parentCallSid:p.parentCallSid,status:p.status,
      requestedDate:p.facts?.date,requestedTime:p.facts?.time,createdAt:p.createdAt,updatedAt:p.updatedAt,expiresAt:p.expiresAt,
      expiryEqualsRegistrationBridgeDeadline:registration?.bridgeExpiresAt?+new Date(p.expiresAt)===+new Date(registration.bridgeExpiresAt):null,
      confirmedAt:p.confirmedAt ?? null,confirmationMatchesFacts:Boolean(p.confirmationFactsHash&&p.confirmationFactsHash===p.factsHash),appointmentId:p.appointmentId ?? null
    }:{proposalId:id,status:'ABSENT'}));
    const appointments=await db.collection('appointments').find({'bookingCommand.idempotencyKey':`retell:${id}`,...(p?{barberId:new mongoose.Types.ObjectId(p.businessId)}:{})},
      {projection:{_id:1,status:1,startAt:1,endAt:1,bookingCommand:1,notificationsSuppressed:1}}).limit(2).toArray();
    console.log('commandOutcome',JSON.stringify({proposalId:id,appointments,interpretation:appointments.length?'PERSISTED_MATCH_REQUIRES_STATUS_REVIEW':'NO_MATCH_OBSERVED_NOT_PROOF_OF_SETTLED_FAILURE'}));
  }
  const parents=[...new Set([...(registration?[registration._id]:[]),...proposals.filter(p=>p.callId===callId).map(p=>p.parentCallSid)])];
  const budgetIds=parents.map(parent=>'dev_'+createHash('sha256').update(JSON.stringify([runId,parent])).digest('hex'));
  const budgets=await db.collection('retellsandboxbudgets').find({$or:[{parentCallSid:{$in:parents}},{_id:{$in:budgetIds}}]},
    {projection:{_id:1,parentCallSid:1,businessId:1,ownerEpoch:1,status:1,setupExpiresAt:1,bridgeDurationSeconds:1,bridgeExpiresAt:1,registrationAttemptId:1,childCallSid:1,endedAt:1,createdAt:1,updatedAt:1}}).limit(10).toArray();
  console.log('budgets',JSON.stringify(budgets.map(b=>({...b,recordedDurationSeconds:b.bridgeDurationSeconds ?? null,legacyEffectiveSeconds:b.bridgeDurationSeconds===undefined?120:null,
    deadlineMatchesRegistration:registration?.bridgeExpiresAt?+new Date(b.bridgeExpiresAt)===+new Date(registration.bridgeExpiresAt):null}))));
  for(const id of budgetIds)if(!budgets.some(b=>b._id===id))console.log('derivedBudget',JSON.stringify({_id:id,status:'ABSENT'}));
  const run=await db.collection('retelldevelopmentruns').findOne({_id:runId},{projection:{businessId:1,agentId:1,agentVersion:1,limit:1,used:1,attempts:1}});
  console.log('run',JSON.stringify(run?{runId,businessId:run.businessId,agentId:run.agentId,agentVersion:run.agentVersion,limit:run.limit,used:run.used,
    remaining:Number.isInteger(run.used)&&run.used>=0&&run.used<=10?10-run.used:'UNKNOWN',
    thisCallReservations:(Array.isArray(run.attempts)?run.attempts:[]).filter(a=>parents.includes(a.parentCallSid)).map(a=>({parentCallSid:a.parentCallSid,ownerEpoch:a.ownerEpoch,attemptId:a.attemptId,reservedAt:a.reservedAt}))
  }:{runId,status:'ABSENT'}));
  console.log('inspection',JSON.stringify({readOnly:true,noCustomerNamesContactsOrTranscriptPrinted:true,noBudgetReset:true,remoteTerminationCause:'NOT_ESTABLISHED_BY_DATABASE_STATE'}));
}catch(error){console.error(JSON.stringify({event:'RETELL_DURATION_INSPECTION_FAILED',mongoCode:Number.isInteger(error?.code)?error.code:null}));process.exitCode=1;}
finally{if(client)await client.close().catch(()=>{});}
NODE
```

## Offline evidence

Tests use fake provider/telephony boundaries and the existing cached mongod in an isolated local replica set; production was not queried or written. New coverage includes300/120 TwiML and stored deadlines, authorization beyond120/equal300 denial,60-second proposal expiry during a long call, late proposal clipping, unchanged deadlines after repository reconstruction and mode changes before bridge, old records without snapshots, registration-lease cap, screening/ownership requirements and terminal late-event denial. Existing development tests now expect300 only in development cases; single-call expectations remain120. Full Retell/default routing/booking/transcript/diagnostic regressions are included. Final totals, inventory and hashes follow after validation.

## Final validation and exact inventory

429/429 affected tests pass in both worktree and clean-base combined overlay, zero fail/skip/cancel. Includes all Retell suites, retained diagnostic checks, booking/transcript/default routing/scheduling regressions and ten new duration cases. Twelve round JavaScript files (fourteen including retained diagnostics) and read-only command syntax pass; both diff checks and new-file whitespace pass. Real transactions/indexes were exercised only in isolated cached-Mongo test storage with fake providers. No production URI/credentials or provider/phone call was used.

Exact16-file round inventory (SandboxHandoff includes the preserved diagnostic changes already present at task start):

```text
docs/voice/RETELL_DEVELOPMENT_ALLOWANCE.md
docs/voice/RETELL_DEVELOPMENT_DURATION.md
docs/voice/RETELL_IMPLEMENTATION_TRACKER.md
docs/voice/RETELL_SANDBOX_CHECKPOINT.md
models/RetellCallRegistration.js
models/RetellSandboxBudget.js
services/voice/retell/CallRegistration.js
services/voice/retell/DevelopmentBudgetRepository.js
services/voice/retell/RegistrationRepository.js
services/voice/retell/SandboxBudgetRepository.js
services/voice/retell/SandboxCallDuration.js
services/voice/retell/SandboxHandoff.js
services/voice/retell/installSandbox.js
tests/services/retellActionsHarness.js
tests/services/retellCallDuration.test.js
tests/services/retellDevelopmentAllowance.test.js
```

The tested clean-base overlay has19 files: the16 above plus existing SandboxPhoneHooks.js, retellHandoffDiagnostics.test.js and RETELL_PRE_HANDOFF_DIAGNOSTICS.md, preserved unchanged. This distinguishes new duration work from prior uncommitted diagnostics; unrelated adapter/test and standalone engineering/lab/evaluation work are excluded. The three untouched diagnostic files and two unrelated adapter/test hashes match their task-start hashes. Existing Handoff diagnostics remain covered by15 passing checks.

Evidence: C:/Users/sanch/AppData/Local/Temp/retell-duration-20261103 (before.tap, duration-final.tap, affected-final.tap, overlay.tap, inventory.json, preserved-starting-hashes.json, hashes.json, checks.json, final-status.txt). Before-fix new duration test failed because300-second snapshots were absent. No test content changed after final full-suite validation; only result documentation did.
