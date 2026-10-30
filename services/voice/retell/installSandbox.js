import { createRetellRegistrationRepository } from './RegistrationRepository.js';
import { createRetellSandboxBudgetRepository } from './SandboxBudgetRepository.js';
import { createRetellCallRegistration } from './CallRegistration.js';
import { createRetellSandboxHandoff } from './SandboxHandoff.js';
import { mountRetellReadOnlyTools } from './mountReadOnlyTools.js';

// Not invoked by server.js. Future sandbox boot must explicitly inject secrets,
// provider and server-owned mapping. No production/environment activation switch.
export function installRetellSandbox(app, { enabled = false, executionEnabled = false, businessId, budgetId,
  provider, agentsByBusiness, twilioAuth, signingKey, models, RegistrationModel, BudgetModel,
  resolveBusiness, now = () => new Date() } = {}) {
  if (enabled !== true || executionEnabled !== true) return Object.freeze({ enabled: false });
  if (Object.keys(agentsByBusiness || {}).length !== 1 || !agentsByBusiness[businessId]) throw Error('SANDBOX_MAPPING_INVALID');
  if (typeof provider?.registerPhoneCall !== 'function') throw Error('SANDBOX_PROVIDER_REQUIRED');
  const repository = createRetellRegistrationRepository({ Model: RegistrationModel, now });
  const budgets = createRetellSandboxBudgetRepository({ Model: BudgetModel });
  // Fence the actual injectable provider boundary too, not just the HTTP loop.
  // A direct lifecycle call without this durable budget cannot dispatch.
  const guardedProvider = { async registerPhoneCall(payload, controls) {
    const budget = await budgets.find(budgetId);
    const row = budget && await repository.findByParentCallId(budget.parentCallSid);
    if (!row || row.businessId !== businessId || row.ownerEpoch !== budget.ownerEpoch || row.status !== 'REGISTERING'
      || row.attemptId !== payload.metadata?.glo_registration_attempt || row.agentId !== payload.agent_id || row.agentVersion !== payload.agent_version
      || !await budgets.consumeRegistration(budgetId, row._id, row.ownerEpoch, row.attemptId, now())) throw Error('SANDBOX_BUDGET_NOT_OWNED');
    const current = await repository.findByParentCallId(row._id);
    if (current?.ownerEpoch !== row.ownerEpoch || current.status !== 'REGISTERING' || +new Date(budget.setupExpiresAt) <= +now())
      throw Error('SANDBOX_OWNER_EXPIRED');
    return provider.registerPhoneCall(payload, controls);
  } };
  const lifecycle = createRetellCallRegistration({ enabled: true, repository, provider: guardedProvider, agentsByBusiness,
    twilio: twilioAuth, resolveBusiness, now, requireBridge: true });
  const handoff = createRetellSandboxHandoff({ enabled: true, executionEnabled: true, businessId, budgetId,
    repository, budgets, lifecycle, twilioAuth, resolveBusiness, now });
  const mounted = mountRetellReadOnlyTools(app, { config: { enabled: true, signingKey, allowedBusinessIds: [businessId] },
    registration: { repository, lifecycle }, models, now });
  if (!mounted.enabled) throw Error('SANDBOX_READ_CONFIGURATION_INVALID');
  app.locals.retellSandbox = handoff;
  return Object.freeze({ enabled: true, repository, budgets, lifecycle, handoff });
}
