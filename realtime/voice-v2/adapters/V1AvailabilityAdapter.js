import moment from "moment-timezone";
import Barber from "../../../models/Barber.js";
import {
  getAvailableSlots,
  getServiceDurationMinutes,
  isSlotAvailable,
  suggestClosestSlots,
} from "../../../utils/ai/availabilityHelpers.js";
import { deriveSlotKey } from "../domain/BookingProposal.js";
import { AvailabilityPort, AvailabilitySearchType, validateAvailabilityRequest, validateAvailabilitySearchRequest } from "../ports/AvailabilityPort.js";
import { BusinessReason, normalizeBusinessError } from "../ports/PortErrors.js";
import { preferenceAllows } from '../domain/AvailabilityState.js';

export const V1_AVAILABILITY_SIGNATURE = Object.freeze({
  isSlotAvailableArity: 1,
  getAvailableSlotsArity: 1,
  suggestClosestSlotsArity: 1,
  getServiceDurationMinutesArity: 2,
});

export class V1AvailabilityAdapter extends AvailabilityPort {
  constructor({
    findBarberByIdFn = (barberId) => Barber.findById(barberId).lean(),
    checkAvailabilityFn = isSlotAvailable,
    getAvailableSlotsFn = getAvailableSlots,
    findAlternativesFn = suggestClosestSlots,
    getServiceDurationFn = getServiceDurationMinutes,
  } = {}) {
    super();
    this.findBarberByIdFn = findBarberByIdFn;
    this.checkAvailabilityFn = checkAvailabilityFn;
    this.getAvailableSlotsFn = getAvailableSlotsFn;
    this.findAlternativesFn = findAlternativesFn;
    this.getServiceDurationFn = getServiceDurationFn;
  }

  async checkAvailability(request) {
    try {
      validateAvailabilityRequest(request);
      const validation = validateSlotIdentityAndTime(request);
      if (!validation.valid) return unavailableResult(request.slotKey, validation.reason);
      const barber = await this.findBarberByIdFn(request.barberId);
      if (!barber) return unavailableResult(request.slotKey, BusinessReason.NOT_FOUND);
      if (!timeZonesAgree(barber, request.timeZone)) return unavailableResult(request.slotKey, BusinessReason.INVALID_SLOT);
      const durationMinutes = this.getServiceDurationFn(barber, request.service);
      const v1Time = toV1Time(request.date, request.time, request.timeZone);
      const raw = await this.checkAvailabilityFn({ barber, date: request.date, time: v1Time, durationMinutes });
      if (!resultMatchesRequest(raw, request, v1Time)) return unavailableResult(request.slotKey, BusinessReason.INVALID_SLOT);
      const available = typeof raw === "boolean" ? raw : raw.available === true || raw.ok === true;
      return Object.freeze({
        slotKey: request.slotKey,
        available,
        reason: available ? null : normalizeUnavailableReason(raw?.reason),
        conflictId: raw?.conflictId ?? null,
        metadata: Object.freeze({ durationMinutes, timeZone: request.timeZone }),
      });
    } catch (error) {
      return unavailableResult(request?.slotKey ?? null, normalizeBusinessError(error, BusinessReason.PERSISTENCE_ERROR));
    }
  }

