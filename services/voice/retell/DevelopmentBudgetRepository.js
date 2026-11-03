import { createHash } from 'node:crypto';
import Run from '../../../models/RetellDevelopmentRun.js';

export const DEVELOPMENT_ATTEMPT_LIMIT = 10;
export const developmentBudgetId = (runId, parent) => `dev_${createHash('sha256').update(JSON.stringify([runId, parent])).digest('hex')}`;
const failure = safeReason => Object.assign(Error(safeReason), { safeReason });

// Wrap the unchanged single-use per-call budget. A run reservation is permanent,
// even if storage/provider work subsequently fails or its outcome is uncertain.
export function createRetellDevelopmentBudgetRepository({ budgets, Model = Run, runId, businessId, agentId, agentVersion,
  now = () => new Date(), audit = event => console.info('RETELL_SANDBOX_ALLOWANCE', event) }) {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(runId || '') || /^glo_retell_checkpoint_00[12]$/.test(runId)
    || !/^[a-f\d]{24}$/.test(businessId || '') || !/^agent_[A-Za-z0-9_-]{1,100}$/.test(agentId || '')
    || !Number.isSafeInteger(agentVersion) || agentVersion < 0) throw failure('DEVELOPMENT_CONFIGURATION_INVALID');
  const identity = { _id: runId, businessId, agentId, agentVersion, limit: DEVELOPMENT_ATTEMPT_LIMIT };
  let ready;
  const init = () => ready ??= Promise.resolve().then(async () => { await Model.init(); await Model.createIndexes(); });
  const matches = row => row && Object.entries(identity).every(([k,v]) => row[k] === v)
    && Number.isInteger(row.used) && row.used >= 0 && row.used <= 10 && Array.isArray(row.attempts)
    && row.attempts.length === row.used && new Set(row.attempts.map(a => a.parentCallSid)).size === row.used;
  const read = async () => { await init(); const row = await Model.findById(runId).lean(); if (row && !matches(row)) throw failure('DEVELOPMENT_RUN_SCOPE_CONFLICT'); return row; };
  const budgetId = parent => developmentBudgetId(runId, parent);
  const emit = reasonCode => {
    try { audit({ event: 'RETELL_DEVELOPMENT_ALLOWANCE', reasonCode, limit: DEVELOPMENT_ATTEMPT_LIMIT,
      ...(reasonCode === 'DEVELOPMENT_ALLOWANCE_EXHAUSTED' ? { used: 10, remaining: 0 } : {}) }); } catch {}
  };
  return Object.freeze({
    async claim(row, { attemptId } = {}) {
      if (row.businessId !== businessId || !/^CA[a-f\d]{32}$/.test(row.parentCallSid || '')
        || !Number.isSafeInteger(row.ownerEpoch) || row.ownerEpoch < 1 || !/^[a-f\d-]{36}$/.test(attemptId || ''))
        throw failure('DEVELOPMENT_CALL_SCOPE_CONFLICT');
      await init();
      try { await Model.create({ ...identity, used: 0, attempts: [] }); }
      catch (e) { if (e?.code !== 11000) throw e; }
      let run = await read();
      let existing = run.attempts.find(a => a.parentCallSid === row.parentCallSid);
      if (!existing) {
        const reserved = await Model.findOneAndUpdate({ ...identity, used: { $lt: DEVELOPMENT_ATTEMPT_LIMIT },
          'attempts.parentCallSid': { $ne: row.parentCallSid } }, {
          $inc: { used: 1 }, $push: { attempts: { parentCallSid: row.parentCallSid, ownerEpoch: row.ownerEpoch, attemptId, reservedAt: now() } },
        }, { new: true, runValidators: true, writeConcern: { w: 'majority' } }).lean();
        run = reserved || await read();
        existing = run.attempts.find(a => a.parentCallSid === row.parentCallSid);
        if (!existing) { emit('DEVELOPMENT_ALLOWANCE_EXHAUSTED'); throw failure('DEVELOPMENT_ALLOWANCE_EXHAUSTED'); }
      }
      if (existing.ownerEpoch !== row.ownerEpoch || existing.attemptId !== attemptId) throw failure('DEVELOPMENT_CALL_SCOPE_CONFLICT');
      return budgets.claim({ ...row, _id: budgetId(row.parentCallSid) });
    },
    async find(_id, parent) {
      const run = await read(), attempt = run?.attempts.find(a => a.parentCallSid === parent);
      if (!attempt) return null;
      const row = await budgets.find(budgetId(parent));
      return row && row.businessId === businessId && row.ownerEpoch === attempt.ownerEpoch
        && (!row.registrationAttemptId || row.registrationAttemptId === attempt.attemptId) ? row : null;
    },
    consumeRegistration: (_id, parent, epoch, attemptId, time) => budgets.consumeRegistration(budgetId(parent), parent, epoch, attemptId, time),
    reserve: (_id, parent, epoch, time, authorizationExpiresAt) => budgets.reserve(budgetId(parent), parent, epoch, time, authorizationExpiresAt),
    screen: (_id, parent, epoch, child, time) => budgets.screen(budgetId(parent), parent, epoch, child, time),
    end: (_id, parent, time) => budgets.end(budgetId(parent), parent, time),
    async usage() {
      const run = await read(), used = run?.used || 0;
      return { limit: DEVELOPMENT_ATTEMPT_LIMIT, used, remaining: DEVELOPMENT_ATTEMPT_LIMIT - used, status: run ? used >= 10 ? 'EXHAUSTED' : 'AVAILABLE' : 'ABSENT' };
    },
  });
}
