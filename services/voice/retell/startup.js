import express from 'express';
import { createRetellRegistrationTransport } from './RegistrationTransport.js';
import { mountRetellReadOnlyTools } from './mountReadOnlyTools.js';

// Dashboard-supplied intended identity; the export deliberately has an empty ID.
// Neither this constant nor a local setting proves provider ownership/publication.
export const INTENDED_RETELL_AGENT_ID = 'agent_1da974cf19d41a0b0e64b012d5';

function configuration(env) {
  // Do not even read secret properties unless BOTH explicit switches are on.
  if (env.RETELL_SANDBOX_ENABLED !== 'true' || env.RETELL_SANDBOX_EXECUTION_ENABLED !== 'true') return null;
  const businessId = env.RETELL_SANDBOX_BUSINESS_ID, budgetId = env.RETELL_SANDBOX_BUDGET_ID;
  const agentId = env.RETELL_SANDBOX_AGENT_ID || INTENDED_RETELL_AGENT_ID;
  const version = env.RETELL_SANDBOX_AGENT_VERSION, language = env.RETELL_SANDBOX_LANGUAGE || 'es';
  const origin = new URL(env.APP_BASE_URL);
  if (!/^[a-f\d]{24}$/.test(businessId || '') || !/^[A-Za-z0-9_-]{8,80}$/.test(budgetId || '')
    || !/^agent_[A-Za-z0-9_-]{1,100}$/.test(agentId) || !/^(0|[1-9]\d*)$/.test(version || '')
    || !Number.isSafeInteger(Number(version)) || !['en', 'es'].includes(language)
    || origin.protocol !== 'https:' || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash)
    throw Error('INVALID_CONFIGURATION');
  const apiKey = env.RETELL_API_KEY, signingKey = env.RETELL_WEBHOOK_SIGNING_KEY, authToken = env.TWILIO_AUTH_TOKEN;
  if ([apiKey, signingKey, authToken].some(value => typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)))
    throw Error('MISSING_CONFIGURATION');
  const bookingEnabled = env.RETELL_BOOKING_ENABLED === 'true';
  const developmentEnabled = env.RETELL_SANDBOX_DEVELOPMENT_ENABLED === 'true';
  const developmentRunId = env.RETELL_SANDBOX_TEST_RUN_ID;
  if (developmentEnabled && (!/^[A-Za-z0-9_-]{8,80}$/.test(developmentRunId || '')
    || /^glo_retell_checkpoint_00[12]$/.test(developmentRunId))) throw Error('INVALID_DEVELOPMENT_RUN');
  const transcriptsEnabled = env.RETELL_TRANSCRIPTS_ENABLED === 'true';
  const retention = env.RETELL_TRANSCRIPT_RETENTION_DAYS;
  if (transcriptsEnabled && (!/^(?:[1-9]|[12]\d|30)$/.test(retention || ''))) throw Error('INVALID_TRANSCRIPT_POLICY');
  return { businessId, budgetId, agentId, agentVersion: Number(version), language, apiKey, signingKey, authToken, origin: origin.origin,
    bookingEnabled, developmentEnabled, developmentRunId,
    transcriptPolicy: { enabled: transcriptsEnabled, retentionDays: transcriptsEnabled ? Number(retention) : undefined } };
}

// Single pre-JSON boot seam. Never boot server.js in offline tests (it connects
// Mongo, reads dotenv and starts jobs). Tests pass synthetic env/dependencies here.
export async function mountRetellStartup(app, { env = process.env, http, dependencies = {} } = {}) {
  const disabled = reasonCode => {
    mountRetellReadOnlyTools(app);
    return Object.freeze({ enabled: false, reasonCode });
  };
  let config;
  try { config = configuration(env); } catch { return disabled('SANDBOX_CONFIGURATION_INVALID'); }
  if (!config) return disabled('NOT_ENABLED');
  try {
    const provider = createRetellRegistrationTransport({ enabled: true, apiKey: config.apiKey, http });
    // Import durable registration models only on the validated enabled path.
    const { installRetellSandbox } = await import('./installSandbox.js');
    // Stage routers privately. A failed installer cannot leave an enabled or
    // shadowing route on the real app, nor can it replace the normal phone owner.
    const router = express.Router();
    const pending = { locals: {}, use: (...args) => router.use(...args) };
    installRetellSandbox(pending, { ...dependencies, enabled: true, executionEnabled: true,
      businessId: config.businessId, budgetId: config.budgetId, provider,
      agentsByBusiness: { [config.businessId]: { agentId: config.agentId, agentVersion: config.agentVersion, language: config.language } },
      twilioAuth: { authToken: config.authToken, appBaseUrl: config.origin }, signingKey: config.signingKey,
      bookingEnabled: config.bookingEnabled, transcriptPolicy: config.transcriptPolicy,
      developmentEnabled: config.developmentEnabled, developmentRunId: config.developmentRunId });
    app.use(router);
    app.locals.retellSandbox = pending.locals.retellSandbox;
    return Object.freeze({ enabled: true, reasonCode: null, agentId: config.agentId, agentVersion: config.agentVersion });
  } catch { return disabled('SANDBOX_CONFIGURATION_INVALID'); }
}
