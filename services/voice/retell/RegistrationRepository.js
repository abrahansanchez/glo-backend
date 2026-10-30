import RetellCallRegistration from '../../../models/RetellCallRegistration.js';

// Atomic database predicates, not a process-local ownership lock. Model injection
// permits offline tests; the production default performs no I/O until invoked.
export function createRetellRegistrationRepository({ Model = RetellCallRegistration, now = () => new Date() } = {}) {
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
    async observe(row) {
      await ensureReady();
      try { return (await Model.create(row)).toObject(); }
      catch (error) { if (error?.code !== 11000) throw error; return find({ _id: row._id }); }
    },
    findByParentCallId: id => find({ _id: id }),
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
    async findByProviderCallId(callId) {
      const row = await find({ providerCallId: callId, status: 'ACTIVE', expiresAt: { $gt: now() } });
      if (!row) return null;
      return { provider: 'retell', mode: 'READ_ONLY', status: 'ACTIVE', callId: row.providerCallId,
        parentCallSid: row._id, businessId: row.businessId, agentId: row.agentId, agentVersion: row.agentVersion,
        language: row.language, revision: row.revision, expiresAt: row.expiresAt };
    },
  });
}
