import type { Migration } from "./runner.js";

// Backs device-native biometric login (WebAuthn/passkeys) — see
// docs/superpowers/specs/2026-08-17-biometric-login-design.md. One row per
// enrolled device per user; a user can enroll multiple devices, each
// independently revocable.
//
// Deliberately NO foreign key on `username` -> `users(username)`, unlike
// the spec's own literal draft SQL. "admin" (auth-middleware.ts's
// INTERNAL_API_KEY identity) is a synthetic identity that is never an
// actual row in `users` — migration 011_multi_user_oauth.ts already hit
// this exact problem for oauth_tokens.username and dropped the FK there
// for the same reason (see that migration's own comment). The spec
// requires biometric login work for admin as well as personal accounts, so
// the FK as originally drafted would make that goal unreachable. Integrity
// is enforced at the application level instead, the same way oauth_tokens
// already is: every write path always passes an explicit username, either
// "admin" or a genuine `users` row.
const migration: Migration = {
  id: "013_webauthn_credentials",
  description:
    "Add webauthn_credentials for device-native biometric login (WebAuthn/passkeys), one row per enrolled device per user, no FK on username (see 011's identical oauth_tokens precedent — 'admin' is never a real users row).",
  up: async (client) => {
    await client.query(`
      CREATE TABLE webauthn_credentials (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        credential_id TEXT NOT NULL UNIQUE,
        public_key BYTEA NOT NULL,
        counter BIGINT NOT NULL DEFAULT 0,
        device_label TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_used_at TIMESTAMPTZ
      );
    `);
    await client.query(`CREATE INDEX idx_webauthn_credentials_username ON webauthn_credentials(username);`);
  },
};

export default migration;
