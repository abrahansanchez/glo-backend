const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const bookingToolSchemas = Object.freeze({
  prepare_booking: object({ serviceIds: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 128 } },
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, time: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
    businessRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' }, clientName: { type: 'string', minLength: 1, maxLength: 128 },
    contactNumber: { type: 'string', pattern: '^\\+[1-9]\\d{7,14}$' } }),
  commit_booking: object({ proposalId: { type: 'string', pattern: '^[a-f0-9-]{36}$' }, confirmation: { type: 'string', enum: ['AFFIRMATIVE'] } }),
});
export function retellBookingTools(origin) {
  return Object.entries(bookingToolSchemas).map(([name, parameters]) => ({ type: 'custom', name, parameters,
    description: name === 'prepare_booking' ? 'Validate one catalogue item and return an expiring proposal. Not a booking. Ask explicit confirmation of its exact summary.'
      : 'Commit the current proposal only after the caller explicitly confirms its exact summary. An unknown outcome is not a booking success.',
    method: 'POST', url: `${origin}/api/voice/retell/tools/${name === 'prepare_booking' ? 'prepare-booking' : 'commit-booking'}`,
    args_at_root: false, timeout_ms: name === 'prepare_booking' ? 5000 : 15000, max_retry: 0 }));
}
