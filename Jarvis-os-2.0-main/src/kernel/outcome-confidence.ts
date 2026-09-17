// Averages the command-proposal and action-ledger success rates when both
// have data, falls back to whichever one has data, and to null (meaning
// "no signal yet," per confidence.ts's calculateOverallConfidence contract)
// when neither does. Kept in its own module, separate from server.ts,
// because server.ts calls app.listen() unconditionally at import time and
// must never be imported from the test process.
export function mergeOutcomeRates(commandRate: number | null, actionRate: number | null): number | null {
  if (commandRate !== null && actionRate !== null) return (commandRate + actionRate) / 2;
  if (commandRate !== null) return commandRate;
  if (actionRate !== null) return actionRate;
  return null;
}
