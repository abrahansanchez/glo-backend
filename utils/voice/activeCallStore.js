const ACTIVE_CALL_TTL_MS = 60 * 1000;
const activeCallsByBarberId = new Map();
const barberIdByCallSid = new Map();

const isExpired = (activeCall) =>
  !activeCall ||
  !activeCall.createdAt ||
  Date.now() - activeCall.createdAt > ACTIVE_CALL_TTL_MS;

const pruneExpiredForBarber = (barberId) => {
  const current = activeCallsByBarberId.get(barberId);
  if (isExpired(current)) {
    if (current?.callSid) {
      barberIdByCallSid.delete(current.callSid);
    }
    activeCallsByBarberId.delete(barberId);
    return null;
  }
  return current;
};

export const setActiveCall = ({ barberId, callSid, from, to, createdAt }) => {
  if (!barberId || !callSid) return null;

  const payload = {
    barberId: String(barberId),
    callSid: String(callSid),
    from: from ? String(from) : "",
    to: to ? String(to) : "",
    createdAt: createdAt || Date.now(),
  };

  activeCallsByBarberId.set(payload.barberId, payload);
  barberIdByCallSid.set(payload.callSid, payload.barberId);
  return payload;
};

export const getActiveCall = (barberId) => {
  if (!barberId) return null;
  return pruneExpiredForBarber(String(barberId));
};

export const clearActiveCall = (barberId) => {
  if (!barberId) return;
  const key = String(barberId);
  const current = activeCallsByBarberId.get(key);
  if (current?.callSid) {
    barberIdByCallSid.delete(current.callSid);
  }
  activeCallsByBarberId.delete(key);
};

export const clearActiveCallBySid = (callSid) => {
  if (!callSid) return;
  const sid = String(callSid);
  const barberId = barberIdByCallSid.get(sid);
  barberIdByCallSid.delete(sid);
  if (barberId) {
    activeCallsByBarberId.delete(barberId);
  }
};
