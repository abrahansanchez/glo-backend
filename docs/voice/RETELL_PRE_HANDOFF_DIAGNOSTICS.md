# Retell pre-handoff hangup diagnosis - 2026-11-03

Deployed and starting local HEAD db5ab5bf3c9e5696e05c664c802ed6a3a3188603, branch experiment/voice-v2-realtime-conversation-lab. Target parent CAbb004e7ccac49746dae848c080e7abcb only. No live database query, database writes, credentials, provider requests, calls, budget resets or deployment. Backend diagnostics only; no routing/configuration/authority change.

## Evidence and limits

Screenshots/operator evidence: incoming webhook 2026-11-03 01:06:18 UTC returned Dial Client business69d6b84155368d54a594b55a, timeout12. Mobile child CAe3a3675b58326939619cc0b24857e4dd No Answer. Parent dial-fallback01:06:35 returned HTTP200 with only Response/Hangup; no SIP child listed. The warning32021 is separate observed evidence; it did not prevent incoming webhook/mobile dialing and is not established as the backend Hangup cause. Screenshot response bodies do not expose callback DialCallStatus, To, Called, request URL/signature or persisted ownership. A child No Answer is not a recording of the exact parent action parameters.

The 17-second interval includes mobile ringing and routing; no Retell/TTS interval is demonstrated. Provisioning a collection is not activation, a run reservation, boot-composition proof or a provider registration. Pinned version1 and run glo_retell_booking_dev_001 are intended settings, not verified deployed values.

## Every relevant deployed branch

SandboxHandoff.fallback re-resolves body.To, then verifies selection/signature. Auth failure403 bareHangup; invalid parent400 bareHangup; these do not match reported200. Completed DialCallStatus retires ownership and returns200 bareHangup. A budget claim returningnull also returns200 bareHangup: duplicate/per-call claim or a consumed original single-call budget if development is actually off. Null does not prove exhaustion. Invalid dial status/missing observation/wrong business/non-OBSERVED/not bridge-required/expired observation return200 Say+Hangup, not the recorded complete bare body. Registration, binding, budget-reservation, bridge-reservation, final ownership or rendering exceptions return200 Say+Hangup. Exhausted development allowance and incompatible development scope throw into that Say+Hangup path. Success returns Dial/Sip followed by Hangup, not bareHangup. Screen/status/complete callbacks have their own guards but are different endpoints and cannot alone identify this dial-fallback response.

If the sandbox is missing/disabled or business re-resolution is not selected, SandboxPhoneHooks returnsfalse and the existing controller continues. Its completed status (case-normalized) branch returns200 bareHangup. Otherwise it returns unassigned-number Say, AI Connect/Stream, or error Say; a hook exception returns503 bareHangup. Relevant routing middleware does not turn403 into200. Therefore200 bareHangup narrows to completed status in either owner or unacquired budget claim; the supplied evidence cannot choose one. Need exact parent action request parameters, matching Render logs and read-only persisted inspection. Later state cannot reconstruct a missing historical snapshot.

## Development budget independence

When development is enabled, installSandbox wraps single-use budgets. DevelopmentBudgetRepository ignores the legacy ID for claim/find/consume/reserve/end and derives dev_SHA256(JSON([runId,parent])). The guard resolves the server-owned registration attempt before using that per-call budget. Legacy BUDGET_ID still must have valid syntax at startup, but its consumed record is not a development allowance prerequisite. No demonstrated incorrect dependency was found. A fake-store full handoff with consumed glo_retell_booking_checkpoint_002 and pinned version1 obtains SIP using one new run reservation and a derived budget; the old row is byte-for-byte unchanged and never read. Current-generation database-backed development tests from the committed prior round are source evidence; they were not rerun here because this task prohibits database writes.

## Forwarded/shared-number path

Existing incoming controller resolves Called || To using findBarberByInboundNumber and dials that business. Retell separately enforces the signed incoming request, requires Called absent or equalTo, then resolves To and its allowlist. No forwarded-number inference or model tenant selection is used. At fallback it resolves To again. Canonical inboundRoutingNumber wins; otherwise legacy twilioNumber/assignedTwilioNumber/twilioPhoneNumber matches use newest updatedAt then createdAt. The existing resolver does not reject duplicate legacy records: a shared mapping can select a different current candidate after record changes. Incoming DialClient proves only the legacy selected business then; it does not prove a Retell OBSERVED record or later resolver selection. Actual To/Called/ForwardedFrom values are not recoverable from the SIP warning's original signaling variables alone. Do not use a personal/forwarding number as authoritative business identity or pick an ambiguous business by guessing.

