import moment from "moment-timezone";
import Barber from "../../../models/Barber.js";
import {
  getAvailableSlots,
  getServiceDurationMinutes,
  isSlotAvailable,
  suggestClosestSlots,
} from "../../../utils/ai/availabilityHelpers.js";
import { deriveSlotKey } from "../domain/BookingProposal.js";
import { AvailabilityPort, validateAvailabilityRequest } from "../ports/AvailabilityPort.js";
import { BusinessReason, normalizeBusinessError } from "../ports/PortErrors.js";

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
