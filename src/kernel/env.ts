/**
 * `Number(x) || fallback` looks like a safe way to parse an optional numeric
 * env var, but isn't: -1 is truthy in JS, so a misconfigured negative value
 * sails through unchanged. Found for real in the data-retention job's
 * retention-days config, where a negative value would have flipped a prune
 * query's cutoff into the future and deleted every row in the table — this
 * is the shared fix, used everywhere an env-configurable positive integer
 * (a budget, a retention window, a limit) gets parsed.
 */
export function positiveIntegerEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
