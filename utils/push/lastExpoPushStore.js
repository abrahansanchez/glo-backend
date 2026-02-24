const lastExpoPushIdByBarber = new Map();

export const setLastExpoPushId = (barberId, expoPushId) => {
  if (!barberId || !expoPushId) return;
  lastExpoPushIdByBarber.set(String(barberId), String(expoPushId));
};

export const getLastExpoPushId = (barberId) => {
  if (!barberId) return null;
  return lastExpoPushIdByBarber.get(String(barberId)) || null;
};
