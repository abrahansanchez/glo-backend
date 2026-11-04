const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const prepareFields = { serviceIds: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 128 } },
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, time: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
    businessRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' }, clientName: { type: 'string', minLength: 1, maxLength: 128 } };
export const legacyPrepareBookingSchema = object({ ...prepareFields,
  contactNumber: { type: 'string', pattern: '^\\+[1-9]\\d{7,14}$' } });
export const bookingToolSchemas = Object.freeze({
  prepare_booking: { ...object({ ...prepareFields,
    contactSource: { type: 'string', enum: ['CALLER_NUMBER','PROVIDED_NUMBER'], description: 'CALLER_NUMBER only after agreement to use original incoming caller number for this booking; otherwise PROVIDED_NUMBER.' },
    contactNumber: { type: 'string', minLength: 1, maxLength: 64, description: 'Required only for PROVIDED_NUMBER. Exact supplied number, including international country code unless a trusted default country is configured. Omit for CALLER_NUMBER.' },
    callerNumberConsent: { type: 'string', enum: ['AGREED'], description: 'Required only for CALLER_NUMBER, after the caller agrees for this booking. Omit for PROVIDED_NUMBER.' },
  }), required: [...Object.keys(prepareFields),'contactSource'] },
  commit_booking: object({ proposalId: { type: 'string', pattern: '^[a-f0-9-]{36}$' }, confirmation: { type: 'string', enum: ['AFFIRMATIVE'] } }),
});
export function retellBookingTools(origin) {
  return Object.entries(bookingToolSchemas).map(([name, parameters]) => ({ type: 'custom', name, parameters,
    description: name === 'prepare_booking' ? 'Prepare one catalogue item, not a booking. CALLER_NUMBER requires callerNumberConsent=AGREED and no contactNumber. PROVIDED_NUMBER requires contactNumber and no callerNumberConsent. Read the resolved summary and ask explicit confirmation. Caller ID is contact convenience, not customer authentication.'
      : 'Commit the current proposal only after the caller explicitly confirms its exact summary. An unknown outcome is not a booking success.',
    method: 'POST', url: `${origin}/api/voice/retell/tools/${name === 'prepare_booking' ? 'prepare-booking' : 'commit-booking'}`,
    args_at_root: false, timeout_ms: name === 'prepare_booking' ? 5000 : 15000, max_retry: 0 }));
}