No number record, resolver, signature check, selector, allowance, callback ownership or call budget has been changed. A Called/To mismatch is synthetically reproduced as rejected, not assumed to have occurred live. A nonselected fallback is also reproduced as existing default continuation, not identified as this call's cause.

## Minimal diagnostics added

SandboxHandoff emits RETELL_SANDBOX_HANDOFF with validated CallSid, stage, allowlisted reasonCode, and owned boolean/status fields. Observation logs distinguish CALL_OBSERVED, UNTRUSTED_INCOMING_CALL, BUSINESS_NOT_ALLOWED, CALL_ALREADY_OWNED, REGISTRATION_UNAVAILABLE; To/Called presence/equality only, never values. Fallback logs distinguish MOBILE_DIAL_COMPLETED, BUDGET_CLAIM_NOT_ACQUIRED, auth/identity/observation failures, scope/exhaustion, opaque failing stage and SIP_BRIDGE_RETURNED. SandboxPhoneHooks records SANDBOX_NOT_INSTALLED and swallowed observation/hook exceptions. Existing controller already logs its completed-status Hangup. Arbitrary errors/messages, signatures, headers, caller numbers/transcripts, business names/lists and raw bodies are not added to diagnostics. Logging exceptions cannot change the response. This instrumentation cannot recover missing historical values from the completed call.

## Read-only Render command (supplied, never executed)

Run from deployed Render Bash. Configuration results describe this shell's current environment, not proof of the running app's private composition or the historical environment at01:06:35. Secret configuration is deliberately not inspected. Native reads only: no model init/index creation/documents/callbacks/provider calls. Call record projections exclude caller/contact/transcript fields. Current map counts/candidates are not historical routing proof. Actual consumed ID is glo_retell_booking_checkpoint_002.

