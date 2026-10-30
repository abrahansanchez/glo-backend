import { createRetellReadOnlyRouter } from '../../../routes/retellReadOnlyRoutes.js';
import { createRetellReadOnlyRepositories } from './ReadOnlyRepositories.js';
import { createRetellLifecycleRouter } from '../../../routes/retellLifecycleRoutes.js';

export const RETELL_READ_ONLY_PATH = '/api/voice/retell';

// No env or credential lookup. The current server invokes this with no options:
// disabled, no model access, no binding creation and no provider connection.
// A future reviewed registration/lifecycle composition must inject callBindings.
export function mountRetellReadOnlyTools(app, { config = {}, callBindings, registration, models,
  now, audit, deadlineMs } = {}) {
  if (!config || config.enabled !== true) {
    app.use(RETELL_READ_ONLY_PATH, createRetellReadOnlyRouter());
    return Object.freeze({ enabled: false, reasonCode: 'NOT_ENABLED' });
  }
  // Explicit offline/later reviewed composition can share one durable repository
  // between registration, callbacks and tools. The default server supplies none.
  if (registration) {
    if (typeof registration.repository?.findByProviderCallId !== 'function'
      || typeof registration.lifecycle?.handleEvent !== 'function') {
      app.use(RETELL_READ_ONLY_PATH, createRetellReadOnlyRouter());
      return Object.freeze({ enabled: false, reasonCode: 'TRUSTED_BINDING_REPOSITORY_REQUIRED' });
    }
    callBindings = registration.repository;
  }
  // Signing configuration alone is not enough to activate this endpoint.
  if (typeof callBindings?.findByProviderCallId !== 'function') {
    app.use(RETELL_READ_ONLY_PATH, createRetellReadOnlyRouter());
    return Object.freeze({ enabled: false, reasonCode: 'TRUSTED_BINDING_REPOSITORY_REQUIRED' });
  }
  try {
    const router = createRetellReadOnlyRouter({ enabled: true, signingKey: config.signingKey,
      allowedBusinessIds: config.allowedBusinessIds, callBindings,
      ...createRetellReadOnlyRepositories(models), now, audit, deadlineMs });
    if (registration) app.use(RETELL_READ_ONLY_PATH, createRetellLifecycleRouter({
      lifecycle: registration.lifecycle, signingKey: config.signingKey, now }));
    app.use(RETELL_READ_ONLY_PATH, router);
    return Object.freeze({ enabled: true, reasonCode: null });
  } catch {
    // Malformed/missing configuration cannot prevent the existing application starting.
    // Never expose an arbitrary configuration exception or secret in a log/response.
    app.use(RETELL_READ_ONLY_PATH, createRetellReadOnlyRouter());
    return Object.freeze({ enabled: false, reasonCode: 'READ_CONFIGURATION_INVALID' });
  }
}
