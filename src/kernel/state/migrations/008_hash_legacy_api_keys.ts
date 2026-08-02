import crypto from "crypto";
import type { Migration } from "./runner.js";

// Same hash users-repo.ts's hashApiKey() computes — duplicated here (rather
// than imported) because migrations are meant to be frozen, standalone
// snapshots of what they did at the time they ran (see runner.ts's own
// comment: "never renamed or reused, even if later found wrong — fix it
// with a new migration"); importing a repo function that might itself
// change later would silently change what this already-shipped migration
// does on a fresh install versus what it did on a deployment that already
// applied it.
function hashApiKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

// A sha256 hex digest is always exactly 64 lowercase hex characters. This
// codebase's own generateApiKey() produces a very differently-shaped raw
// key (`jarvis_key_<48 hex chars>`, i.e. 60 chars starting with a literal
// prefix), so the two are trivially distinguishable by shape alone.
const HEX64 = /^[0-9a-f]{64}$/;

// The commit that changed api_keys.key to store sha256(rawKey) instead of
// the raw key itself (users-repo.ts's hashApiKey/createApiKey/
// getUsernameByApiKey) only changed what NEW rows look like going forward.
// Any row written before that deploy still holds a raw plaintext API key at
// rest: it sits in the database defeating the entire point of that fix, AND
// (worse) that key silently stops authenticating the moment this deploys —
// getUsernameByApiKey now hashes the incoming key before its lookup, which
// can never match a still-plaintext row. This migration re-keys every such
// legacy row in place, so it becomes both properly hashed at rest AND still
// authenticate-compatible (hash the same raw value the same way, and the
// lookup matches again).
//
// api_keys.key is the table's PRIMARY KEY (db.ts), so this can't be a naive
// per-row UPDATE ... SET key = sha256(key) in raw SQL even if Postgres had
// a built-in sha256 (it doesn't, without the pgcrypto extension this
// deployment doesn't otherwise need) — the hash has to be computed in
// application code, and each row's primary key value has to actually
// change. DELETE the old plaintext-keyed row and INSERT the new
// hash-keyed one, once per legacy row, all inside the single transaction
// runner.ts already wraps this migration's up() in — so this either fully
// applies or fully rolls back, never leaves some rows re-keyed and others
// not.
//
// A raw plaintext key that coincidentally already happens to look like a
// 64-char lowercase hex string (and so gets skipped here, wrongly treated
// as "already migrated") is astronomically unlikely — not worth guarding
// against given this codebase's own key format is nothing like that shape.
const migration: Migration = {
  id: "008_hash_legacy_api_keys",
  description:
    "Re-key any api_keys rows still storing a raw plaintext key (written before the sha256-at-rest fix) so they're hashed the same way createApiKey/getUsernameByApiKey now expect, restoring both at-rest safety and the ability to authenticate.",
  up: async (client) => {
    const { rows } = await client.query<{ key: string; username: string; created_at: Date }>(
      `SELECT key, username, created_at FROM api_keys`
    );
    for (const row of rows) {
      if (HEX64.test(row.key)) continue; // already looks like a sha256 hash — nothing to do
      const hashed = hashApiKey(row.key);
      await client.query(`DELETE FROM api_keys WHERE key = $1`, [row.key]);
      // ON CONFLICT DO NOTHING: the astronomically-unlikely case where two
      // distinct legacy raw keys happen to hash to (or one already legally
      // occupies) the same 64-char value — silently dropping the collision
      // is an acceptable, deliberately-not-engineered-around edge case, not
      // a case this migration needs to resolve cleverly.
      await client.query(
        `INSERT INTO api_keys (key, username, created_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING`,
        [hashed, row.username, row.created_at]
      );
    }
  },
};

export default migration;
