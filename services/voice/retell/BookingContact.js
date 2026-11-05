import { parsePhoneNumberWithError, isSupportedCountry } from 'libphonenumber-js/max';

const common = ['serviceIds','date','time','businessRevision','clientName'];
const exact = (args, fields) => args && typeof args === 'object' && !Array.isArray(args)
  && Object.keys(args).length === fields.length && fields.every(k => Object.hasOwn(args, k));
const bounded = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 64 && !/[\x00-\x1f]/.test(value);

export function validContactSelection(args, {allowManagement=false,allowNotifications=false,allowReminders=false}={}) {
  if(args?.staffCalendarId!==undefined){if(args.staffCalendarId!=='ANY'&&!/^[a-f0-9]{24}$/.test(args.staffCalendarId))return false;const base={...args};delete base.staffCalendarId;return validContactSelection(base,{allowManagement,allowNotifications,allowReminders});}
  if(args && ['managementConsent','notificationConsent','reminderConsent'].some(k=>Object.hasOwn(args,k))){
    if(Object.hasOwn(args,'managementConsent')&&(!allowManagement||args.managementConsent!=='AGREED'))return false;
    if(Object.hasOwn(args,'notificationConsent')&&(!allowNotifications||args.notificationConsent!=='AGREED'))return false;
    if(Object.hasOwn(args,'reminderConsent')&&(!allowReminders||args.reminderConsent!=='AGREED'||args.notificationConsent!=='AGREED'))return false;
    const base={...args};delete base.managementConsent;delete base.notificationConsent;delete base.reminderConsent;return validContactSelection(base);
  }
  if (!args || typeof args !== 'object') return false;
  if (!Object.hasOwn(args, 'contactSource')) return exact(args, [...common,'contactNumber'])
    && typeof args.contactNumber === 'string' && /^\+[1-9]\d{7,14}$/.test(args.contactNumber);
  if (args.contactSource === 'CALLER_NUMBER') return exact(args, [...common,'contactSource','callerNumberConsent'])
    && args.callerNumberConsent === 'AGREED';
  return args.contactSource === 'PROVIDED_NUMBER' && exact(args, [...common,'contactSource','contactNumber']) && bounded(args.contactNumber);
}

export function validateDefaultCountry(country) {
  if (country !== undefined && (typeof country !== 'string' || !/^[A-Z]{2}$/.test(country) || !isSupportedCountry(country)))
    throw Error('INVALID_BOOKING_DEFAULT_COUNTRY');
  return country;
}

const reject = (reasonCode, recovery) => ({ ok: false, reasonCode, recovery });
export function resolveBookingContact(args, durableCallerNumber, defaultCountry) {
  validateDefaultCountry(defaultCountry);
  if (!validContactSelection(args)) return reject('INVALID_CONTACT_SELECTION','COLLECT_CONTACT');
  const fromCaller = args.contactSource === 'CALLER_NUMBER';
  const input = fromCaller ? durableCallerNumber : args.contactNumber;
  if (fromCaller && (typeof input !== 'string' || !/^\+[1-9]\d{7,14}$/.test(input)))
    return reject('CALLER_NUMBER_UNAVAILABLE','COLLECT_CONTACT');
  if (!bounded(input)) return reject(fromCaller ? 'CALLER_NUMBER_UNAVAILABLE' : 'INVALID_CONTACT_NUMBER','COLLECT_CONTACT');
  const normalized = input.normalize('NFKC').trim();
  // Never extract a number from arbitrary text or silently drop an extension.
  if (!/^[+0-9().\s-]+$/.test(normalized))
    return reject(fromCaller ? 'CALLER_NUMBER_UNAVAILABLE' : 'INVALID_CONTACT_NUMBER','COLLECT_CONTACT');
  if (!normalized.startsWith('+') && !defaultCountry)
    return reject('CONTACT_COUNTRY_REQUIRED','ASK_INTERNATIONAL_NUMBER');
  try {
    const phone = parsePhoneNumberWithError(normalized, { extract: false,
      ...(normalized.startsWith('+') ? {} : { defaultCountry }) });
    if (!phone.isValid() || phone.ext || !/^\+[1-9]\d{7,14}$/.test(phone.number)) throw Error();
    return { ok: true, contactNumber: phone.number,
      contactSource: fromCaller ? 'CALLER_NUMBER' : args.contactSource || 'LEGACY_E164',
      callerNumberUseAgreed: fromCaller };
  } catch {
    return reject(fromCaller ? 'CALLER_NUMBER_UNAVAILABLE' : 'INVALID_CONTACT_NUMBER','COLLECT_CONTACT');
  }
}
