import m001 from "./001_objective_runs.js";
import m002 from "./002_build_request_token_usage.js";

export { runMigrations, computePendingMigrations } from "./runner.js";
export type { Migration } from "./runner.js";

// Declaration order is application order — a later migration may depend on
// an earlier one's schema already existing (e.g. a future migration
// altering objective_runs needs 001 to have run first). Never reorder,
// renumber, or remove an id once it's shipped to a real deployment; add a
// new migration to fix a mistake in an old one, the same way you'd fix any
// other already-shipped code.
export const ALL_MIGRATIONS = [m001, m002];
