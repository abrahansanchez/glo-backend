const parameters = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

// Application-owned, unprovisioned templates, NOT a complete Retell create-agent payload.
// URLs cannot resolve to a real integration; replace only during separately approved setup.
export function retellReadOnlyAgentTemplate(language = 'en') {
  if (!['en', 'es'].includes(language)) throw Error('UNSUPPORTED_TEMPLATE_LANGUAGE');
  return {
    provisioningStatus: 'UNPROVISIONED', mode: 'READ_ONLY', language,
    instructions: language === 'es'
      ? 'Habla en español. Consulta read_business_context antes de hablar de servicios, precios, duración u horarios. Usa los identificadores y businessRevision recibidos para consultar check_bundle_availability con todos los servicios en el orden solicitado. Las fechas usan YYYY-MM-DD y las horas HH:mm en la zona horaria del negocio. No inventes datos ni traducciones de nombres. Los datos desconocidos siguen siendo desconocidos. Ofrece solo alternativas verificadas para el conjunto completo. La disponibilidad no es una reserva. No puedes reservar, modificar, cancelar citas ni enviar SMS; nunca afirmes que se ha reservado una cita. No solicites ni suministres identificadores de negocio, consentimiento o confirmación de reproducción. Si una consulta falla o los datos cambian, explica la limitación; no inventes un resultado.'
      : 'Speak English. Call read_business_context before stating services, prices, durations or hours. Use returned service IDs and businessRevision to call check_bundle_availability for every requested service in order. Dates use YYYY-MM-DD and times HH:mm in the business timezone. Never invent facts or translations of service names. Unknown facts remain unknown. Offer only verified alternatives for the complete bundle. Availability is not a reservation. You cannot book, change, cancel appointments or send SMS; never claim a booking succeeded. Do not request or supply business identifiers, consent or playback acknowledgment. If a read fails or facts change, explain the limitation rather than inventing a result.',
    tools: [
      { type: 'custom', name: 'read_business_context', description: 'Read current public business catalogue, timezone, clock, supported window and hours. No mutation or booking authority.',
        url: 'https://retell-tools.invalid/api/voice/retell/tools/context', method: 'POST',
        parameters: parameters({}), args_at_root: false, max_retry: 0, timeout_ms: 3500 },
      { type: 'custom', name: 'check_bundle_availability', description: 'Read availability and up to three freshly checked alternatives for ordered services. Does not reserve, confirm or book.',
        url: 'https://retell-tools.invalid/api/voice/retell/tools/availability', method: 'POST',
        parameters: parameters({ serviceIds: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 128 } }, date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        time: { type: 'string', pattern: '^\\d{2}:\\d{2}$' }, businessRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' } }),
        args_at_root: false, max_retry: 0, timeout_ms: 3500 },
    ],
  };
}
