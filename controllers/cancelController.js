export const cancelBarber = async (_req, res) => {
  return res.status(404).json({
    error: "ACCOUNT_CANCELLATION_UNAVAILABLE",
  });
};
