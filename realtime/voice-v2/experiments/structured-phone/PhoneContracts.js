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
    object({ kind: { enum: ['SET_DATE'] }, date: { ...str, maxLength: 10 } }),
    object({ kind: { enum: ['SET_DATE_RANGE'] }, startDate: { ...str, maxLength: 10 }, endDate: { ...str, maxLength: 10 } }),
    object({ kind: { enum: ['SET_TIME'] }, time: { ...str, maxLength: 5 } }),
    object({ kind: { enum: ['SET_NAME'] }, name: str }), object({ kind: { enum: ['SELECT_ALTERNATIVE'] }, alternativeId: str }),
    object({ kind: { enum: ['SET_PREFERENCE'] }, preference: { oneOf: [object({ kind: { enum: ['MORNING', 'AFTERNOON'] } }), object({ kind: { enum: ['AFTER'] }, time: { ...str, maxLength: 5 } })] } })] };
  const decision = object({ ...binding,
    changes: { ...array(changes), minItems: 0 },
    intent: { enum: ['REQUEST', 'QUESTION', 'CONFIRMATION', 'CLARIFY', 'UNSUPPORTED'] },
    meaning: { enum: ['AFFIRM', 'DENY', 'UNKNOWN', 'CORRECTION'] },
    questions: { type: 'array', minItems: 0, maxItems: 3, items: { enum: ['PRICE', 'DURATION', 'AVAILABILITY'] } },
    missingField: { enum: ['NONE', 'service', 'date', 'time', 'name'] },
  });
  const plans = ['ASK_MISSING', 'EXPLAIN_RESULT', 'OFFER_ALTERNATIVES', 'ACK_DRAFT', 'CANONICAL_CONFIRMATION', 'EXPLAIN_DELIVERY_GATE', 'EXPLAIN_SIMULATION', 'EXPLAIN_UNSUPPORTED'];
  const plan = { oneOf: plans.map(type => object({ ...binding, type: { enum: [type] },
    ...(type === 'ASK_MISSING' ? { field: { enum: ['service', 'date', 'time', 'name'] } } : {}),
    ...(type === 'OFFER_ALTERNATIVES' ? { alternativeIds: { ...array(str), maxItems: 3 } } : {}) })) };
  const decisionTool = { type: 'function', name: 'submit_turn_decision', description: 'Interpret the complete caller turn once. Include every ordered change and question. Dates are YYYY-MM-DD within the business window. Preserve service order; alternative IDs refer to current originating evidence. AFTER is an explicit lower time bound, not an available slot. Questions are typed requests, not answers. Unsupported questions/intent require UNSUPPORTED; uncertainty requires CLARIFY. CONFIRMATION proposes meaning only, never consent authority. CORRECTION with explicit ordered changes applies only those changes and never submits consent. CLARIFY with no missing field asks about current alternatives without selecting one. Do not predict availability or choose speech.', parameters: decision };
  return { tools: [decisionTool], decision, plan };
}
export const PHONE_LIMITS = Object.freeze({ turns: 12, perTurnRequests: 1, modelRequests: 12, speechRequests: 16,
  callMs: 180000, decisionMs: 20000, decisionConnections: 4, retries: 0 });
export function selectStructuredPhone(env, businessId) {
  const ids = String(env.VOICE_V2_STRUCTURED_PHONE_BUSINESS_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  return env.ENABLE_VOICE_V2_STRUCTURED_PHONE === 'true' && ids.length <= 16 && ids.every(id => /^[a-f\d]{24}$/i.test(id)) && ids.includes(String(businessId));
}
