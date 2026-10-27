const str = { type: 'string', minLength: 1, maxLength: 128 };
const integer = { type: 'integer', minimum: 1, maximum: 1000000 };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
export function matches(value, schema) {
  if (schema.oneOf) return schema.oneOf.filter(s => matches(value, s)).length === 1;
  if (schema.enum) return schema.enum.includes(value);
  if (schema.type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
    && schema.required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => Object.hasOwn(schema.properties, key) && matches(value[key], schema.properties[key]));
  if (schema.type === 'array') return Array.isArray(value) && value.length >= schema.minItems && value.length <= schema.maxItems && value.every(v => matches(v, schema.items));
  if (schema.type === 'integer') return Number.isSafeInteger(value) && value >= schema.minimum && value <= schema.maximum;
  return schema.type === 'string' && typeof value === 'string' && value.length >= schema.minLength && value.length <= schema.maxLength && !/[\x00-\x1f]/.test(value);
}
export function phoneContracts(ids) {
  const id = { enum: ids }, array = items => ({ type: 'array', minItems: 1, maxItems: 8, items });
  const binding = { turnId: str, proposalVersion: integer, businessRevision: str, serviceIds: { ...array(id), minItems: 0 }, language: { enum: ['en', 'es'] } };
  const changes = { oneOf: [object({ kind: { enum: ['SET_SERVICE', 'ADD_SERVICE', 'REMOVE_SERVICE'] }, serviceId: id }),
    object({ kind: { enum: ['SET_DATE'] }, date: { ...str, maxLength: 10 } }), object({ kind: { enum: ['SET_TIME'] }, time: { ...str, maxLength: 5 } }),
    object({ kind: { enum: ['SET_NAME'] }, name: str }), object({ kind: { enum: ['SELECT_ALTERNATIVE'] }, alternativeId: str }),
    object({ kind: { enum: ['SET_PREFERENCE'] }, preference: object({ kind: { enum: ['MORNING', 'AFTERNOON'] } }) })] };
  const plans = ['ASK_MISSING', 'EXPLAIN_RESULT', 'OFFER_ALTERNATIVES', 'ACK_DRAFT', 'CANONICAL_CONFIRMATION', 'EXPLAIN_DELIVERY_GATE', 'EXPLAIN_SIMULATION', 'EXPLAIN_UNSUPPORTED'];
  const plan = { oneOf: plans.map(type => object({ ...binding, type: { enum: [type] },
    ...(type === 'ASK_MISSING' ? { field: { enum: ['service', 'date', 'time', 'name'] } } : {}),
    ...(type === 'OFFER_ALTERNATIVES' ? { alternativeIds: { ...array(str), maxItems: 3 } } : {}) })) };
  const wire = object({ ...binding, type: { enum: plans }, field: { enum: ['service', 'date', 'time', 'name'] }, alternativeIds: { ...array(str), maxItems: 3 } }, [...Object.keys(binding), 'type']);
  const tools = [
    ['read_business_context', 'Read current application-owned business facts, clock, catalogue and draft.', object({})],
    ['update_appointment_draft', 'Apply ordered changes atomically. SET_DATE is a real YYYY-MM-DD date within the supplied booking window. Resolve alternative IDs against the current originating bundle before any changes. Never book.', object({ ...binding, changes: array(changes) })],
    ['check_availability', 'Check the complete ordered service bundle with its summed duration. No reservation.', object(binding)],
    ['request_canonical_confirmation', 'Check confirmation eligibility. Read eligibilityReason, missingFields and nextAction: missing draft fields require collection, unknown/stale evidence requires check_availability, and unavailable results require explanation/current alternatives. On the last allowed model response this explicit request hands off to application-owned validated confirmation or supported recovery. Never grants delivery or booking authority.', object(binding)],
    ['submit_confirmation_meaning', 'Propose consent meaning; existing delivered-confirmation authority and caller evidence decide. Simulation only.', object({ ...binding, meaning: { enum: ['AFFIRM', 'DENY', 'UNKNOWN', 'CORRECTION'] } })],
    ['propose_response_plan', 'End the turn with a communication purpose and current bindings. No arbitrary wording or facts.', wire],
  ].map(([name, description, parameters]) => ({ type: 'function', name, description, parameters }));
  return { tools, plan };
}
export const PHONE_LIMITS = Object.freeze({ turns: 12, perTurnRequests: 4, modelRequests: 48, speechRequests: 16,
  callMs: 180000, decisionMs: 20000, decisionConnections: 4, retries: 0 });
export function selectStructuredPhone(env, businessId) {
  const ids = String(env.VOICE_V2_STRUCTURED_PHONE_BUSINESS_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  return env.ENABLE_VOICE_V2_STRUCTURED_PHONE === 'true' && ids.length <= 16 && ids.every(id => /^[a-f\d]{24}$/i.test(id)) && ids.includes(String(businessId));
}
