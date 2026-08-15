import type { Migration } from "./runner.js";

// Backs multi-user personal accounts (see
// docs/superpowers/specs/2026-08-01-multi-user-personal-brains-design.md).
// oauth_tokens moves from one global row per provider to one row per
// (provider, username) — every existing row (today, at most one: the
// admin's own Calendar connection) is backfilled to 'admin' before the PK
// change, the same backfill convention migration 004 used for the earlier
// per-user scoping fix. invite_tokens backs admin-issued, single-use
// signup links; used_by is set (not deleted) on redemption so it stays a
// record of who used which invite, not just a boolean.
//
// No FK on oauth_tokens.username -> users(username): verified empirically
// against a throwaway Postgres seeded with a pre-migration oauth_tokens row
// (matching the real production shape — one global row, no username
// column) that `ADD CONSTRAINT ... FOREIGN KEY (username) REFERENCES
// users(username)` fails right after the 'admin' backfill, because 'admin'
// is a synthetic identity (auth-middleware.ts's INTERNAL_API_KEY, see also
// users-repo.ts's listUsernames()) and is never an actual row in `users` —
// the same fact migration 004's comment already documents. Integrity here
// is enforced at the application level instead: every write path always
// passes an explicit username, either 'admin' or a genuine `users` row.
const migration: Migration = {
  id: "007_multi_user_oauth",
  description:
    "Scope oauth_tokens to (provider, username) instead of a single global row per provider, backfilling existing rows to 'admin', and add invite_tokens for admin-issued single-use signup links.",
  up: async (client) => {
    await client.query(`ALTER TABLE oauth_tokens ADD COLUMN username TEXT;`);
    await client.query(`UPDATE oauth_tokens SET username = 'admin' WHERE username IS NULL;`);
    await client.query(`ALTER TABLE oauth_tokens ALTER COLUMN username SET NOT NULL;`);
    await client.query(`ALTER TABLE oauth_tokens DROP CONSTRAINT oauth_tokens_pkey;`);
    await client.query(`ALTER TABLE oauth_tokens ADD PRIMARY KEY (provider, username);`);

    // Any row backfilled to 'admin' above was written BEFORE Task 6's
    // token-crypto encryption existed, so its access_token/refresh_token
    // values are still plaintext. getTokens() already fails closed on a
    // plaintext value (decryptToken() can't parse it, returns null, admin
    // shows up as disconnected) — but the plaintext refresh token would
    // otherwise sit in this table, and in every backup taken since, forever,
    // contradicting Task 6's own threat model (protect against a backup
    // leak / compromised query access). It's already unusable to the
    // application, so deleting it is safe: admin just needs to reconnect
    // Google once after this migration runs (see README's upgrade note).
    await client.query(`DELETE FROM oauth_tokens;`);

    await client.query(`
      CREATE TABLE invite_tokens (
        token TEXT PRIMARY KEY,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        used_by TEXT NULL,
        used_at TIMESTAMPTZ NULL
      );
    `);
    await client.query(`CREATE INDEX invite_tokens_expires_idx ON invite_tokens(expires_at);`);
  },
};

export default migration;