  async getAlternatives(request) {
    try {
      validateAvailabilityRequest(request);
      const validation = validateSlotIdentityAndTime(request);
      if (!validation.valid) return Object.freeze({ slotKey: request.slotKey, alternatives: Object.freeze([]), reason: validation.reason });
      const barber = await this.findBarberByIdFn(request.barberId);
      if (!barber) return Object.freeze({ slotKey: request.slotKey, alternatives: Object.freeze([]), reason: BusinessReason.NOT_FOUND });
      if (!timeZonesAgree(barber, request.timeZone)) return Object.freeze({ slotKey: request.slotKey, alternatives: Object.freeze([]), reason: BusinessReason.INVALID_SLOT });
      const durationMinutes = this.getServiceDurationFn(barber, request.service);
      const v1Time = toV1Time(request.date, request.time, request.timeZone);
      const sameDay = await this.getAvailableSlotsFn({
        barber, date: request.date, durationMinutes, limit: request.limit ?? 3, startAfterTime: v1Time,
      });
      let raw = Array.isArray(sameDay) ? sameDay : [];
      if (raw.length < (request.limit ?? 3)) {
        const future = await this.findAlternativesFn({ barber, date: request.date, durationMinutes });
        raw = [...raw, ...(Array.isArray(future) ? future : [])];
      }
      const seen = new Set();
      const alternatives = raw.flatMap((slot) => {
        const time = fromV1Time(slot?.date, slot?.time, request.timeZone);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(slot?.date ?? "") || !time) return [];
        const slotKey = deriveSlotKey({ service: request.service, date: slot.date, time });
        if (seen.has(slotKey)) return [];
        seen.add(slotKey);
        return [Object.freeze({ date: slot.date, time, slotKey })];
      }).slice(0, request.limit ?? 3);
      return Object.freeze({ slotKey: request.slotKey, alternatives: Object.freeze(alternatives), reason: null });
    } catch (error) {
      return Object.freeze({ slotKey: request?.slotKey ?? null, alternatives: Object.freeze([]), reason: normalizeBusinessError(error, BusinessReason.PERSISTENCE_ERROR) });
    }
  }

  async searchAvailableTimes(request) {
    try {
      validateAvailabilitySearchRequest(request);
      if (request.proposalSlotKey !== deriveSlotKey({ service: request.service, date: request.requestedDate, time: null })) {
        return schedulingResult(request, [], BusinessReason.INVALID_SLOT);
      }
      const barber = await this.findBarberByIdFn(request.barberId);
      if (!barber) return schedulingResult(request, [], BusinessReason.NOT_FOUND);
      if (!timeZonesAgree(barber, request.timeZone)) return schedulingResult(request, [], BusinessReason.INVALID_SLOT);
      const durationMinutes = this.getServiceDurationFn(barber, request.service);
      const limit = request.limit ?? 3;
      if (request.searchPreference) {
        const preference = request.searchPreference;
        let resolvedLowerTime = null;
        if (preference.ambiguousHour) {
          const hour = Number(preference.time.slice(0, 2)) % 12;
          const candidates = [hour, hour + 12].map(h => `${String(h).padStart(2, '0')}:${preference.time.slice(3)}`)
            .filter(time => withinBusinessHours(barber, request, time, durationMinutes));
          if (candidates.length !== 1) return schedulingResult(request, [], 'AMBIGUOUS_TIME_REFERENCE', durationMinutes);
          resolvedLowerTime = candidates[0];
        }
        // The shared helper advances in 30-minute steps: one local day has at
        // most 48 candidates. Filter before taking three, so morning slots
        // cannot hide eligible afternoon slots. No cross-date preference guess.
        const raw = await this.getAvailableSlotsFn({ barber, date: request.requestedDate, durationMinutes, limit: 48, startAfterTime: null });
        const alternatives = normalizeSearchAlternatives(Array.isArray(raw) ? raw : [], request)
          .filter(slot => slot.date === request.requestedDate && withinBusinessHours(barber, request, slot.time, durationMinutes)
            && preferenceAllows(slot.time, preference, resolvedLowerTime))
          .sort((a, b) => a.time.localeCompare(b.time)).slice(0, limit);
        return schedulingResult(request, alternatives, closedDateReason(barber, request.requestedDate, request.timeZone)
          || (alternatives.length ? null : BusinessReason.UNAVAILABLE), durationMinutes, resolvedLowerTime);
      }
      const startAfterTime = request.searchType === AvailabilitySearchType.LATER
        ? toV1Time(request.requestedDate, request.afterTime, request.timeZone)
        : null;
      if (request.searchType === AvailabilitySearchType.LATER && !startAfterTime) {
        return schedulingResult(request, [], BusinessReason.INVALID_SLOT, durationMinutes);
      }
      const sameDay = await this.getAvailableSlotsFn({
        barber, date: request.requestedDate, durationMinutes, limit, startAfterTime,
      });
      let raw = Array.isArray(sameDay) ? sameDay : [];
      if (raw.length < limit) {
        const futureStart = request.searchType === AvailabilitySearchType.LATER
          ? moment.tz(request.requestedDate, "YYYY-MM-DD", true, request.timeZone).add(1, "day").format("YYYY-MM-DD")
          : request.requestedDate;
        const future = await this.findAlternativesFn({ barber, date: futureStart, durationMinutes });
        raw = [...raw, ...(Array.isArray(future) ? future : [])];
      }
      const alternatives = normalizeSearchAlternatives(raw, request).slice(0, limit);
      const requestedDateReason = closedDateReason(barber, request.requestedDate, request.timeZone);
      return schedulingResult(
        request,
        alternatives,
        requestedDateReason || (alternatives.length ? null : BusinessReason.UNAVAILABLE),
        durationMinutes,
      );
    } catch (error) {
      return schedulingResult(request, [], normalizeBusinessError(error, BusinessReason.PERSISTENCE_ERROR));
    }
  }
}

function validateSlotIdentityAndTime(request) {
  if (request.slotKey !== deriveSlotKey(request)) return { valid: false, reason: BusinessReason.INVALID_SLOT };
  return toV1Time(request.date, request.time, request.timeZone)
    ? { valid: true, reason: null }
    : { valid: false, reason: BusinessReason.INVALID_SLOT };
}

