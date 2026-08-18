import type { Migration } from "./runner.js";

// Fixes a real, live registration-breaking bug, found empirically (not
// hypothetically) while re-verifying Task 1's WebAuthn data-layer fix
// round: the actual `users` table on this codebase's real shared/live
// Postgres still carries a legacy `id SERIAL PRIMARY KEY` column and an
// `api_key TEXT NOT NULL UNIQUE` column that predate db.ts's current
// `createSchema()` baseline (`username TEXT PRIMARY KEY, password_hash
// TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()` -- no id,
// no api_key). Because createSchema() only ever does `CREATE TABLE IF NOT
// EXISTS users (...)`, it can never retroactively narrow an
// already-existing `users` table's shape on a deployment that predates
// that baseline -- this legacy NOT NULL constraint on api_key has been
// silently sitting there ever since.
//
// users-repo.ts's createUser() (both on this branch, after reverting
// Task 1's incorrect "fix", AND on the currently-deployed production
// container -- verified directly by reading
// /app/dist/kernel/state/users-repo.js inside the running jarvis-os-api
// container) does `INSERT INTO users (username, password_hash) VALUES
// ($1, $2)`, never supplying api_key. Against a `users` table carrying
// this legacy NOT NULL constraint, EVERY such INSERT throws `null value
// in column "api_key" ... violates not-null constraint` -- meaning
// /api/register has been failing for every real new-user registration
// attempt on the live deployment (verified live, not simulated: this
// migration was written after directly querying the real shared Postgres
// and reproducing the failure against it). auth-routes.ts's /api/register
// handler catches this into a generic 503 AFTER redeemInvite() has
// already burned the caller's single-use invite token.
//
// `api_key` is confirmed dead / unreferenced anywhere in the current
// codebase (`grep -rn "api_key" src --include=*.ts`, excluding the
// unrelated `api_keys` table and `system_settings.local_api_key`, returns
// only auth-routes.ts's JSON response FIELD NAME "api_key" -- the raw key
// string returned to the caller, which always comes from api_keys.key via
// createApiKey()/getUsernameByApiKey(), never from users.api_key). Every
// real authentication path already reads/writes the separate `api_keys`
// table exclusively.
//
// Deliberately just DROP NOT NULL, not DROP COLUMN: the column still
// holds real historical values for existing rows (harmless, unused dead
// data) and its own UNIQUE constraint tolerates any number of NULLs in
// Postgres, so every future row can simply leave it NULL without any
// uniqueness conflict. Narrower and more conservative than dropping the
// column outright, while still fully unblocking every future INSERT.
// Guarded with an information_schema existence check because a genuinely
// fresh install (created entirely from today's createSchema() baseline)
// never had this column in the first place -- this migration must be a
// no-op there, not throw "column api_key does not exist".
//
// The pre-existing extra `id SERIAL PRIMARY KEY` column on this same
// legacy `users` table is left untouched: it's inert (nothing in the
// current codebase reads or writes it, and `ON CONFLICT (username)` still
// works fine because `username` also carries its own UNIQUE constraint,
// independent of which column is the table's actual primary key), and
// removing a real PRIMARY KEY from a live table with real rows is a
// separate, higher-risk change than the one actually blocking
// registration -- not something to bundle into the same migration as the
// one urgent fix this migration exists to ship.
const migration: Migration = {
  id: "014_drop_legacy_users_api_key_not_null",
  description:
    "Drop the legacy NOT NULL constraint on users.api_key -- a dead, pre-createSchema()-baseline column that createUser() no longer populates, which was silently failing every real registration on any deployment whose users table predates today's schema. No-op on a fresh install where the column never existed.",
  up: async (client) => {
    const { rowCount } = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'api_key'`
    );
    if (rowCount) {
      await client.query(`ALTER TABLE users ALTER COLUMN api_key DROP NOT NULL;`);
    }
  },
};

export default migration;
