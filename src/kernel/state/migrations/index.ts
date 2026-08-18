import m001 from "./001_objective_runs.js";
import m002 from "./002_build_request_token_usage.js";
import m003 from "./003_system_settings.js";
import m004 from "./004_username_scope_identity_kg.js";
import m005 from "./005_mcp_tool_signature.js";
import m006 from "./006_reward_events.js";
import m007 from "./007_personality_settings.js";
import m008 from "./008_rapport_signals.js";
import m009 from "./009_usage_events.js";
import m010 from "./010_wellbeing_checkins.js";
// 011/012 (not 007/008): this branch's own oauth/api-key migrations were
// renumbered during the merge with main -- main's 007-010 were already
// applied to the live production database (verified directly via
// `SELECT id FROM schema_migrations`) before this branch ever merged, so
// renumbering THIS branch's never-yet-applied 007/008 to continue the
// sequence after them is the safe direction (see runner.ts's own "never
// renumber once shipped" rule -- main's 007-010 are what's shipped).
import m011 from "./011_multi_user_oauth.js";
import m012 from "./012_hash_legacy_api_keys.js";
import m013 from "./013_webauthn_credentials.js";

export { runMigrations, computePendingMigrations } from "./runner.js";
export type { Migration } from "./runner.js";

// Declaration order is application order — a later migration may depend on
// an earlier one's schema already existing (e.g. a future migration
// altering objective_runs needs 001 to have run first). Never reorder,
// renumber, or remove an id once it's shipped to a real deployment; add a
// new migration to fix a mistake in an old one, the same way you'd fix any
// other already-shipped code.
export const ALL_MIGRATIONS = [m001, m002, m003, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013];