```bash
node --input-type=module <<'NODE'
import mongoose from 'mongoose';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
let client;
try {
  const expectedSha='db5ab5bf3c9e5696e05c664c802ed6a3a3188603';
  let sha;try{sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{sha=process.env.RENDER_GIT_COMMIT;}
  const shownSha=/^[a-f0-9]{40}$/.test(sha || '')?sha:'UNKNOWN';
  const handle=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v)?v:'ABSENT_OR_INVALID';
  const flag=k=>['true','false'].includes(process.env[k])?process.env[k]:'ABSENT_OR_INVALID';
  const businessId=/^[a-f0-9]{24}$/.test(process.env.RETELL_SANDBOX_BUSINESS_ID || '')?process.env.RETELL_SANDBOX_BUSINESS_ID:null;
  const agentId=process.env.RETELL_SANDBOX_AGENT_ID || 'agent_1da974cf19d41a0b0e64b012d5';
  const version=process.env.RETELL_SANDBOX_AGENT_VERSION;
  const agentVersion=/^(0|[1-9]\d*)$/.test(version || '')&&Number.isSafeInteger(Number(version))?Number(version):null;
  const runId=process.env.RETELL_SANDBOX_TEST_RUN_ID;
  const budgetId=process.env.RETELL_SANDBOX_BUDGET_ID;
  const validId=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{8,80}$/.test(v);
  let origin='ABSENT_OR_INVALID';
  try{const u=new URL(process.env.APP_BASE_URL);if(u.protocol==='https:'&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash)origin=u.origin;}catch{}
  const sid='CAbb004e7ccac49746dae848c080e7abcb';
  const callbackAt=new Date('2026-11-03T01:06:35Z');
  const intendedRun='glo_retell_booking_dev_001';
  const development=process.env.RETELL_SANDBOX_DEVELOPMENT_ENABLED==='true';
  console.log('configuration',JSON.stringify({observedAt:new Date().toISOString(),sha:shownSha,expectedSha,shaMatches:shownSha===expectedSha,
    flags:Object.fromEntries(['RETELL_SANDBOX_ENABLED','RETELL_SANDBOX_EXECUTION_ENABLED','RETELL_SANDBOX_DEVELOPMENT_ENABLED','RETELL_BOOKING_ENABLED','RETELL_TRANSCRIPTS_ENABLED'].map(k=>[k,flag(k)])),
    businessId,agentId:handle(agentId),agentVersion,intendedAgentVersion:1,agentVersionMatchesIntended:agentVersion===1,
    configuredRun:handle(runId),intendedRun,configuredBudget:handle(budgetId),origin,
    selectedBudgetMode:development?'DEVELOPMENT':'SINGLE_CALL',configuredLimit:development?10:1,
    secretConfigurationNotInspected:true,configurationIsNotProofOfBootInstallation:true}));
  if(!process.env.MONGO_URI)throw Error();
  client=new mongoose.mongo.MongoClient(process.env.MONGO_URI,{serverSelectionTimeoutMS:5000,socketTimeoutMS:15000});
  await client.connect();const db=client.db();
  const registration=await db.collection('retellcallregistrations').findOne({_id:sid},{projection:{_id:1,businessId:1,agentId:1,agentVersion:1,language:1,ownerEpoch:1,revision:1,attemptId:1,status:1,providerCallId:1,observedCallId:1,expiresAt:1,bridgeRequired:1,bridgeReservedAt:1,bridgeScreenedAt:1,bridgeExpiresAt:1,bookingAllowed:1,createdAt:1,updatedAt:1}});
  console.log('registration',JSON.stringify(registration?{...registration,
    matchesConfiguredBusiness:registration.businessId===businessId,matchesConfiguredAgent:registration.agentId===agentId&&registration.agentVersion===agentVersion,
    expiryAfterRecordedCallback:+new Date(registration.expiresAt)>+callbackAt,
    bridgeExpiryAfterRecordedCallback:registration.bridgeExpiresAt?+new Date(registration.bridgeExpiresAt)>+callbackAt:null,
    currentRowNotHistoricalSnapshot:true}:{status:'ABSENT',parentCallSid:sid}));
  const runIds=[...new Set([intendedRun,...(validId(runId)?[runId]:[])])];
  const runs=await db.collection('retelldevelopmentruns').find({$or:[{_id:{$in:runIds}},{'attempts.parentCallSid':sid}]}).limit(10).toArray();
  for(const id of runIds)if(!runs.some(r=>r._id===id))console.log('developmentRun',JSON.stringify({runId:id,status:'ABSENT',configuredLimit:10,used:0,remaining:10}));
  for(const run of runs){
    const valid=Number.isInteger(run.used)&&run.used>=0&&run.used<=10&&Array.isArray(run.attempts)&&run.attempts.length===run.used&&new Set(run.attempts.map(a=>a.parentCallSid)).size===run.used;
    const scopeMatches=run.businessId===businessId&&run.agentId===agentId&&run.agentVersion===agentVersion&&run.limit===10;
    console.log('developmentRun',JSON.stringify({runId:run._id,businessId:run.businessId,agentId:run.agentId,agentVersion:run.agentVersion,storedLimit:run.limit,configuredLimit:10,used:valid?run.used:'INVALID',remaining:valid?10-run.used:'UNKNOWN',scopeMatches,countStructureValid:valid,
      thisCallReservations:(run.attempts || []).filter(a=>a.parentCallSid===sid).map(a=>({parentCallSid:a.parentCallSid,ownerEpoch:a.ownerEpoch,attemptId:a.attemptId,reservedAt:a.reservedAt,
        matchesCurrentRegistrationAttempt:a.attemptId===registration?.attemptId,matchesCurrentRegistrationEpoch:a.ownerEpoch===registration?.ownerEpoch}))}));
  }
  const derive=id=>'dev_'+createHash('sha256').update(JSON.stringify([id,sid])).digest('hex');
  const ids=[...new Set(['glo_retell_booking_checkpoint_002',...(validId(budgetId)?[budgetId]:[]),...runIds.map(derive)])];
  const budgets=await db.collection('retellsandboxbudgets').find({$or:[{_id:{$in:ids}},{parentCallSid:sid}]},{projection:{_id:1,businessId:1,parentCallSid:1,ownerEpoch:1,status:1,setupExpiresAt:1,bridgeExpiresAt:1,registrationAttemptId:1,childCallSid:1,endedAt:1,createdAt:1,updatedAt:1}}).limit(20).toArray();
  for(const id of ids)if(!budgets.some(b=>b._id===id))console.log('budget',JSON.stringify({_id:id,status:'ABSENT'}));
  for(const b of budgets)console.log('budget',JSON.stringify({...b,belongsToThisParent:b.parentCallSid===sid,matchesCurrentRegistrationEpoch:b.ownerEpoch===registration?.ownerEpoch,matchesCurrentRegistrationAttempt:b.registrationAttemptId===registration?.attemptId}));
  const businesses=db.collection('barbers');
  if(businessId){
    const b=await businesses.findOne({_id:new mongoose.Types.ObjectId(businessId)},{projection:{_id:1,inboundRoutingNumber:1,twilioNumber:1,assignedTwilioNumber:1,twilioPhoneNumber:1}});
    console.log('configuredBusinessRouting',JSON.stringify(b || {status:'BUSINESS_NOT_FOUND'}));
  }
  for(const number of ['+18132952433','+18132207636','+12602523232']){
    const canonicalFilter={inboundRoutingNumber:number},legacyFilter={$or:[{twilioNumber:number},{assignedTwilioNumber:number},{twilioPhoneNumber:number}]};
    const canonical=await businesses.find(canonicalFilter,{projection:{_id:1}}).limit(25).toArray();
    const legacy=await businesses.find(legacyFilter,{projection:{_id:1}}).sort({updatedAt:-1,createdAt:-1}).limit(25).toArray();
    const canonicalCount=await businesses.countDocuments(canonicalFilter),legacyCount=await businesses.countDocuments(legacyFilter);
    const selected=canonical[0] || legacy[0];
    console.log('currentRoutingCandidates',JSON.stringify({number,canonicalCount,legacyCount,canonicalBusinessIds:canonical.map(r=>String(r._id)),legacyBusinessIds:legacy.map(r=>String(r._id)),
      ambiguous:canonicalCount>1||(!canonicalCount&&legacyCount>1),source:canonical.length?'canonical':legacy.length?'legacy':'none',
      observedResolverCandidate:selected?String(selected._id):null,matchesConfiguredBusiness:selected?String(selected._id)===businessId:false,currentStateNotHistorical:true}));
  }
  console.log('limitations',JSON.stringify({webhookRequestBodiesNotPersistedHere:true,activeCallStore:'PROCESS_LOCAL_NOT_QUERYABLE_FROM_THIS_SHELL',callLog:'NO_CALLSID_FIELD_FOR_EXACT_PARENT_LOOKUP',noSecretsPrinted:true,noWritesPerformed:true}));
}catch(error){console.error(JSON.stringify({event:'RETELL_PRE_HANDOFF_INSPECTION_FAILED',mongoCode:Number.isInteger(error?.code)?error.code:null}));process.exitCode=1;}
finally{if(client)await client.close().catch(()=>{});}
NODE
```