function timeZonesAgree(barber, requested) {
  return (barber?.availability?.timezone || "America/New_York") === requested;
}

function toV1Time(date, time, timeZone) {
  if (!moment.tz.zone(timeZone)) return null;
  const parsed = moment.tz(`${date} ${time}`, "YYYY-MM-DD HH:mm", true, timeZone);
  if (!parsed.isValid() || parsed.format("YYYY-MM-DD HH:mm") !== `${date} ${time}`) return null;
  return parsed.format("h:mm A");
}

function fromV1Time(date, time, timeZone) {
  if (!moment.tz.zone(timeZone)) return null;
  const parsed = moment.tz(`${date} ${time}`, "YYYY-MM-DD h:mm A", true, timeZone);
  return parsed.isValid() ? parsed.format("HH:mm") : null;
}

function resultMatchesRequest(raw, request, v1Time) {
  if (!raw || typeof raw === "boolean") return true;
  if (raw.slotKey && raw.slotKey !== request.slotKey) return false;
  if (raw.date && raw.date !== request.date) return false;
  if (raw.time && raw.time !== request.time && raw.time !== v1Time) return false;
  if (raw.service && raw.service !== request.service) return false;
  return true;
}

function normalizeUnavailableReason(reason) {
  if (["closed_day", "outside_hours", "no_same_day", "past_cutoff"].includes(reason)) return BusinessReason.BUSINESS_CLOSED;
  if (["slot_taken", "conflict"].includes(reason)) return BusinessReason.CONFLICT;
  return BusinessReason.UNAVAILABLE;
}

function unavailableResult(slotKey, reason) {
  return Object.freeze({ slotKey, available: false, reason, conflictId: null, metadata: Object.freeze({}) });
}

function normalizeSearchAlternatives(raw, request) {
  const seen = new Set();
  const threshold = request.searchType === AvailabilitySearchType.LATER
    ? `${request.requestedDate}T${request.afterTime}`
    : null;
  return raw.flatMap((slot) => {
    const time = fromV1Time(slot?.date, slot?.time, request.timeZone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(slot?.date ?? "") || !time) return [];
    if (threshold && `${slot.date}T${time}` <= threshold) return [];
    const slotKey = deriveSlotKey({ service: request.service, date: slot.date, time });
    if (seen.has(slotKey)) return [];
    seen.add(slotKey);
    return [Object.freeze({ date: slot.date, time, slotKey })];
  });
}

function closedDateReason(barber, date, timeZone) {
  const parsed = moment.tz(date, "YYYY-MM-DD", true, timeZone);
  if (!parsed.isValid()) return BusinessReason.INVALID_SLOT;
  const dayHours = barber.availability?.businessHours?.[["sun", "mon", "tue", "wed", "thu", "fri", "sat"][parsed.day()]];
  if (!dayHours || dayHours.isClosed) return BusinessReason.BUSINESS_CLOSED;
  const blackedOut = (barber.availability?.blackoutDates || []).some((entry) => moment.tz(entry?.date, timeZone).format("YYYY-MM-DD") === date);
  return blackedOut ? BusinessReason.BUSINESS_CLOSED : null;
}

function withinBusinessHours(barber, request, time, durationMinutes) {
  const start = moment.tz(`${request.requestedDate} ${time}`, 'YYYY-MM-DD HH:mm', true, request.timeZone);
  if (!start.isValid() || start.format('HH:mm') !== time) return false;
  const hours = barber.availability?.businessHours?.[['sun','mon','tue','wed','thu','fri','sat'][start.day()]];
  if (!hours || hours.isClosed || !Number.isFinite(durationMinutes) || durationMinutes <= 0) return false;
  const open = moment.tz(`${request.requestedDate} ${hours.open}`, 'YYYY-MM-DD HH:mm', true, request.timeZone);
  const close = moment.tz(`${request.requestedDate} ${hours.close}`, 'YYYY-MM-DD HH:mm', true, request.timeZone);
  return open.isValid() && close.isValid() && start.isSameOrAfter(open) && start.clone().add(durationMinutes, 'minutes').isSameOrBefore(close);
}

function schedulingResult(request, alternatives, reason, durationMinutes = null, resolvedLowerTime = null) {
  return Object.freeze({
    proposalVersion: request?.proposalVersion ?? null,
    proposalSlotKey: request?.proposalSlotKey ?? null,
    searchType: request?.searchType ?? null,
    requestedDate: request?.requestedDate ?? null,
    afterTime: request?.afterTime ?? null,
    alternatives: Object.freeze(alternatives),
    reason,
    ...(request?.searchPreference ? { searchPreference: request.searchPreference } : {}),
    ...(resolvedLowerTime ? { resolvedLowerTime } : {}),
    metadata: Object.freeze({ durationMinutes, timeZone: request?.timeZone ?? null }),
  });
}
