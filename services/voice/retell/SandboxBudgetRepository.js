import Budget from '../../../models/RetellSandboxBudget.js';

export function createRetellSandboxBudgetRepository({ Model = Budget } = {}) {
  let ready;
  const init = () => (ready ??= Promise.resolve().then(async () => { await Model.init(); await Model.createIndexes(); }));
  const update = async (filter, values) => {
    await init(); return Model.findOneAndUpdate(filter, { $set: values }, { new: true, runValidators: true }).lean();
  };
  return Object.freeze({
    async claim(row) {
      await init();
      try { return (await Model.create(row)).toObject(); }
      catch (e) { if (e?.code === 11000) return null; throw e; }
    },
    async find(id) { await init(); return Model.findById(id).lean(); },
    consumeRegistration: (id, parentCallSid, ownerEpoch, attemptId, now) => update({ _id: id, parentCallSid, ownerEpoch,
      status: 'CLAIMED', setupExpiresAt: { $gt: now }, registrationAttemptId: { $exists: false } }, { registrationAttemptId: attemptId }),
    reserve: (id, parentCallSid, ownerEpoch, now) => update({ _id: id, parentCallSid, ownerEpoch,
      status: 'CLAIMED', registrationAttemptId: { $exists: true }, setupExpiresAt: { $gt: now } },
    { status: 'BRIDGE_RESERVED', bridgeExpiresAt: new Date(+now + 120000) }),
    screen: (id, parentCallSid, ownerEpoch, childCallSid, now) => update({ _id: id, parentCallSid, ownerEpoch,
      status: 'BRIDGE_RESERVED', setupExpiresAt: { $gt: now }, bridgeExpiresAt: { $gt: now },
      $or: [{ childCallSid: { $exists: false } }, { childCallSid }] }, { childCallSid }),
    end: (id, parentCallSid, now) => update({ _id: id, parentCallSid, status: { $ne: 'ENDED' } }, { status: 'ENDED', endedAt: now }),
  });
}