## Offline tests and inventory

New tests use in-memory fake repositories/providers and synthetic signed Twilio requests; no Mongo connection or database writes. Existing registration/transport/read-tools/composition/scheduling-compatibility regressions use fakes as well. Focused new checks cover matching/nonmatching TwiML branches, authentication, invalid ownership, explicit bare-claim refusal, current routing nonselection, failure stages/secret exclusion, consumed-budget independence, forwarded Called/To withholding and hook failures. Totals and final hash evidence follow after validation.

Task files:

```text
services/voice/retell/SandboxHandoff.js
services/voice/retell/SandboxPhoneHooks.js
tests/services/retellHandoffDiagnostics.test.js
docs/voice/RETELL_PRE_HANDOFF_DIAGNOSTICS.md
```

Next necessary step: inspect the read-only command output plus the existing incoming/fallback Request Inspector bodies (redact From/signature/customer data): CallSid, DialCallStatus, To, Called, ForwardedFrom presence, exact webhook URL and matching startup/observation/budget logs. Do not replay webhooks, reset budgets or request another call merely to obtain missing branch evidence. No behavior repair beyond observability is justified by the supplied evidence.

Validation complete: 15/15 new diagnostic cases pass; 137/137 affected fake-only tests pass in both worktree and exact four-file clean db5ab5b overlay, zero fail/skip/cancel. Three changed JavaScript syntax checks, inspection-command syntax, both diff checks and new-file whitespace pass. No Mongo-backed tests were run in this task. External evidence: C:/Users/sanch/AppData/Local/Temp/retell-prehangup-diagnostics-20261103 (affected.tap, overlay.tap, inventory.json, hashes.json, checks.json). All task changes remain unstaged/uncommitted; unrelated adapter/test hashes preserved.
