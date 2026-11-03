// Missing snapshots belong to the original single-call/120-second policy.
// Never infer an older call's duration from current process configuration.
export function bridgeDurationSeconds(row) {
  const seconds = row.bridgeDurationSeconds ?? 120;
  if (![120, 300].includes(seconds)) throw Error('INVALID_CALL_DURATION_SNAPSHOT');
  return seconds;
}

export function bridgeDeadline(row, at, upperBound = Infinity) {
  const limit = upperBound === Infinity ? Infinity : +new Date(upperBound);
  const deadline = Math.min(+at + bridgeDurationSeconds(row) * 1000, limit);
  if (!Number.isFinite(deadline) || deadline <= +at) throw Error('INVALID_CALL_DEADLINE');
  return new Date(deadline);
}
