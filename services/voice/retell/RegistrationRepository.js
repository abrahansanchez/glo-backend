import RetellCallRegistration from '../../../models/RetellCallRegistration.js';
import { bridgeDurationSeconds, bridgeDeadline } from './SandboxCallDuration.js';

// Atomic database predicates, not a process-local ownership lock. Model injection
// permits offline tests; the production default performs no I/O until invoked.
export function createRetellRegistrationRepository({ Model = RetellCallRegistration, canary, now = () => new Date() } = {}) {
  let ready;
  // Do not rely on deployment autoIndex defaults for ownership uniqueness.
  // Any failure leaves registration/tools closed; no query runs first.
  const ensureReady = () => (ready ??= Promise.resolve().then(async () => {
    await Model.init();
    await Model.createIndexes();
  }));
  const update = async (filter, values) => {
    await ensureReady();
    return Model.findOneAndUpdate(filter, { $set: values, $inc: { revision: 1 } }, { new: true, runValidators: true }).lean();
  };
  const find = async filter => { await ensureReady(); return Model.findOne(filter).lean(); };
  return Object.freeze({
    Model,
    async observe(row) {
      await ensureReady();
      try { return (await Model.create(row)).toObject(); }
      catch (error) { if (error?.code !== 11000) throw error; return find({ _id: row._id }); }
    },
    findByParentCallId: id => find({ _id: id }),
    reserveBridge: (row, at, deadline) => update({ _id: row._id, ownerEpoch: row.ownerEpoch, providerCallId: row.providerCallId,
      bridgeRequired: true, bridgeReservedAt: { $exists: false }, status: { $in: ['REGISTERED', 'ACTIVE'] },
      bridgeDurationSeconds: row.bridgeDurationSeconds === undefined ? { $exists: false } : bridgeDurationSeconds(row),
      expiresAt: { $gt: at } }, { bridgeReservedAt: at,
        bridgeExpiresAt: bridgeDeadline(row, at, deadline === undefined ? row.expiresAt : new Date(Math.min(+new Date(deadline), +new Date(row.expiresAt)))) }),
    screenBridge: (row, at) => update({ _id: row._id, ownerEpoch: row.ownerEpoch, providerCallId: row.providerCallId,
      bridgeRequired: true, bridgeReservedAt: { $exists: true }, bridgeExpiresAt: { $gt: at },
      status: { $in: ['REGISTERED', 'ACTIVE'] }, expiresAt: { $gt: at } }, { bridgeScreenedAt: at }),
    claim: (id, epoch, now) => update({ _id: id, ownerEpoch: epoch, status: 'OBSERVED', expiresAt: { $gt: now } }, { status: 'REGISTERING' }),
    async bind(row, callId, now) {
      // A callback may race the registration response. Only this exact attempt
      // may bind it, and an early terminal callback wins permanently.
      for (const [status, next] of [['REGISTERING', 'REGISTERED'], ['START_OBSERVED', 'ACTIVE']]) {
        const result = await update({ _id: row._id, attemptId: row.attemptId, ownerEpoch: row.ownerEpoch,
          status, expiresAt: { $gt: now }, $or: [{ observedCallId: { $exists: false } }, { observedCallId: callId }] },
        { providerCallId: callId, status: next });
        if (result) return result;
      }
      return null;
    },
    fail: (row, status) => update({ _id: row._id, attemptId: row.attemptId, ownerEpoch: row.ownerEpoch,
      status: { $in: ['REGISTERING', 'START_OBSERVED'] } }, { status }),
    supersede: (id, epoch) => update({ _id: id, ownerEpoch: epoch, status: { $nin: ['ENDED', 'SUPERSEDED'] } },
      { status: 'SUPERSEDED', ownerEpoch: epoch + 1 }),
    async event({ attemptId, callId, agentId, agentVersion, ended }, now) {
      const identity = { ...(attemptId ? { attemptId } : { providerCallId: callId }), agentId,
        ...(agentVersion === undefined ? {} : { agentVersion }), expiresAt: { $gt: now },
        $and: [
          { $or: [{ providerCallId: { $exists: false } }, { providerCallId: callId }] },
          { $or: [{ observedCallId: { $exists: false } }, { observedCallId: callId }] },
        ] };
      if (ended) return update({ ...identity, status: { $in: ['REGISTERING', 'START_OBSERVED', 'REGISTERED', 'ACTIVE', 'UNKNOWN'] } },
        { status: 'ENDED', observedCallId: callId });
      const bound = await update({ ...identity, status: 'REGISTERED', providerCallId: callId }, { status: 'ACTIVE', observedCallId: callId });
      if (bound) return bound;
      return update({ ...identity, status: 'REGISTERING' }, { status: 'START_OBSERVED', observedCallId: callId });
    },
    async fenceNotificationConsent(binding,session){
      const admission=await canary.assert(binding.businessId,'NOTIFICATIONS',{expectedRevision:binding.phaseAdmissionRevision??-1,session,fence:true});binding.expiresAt=new Date(Math.min(+new Date(binding.expiresAt),+new Date(admission.expiresAt)));
      const at=now(),result=await Model.updateOne({_id:binding.parentCallSid,businessId:binding.businessId,providerCallId:binding.callId,agentId:binding.agentId,agentVersion:binding.agentVersion,ownerEpoch:binding.ownerEpoch,status:'ACTIVE',notificationConsentAllowed:true,expiresAt:{$gt:at},$or:[{bridgeRequired:{$ne:true}},{bridgeRequired:true,bridgeScreenedAt:{$exists:true},bridgeReservedAt:{$exists:true},bridgeExpiresAt:{$gt:at}}]},{$inc:{bookingFence:1}},{session});if(result.matchedCount!==1)throw Object.assign(Error('NOTIFICATIONS_NOT_ALLOWED'),{reasonCode:'NOTIFICATIONS_NOT_ALLOWED'});
    },
    async reserveManagementRequest(binding, capability) {
      await canary.assert(binding.businessId,'MANAGEMENT',{expectedRevision:binding.phaseAdmissionRevision??-1});
      const at=now();
      const result=await Model.updateOne({_id:binding.parentCallSid,providerCallId:binding.callId,businessId:binding.businessId,ownerEpoch:binding.ownerEpoch,agentId:binding.agentId,agentVersion:binding.agentVersion,status:'ACTIVE',managementCapabilities:capability,expiresAt:{$gt:at},$and:[{$or:[{managementRequestCount:{$exists:false}},{managementRequestCount:{$lt:40}}]},{$or:[{bridgeRequired:{$ne:true}},{bridgeRequired:true,bridgeReservedAt:{$exists:true},bridgeScreenedAt:{$exists:true},bridgeExpiresAt:{$gt:at}}]}]},{$inc:{managementRequestCount:1}});
      if(result.matchedCount!==1)throw Object.assign(Error('MANAGEMENT_LIMIT_OR_AUTHORIZATION'),{reasonCode:'MANAGEMENT_LIMIT_OR_AUTHORIZATION'});
    },
    async fenceManagement(binding, capability, session) {
        const admission=await canary.assert(binding.businessId,'MANAGEMENT',{expectedRevision:binding.phaseAdmissionRevision??-1,session,fence:true});binding.expiresAt=new Date(Math.min(+new Date(binding.expiresAt),+new Date(admission.expiresAt)));
      if(!session||!['DELEGATE','VERIFY','LOOKUP','CANCEL','RESCHEDULE'].includes(capability))throw Error('MANAGEMENT_NOT_AUTHORIZED');
      const at=now();
      const filter={_id:binding.parentCallSid,businessId:binding.businessId,providerCallId:binding.callId,agentId:binding.agentId,agentVersion:binding.agentVersion,ownerEpoch:binding.ownerEpoch,status:'ACTIVE',managementCapabilities:capability,expiresAt:{$gt:at}};
      // Both unbridged fixtures and screened real phone registrations are supported.
      filter.$or=[{bridgeRequired:{$ne:true}},{bridgeRequired:true,bridgeReservedAt:{$exists:true},bridgeScreenedAt:{$exists:true},bridgeExpiresAt:{$gt:at}}];
      const result=await Model.updateOne(filter,{$inc:{bookingFence:1}},{session});
      if(result.matchedCount!==1)throw Object.assign(Error('CALL_NOT_AUTHORIZED'),{reasonCode:'CALL_NOT_AUTHORIZED'});
    },
    async findByProviderCallId(callId) {
      const row = await find({ providerCallId: callId, status: 'ACTIVE', expiresAt: { $gt: now() } });
      if (!row) return null;
      // Sandbox-only conservative window starts at bridge reservation, not at a
      // potentially delayed callback. No timer/TTL/callback can extend it.
      if (row.bridgeRequired && (!row.bridgeReservedAt || !row.bridgeScreenedAt || !(+new Date(row.bridgeExpiresAt) > +now()))) return null;
      return { provider: 'retell', mode: 'READ_ONLY', status: 'ACTIVE', callId: row.providerCallId,
        parentCallSid: row._id, businessId: row.businessId, agentId: row.agentId, agentVersion: row.agentVersion,
        phaseAdmissionRevision:row.phaseAdmissionRevision,language: row.language, revision: row.revision, ownerEpoch:row.ownerEpoch, managementCapabilities:row.managementCapabilities || [],
        expiresAt: row.bridgeRequired ? new Date(Math.min(+new Date(row.expiresAt), +new Date(row.bridgeExpiresAt))) : row.expiresAt,
        bookingAllowed: row.bookingAllowed === true,notificationConsentAllowed:row.notificationConsentAllowed===true, trustedCallerNumber: row.trustedCallerNumber };
    },
  });
}
