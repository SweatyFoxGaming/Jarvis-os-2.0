# Biometric Login (WebAuthn/Passkeys) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any account (admin or personal) unlock Jarvis with device-native Face ID / Windows Hello / fingerprint via WebAuthn, with password login staying fully intact as the fallback.

**Architecture:** New `webauthn_credentials` Postgres table (one row per enrolled device per user) behind a new `webauthn-repo.ts` data layer; new `webauthn-routes.ts` Express router wrapping `@simplewebauthn/server`'s registration/authentication ceremonies, with the four verification/generation functions injectable (matching this codebase's existing DI pattern in `voice-session.ts`/`scheduler.ts`) so tests can supply fake results instead of fabricating real cryptographic fixtures. Frontend uses `@simplewebauthn/browser` (vendored locally, not CDN-loaded — this is the login gate itself, so it must not silently break if a CDN is unreachable) to drive `navigator.credentials.create()`/`.get()`.

**Tech Stack:** `@simplewebauthn/server` (Node, verified against real v13.3.2 type declarations during planning), `@simplewebauthn/browser` (client, v13.3.0, vendored UMD bundle), existing Express/Postgres/bcrypt stack.

**Spec:** `docs/superpowers/specs/2026-08-17-biometric-login-design.md`

## Global Constraints

- Server never stores or evaluates real biometric data — only a public key per enrolled device (spec's core privacy guarantee).
- `POST /api/webauthn/login-verify` returns the exact same `{ username, api_key }` shape `/api/login` already returns (via `usersRepo.getOrCreateApiKey`) — zero downstream client-code changes beyond how that shape gets produced.
- Password login stays fully intact and unmodified — this is additive only.
- Enrollment routes require an authenticated session (`validateApiKey`); login routes are unauthenticated and rate-limited the same as `/api/login` (`authLimiter`) since a forged assertion attempt is the same credential-guessing class.
- **Deviation from the spec's literal migration draft, resolved during planning:** the spec's `webauthn_credentials.username` column is drafted as `REFERENCES users(username) ON DELETE CASCADE`, but `"admin"` (the operator identity, `auth-middleware.ts`'s `INTERNAL_API_KEY`) is a synthetic identity that is never an actual row in `users` — migration `011_multi_user_oauth.ts` already hit this exact problem with `oauth_tokens.username` and dropped the FK, enforcing validity at the application level instead (every write path always passes an explicit `req.username`, either `"admin"` or a real `users` row). This plan follows that same precedent: no FK on `webauthn_credentials.username`. The spec's own goal ("Available to any account, admin or personal") is unreachable with the FK as literally drafted, so this is a bug-fix against the spec's draft SQL, not a scope change.
- WebAuthn's `rpID` must equal the exact domain the browser used to reach the server, and per-spec, real credentials/attestations require a genuine domain name — a raw IP address (e.g. an untagged Tailscale IP with no MagicDNS name) will not work as an `rpID` in real browsers. This plan derives `rpID`/`expectedOrigin` from each request's own `req.hostname`/`req.protocol`+`req.get('host')` rather than a fixed config value, so it self-adapts to whatever real domain name the browser is actually using (localhost included) — this is a real operational requirement worth surfacing to the user (biometric login needs a real hostname, not a bare IP), not something to silently paper over.

---

### Task 1: Data layer — migration, repo, and challenge tickets

**Files:**
- Create: `src/kernel/state/migrations/013_webauthn_credentials.ts`
- Modify: `src/kernel/state/migrations/index.ts`
- Create: `src/kernel/state/webauthn-repo.ts`
- Create: `src/kernel/state/webauthn-challenge-tickets.ts`
- Modify: `package.json`
- Test: `tests/index.test.ts` (new "WebauthnRepo" and "WebauthnChallengeTickets" categories)

**Interfaces:**
- Produces (used by Task 2/3): `webauthnRepo.insertCredential(username: string, credentialId: string, publicKey: Buffer, counter: number, deviceLabel: string): Promise<void>`; `webauthnRepo.getCredentialById(credentialId: string): Promise<WebauthnCredentialRow | null>`; `webauthnRepo.listCredentialsForUsername(username: string): Promise<WebauthnCredentialRow[]>`; `webauthnRepo.updateCounterAndLastUsed(credentialId: string, newCounter: number): Promise<void>`; `webauthnRepo.deleteCredential(id: number, username: string): Promise<boolean>` (ownership-checked: only deletes if the row's `username` matches, so one user can never delete another's device); `WebauthnCredentialRow` interface with fields `{ id: number, username: string, credential_id: string, public_key: Buffer, counter: number, device_label: string, created_at: Date, last_used_at: Date | null }`.
- Produces: `issueRegistrationChallenge(username: string, challenge: string): void`; `consumeRegistrationChallenge(username: string): string | null`; `issueLoginChallenge(username: string, challenge: string): void`; `consumeLoginChallenge(username: string): string | null` — separate namespaces for registration vs. login so a stale registration challenge can never be replayed as a login challenge or vice versa.

- [ ] **Step 1: Add the new dependencies**

Edit `package.json`'s `"dependencies"` block (currently ends `"web-push": "^3.6.7", "ws": "^8.21.1"`) to insert two new entries in alphabetical position:

```json
    "@simplewebauthn/browser": "^13.3.0",
    "@simplewebauthn/server": "^13.3.2",
```

The full block reads (alphabetical, matching this file's existing order):

```json
  "dependencies": {
    "@google/genai": "*",
    "@modelcontextprotocol/sdk": "^1.29.0",
    "@simplewebauthn/browser": "^13.3.0",
    "@simplewebauthn/server": "^13.3.2",
    "bcryptjs": "^2.4.3",
    "chokidar": "^5.0.0",
    "cookie-parser": "^1.4.7",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "express-rate-limit": "^7.4.0",
    "groq-sdk": "^1.5.0",
    "helmet": "^8.3.0",
    "imapflow": "^1.0.164",
    "ioredis": "^5.4.1",
    "js-yaml": "^5.2.2",
    "nodemailer": "^9.0.3",
    "pg": "^8.12.0",
    "web-push": "^3.6.7",
    "ws": "^8.21.1"
  },
```

Run: `npm install`
Expected: `node_modules/@simplewebauthn/server` and `node_modules/@simplewebauthn/browser` now exist, `package-lock.json` updated.

- [ ] **Step 2: Write the migration**

Create `src/kernel/state/migrations/013_webauthn_credentials.ts`:

```typescript
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
```

- [ ] **Step 3: Register the migration**

Modify `src/kernel/state/migrations/index.ts`. Add the import after `m012`:

```typescript
import m012 from "./012_hash_legacy_api_keys.js";
import m013 from "./013_webauthn_credentials.js";
```

And add `m013` to the end of `ALL_MIGRATIONS`:

```typescript
export const ALL_MIGRATIONS = [m001, m002, m003, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013];
```

- [ ] **Step 4: Write the failing repo tests**

Add to `tests/index.test.ts`. First add this import near the other repo imports (alongside the existing `import * as oauthRepo from "../src/kernel/state/oauth-repo.js";` line):

```typescript
import * as webauthnRepo from "../src/kernel/state/webauthn-repo.js";
import * as webauthnChallengeTickets from "../src/kernel/state/webauthn-challenge-tickets.js";
```

Then add these tests (near the other repo-level tests, e.g. after any existing OAuth-repo-adjacent tests, or as a standalone block):

```typescript
registerTest("WebauthnRepo", "insertCredential + getCredentialById + listCredentialsForUsername round-trip correctly", async () => {
  const username = `webauthn_test_${Date.now()}`;
  await createUser(username, "a-real-password-1234");

  const credentialId = `cred_${Date.now()}`;
  const publicKey = Buffer.from([1, 2, 3, 4, 5]);
  await webauthnRepo.insertCredential(username, credentialId, publicKey, 0, "Test Device");

  const byId = await webauthnRepo.getCredentialById(credentialId);
  if (!byId) throw new Error("WebauthnRepo: expected getCredentialById to find the just-inserted row");
  if (byId.username !== username) throw new Error(`WebauthnRepo: expected username "${username}", got "${byId.username}"`);
  if (!byId.public_key.equals(publicKey)) throw new Error("WebauthnRepo: expected public_key to round-trip exactly");
  if (byId.counter !== 0) throw new Error(`WebauthnRepo: expected counter 0, got ${byId.counter}`);
  if (byId.device_label !== "Test Device") throw new Error(`WebauthnRepo: expected device_label "Test Device", got "${byId.device_label}"`);

  const listed = await webauthnRepo.listCredentialsForUsername(username);
  if (listed.length !== 1 || listed[0].credential_id !== credentialId) {
    throw new Error(`WebauthnRepo: expected exactly one listed credential matching the inserted one, got: ${JSON.stringify(listed)}`);
  }
});

registerTest("WebauthnRepo", "updateCounterAndLastUsed bumps counter and sets last_used_at", async () => {
  const username = `webauthn_test_${Date.now()}_2`;
  await createUser(username, "a-real-password-1234");
  const credentialId = `cred_${Date.now()}_2`;
  await webauthnRepo.insertCredential(username, credentialId, Buffer.from([9]), 0, "Device");

  await webauthnRepo.updateCounterAndLastUsed(credentialId, 42);

  const updated = await webauthnRepo.getCredentialById(credentialId);
  if (!updated) throw new Error("WebauthnRepo: expected the credential to still exist after update");
  if (updated.counter !== 42) throw new Error(`WebauthnRepo: expected counter 42, got ${updated.counter}`);
  if (!updated.last_used_at) throw new Error("WebauthnRepo: expected last_used_at to be set");
});

registerTest("WebauthnRepo", "deleteCredential only succeeds for the owning username, never another user's", async () => {
  const owner = `webauthn_owner_${Date.now()}`;
  const attacker = `webauthn_attacker_${Date.now()}`;
  await createUser(owner, "a-real-password-1234");
  await createUser(attacker, "a-real-password-1234");
  const credentialId = `cred_${Date.now()}_3`;
  await webauthnRepo.insertCredential(owner, credentialId, Buffer.from([7]), 0, "Owner Device");
  const row = await webauthnRepo.getCredentialById(credentialId);
  if (!row) throw new Error("WebauthnRepo: setup failed, credential not found before delete attempts");

  const attackerDeleted = await webauthnRepo.deleteCredential(row.id, attacker);
  if (attackerDeleted !== false) throw new Error("WebauthnRepo: expected deleteCredential to refuse deleting another user's credential");
  const stillThere = await webauthnRepo.getCredentialById(credentialId);
  if (!stillThere) throw new Error("WebauthnRepo: the credential must still exist after a rejected cross-user delete attempt");

  const ownerDeleted = await webauthnRepo.deleteCredential(row.id, owner);
  if (ownerDeleted !== true) throw new Error("WebauthnRepo: expected deleteCredential to succeed for the real owner");
  const goneNow = await webauthnRepo.getCredentialById(credentialId);
  if (goneNow) throw new Error("WebauthnRepo: expected the credential to be gone after the owner's own delete");
});

registerTest("WebauthnChallengeTickets", "registration and login challenges live in separate namespaces and are single-use", async () => {
  const username = `webauthn_ticket_user_${Date.now()}`;

  webauthnChallengeTickets.issueRegistrationChallenge(username, "reg-challenge-abc");
  webauthnChallengeTickets.issueLoginChallenge(username, "login-challenge-xyz");

  // A login consume must never see the registration challenge, and vice versa.
  const loginResult = webauthnChallengeTickets.consumeLoginChallenge(username);
  if (loginResult !== "login-challenge-xyz") {
    throw new Error(`WebauthnChallengeTickets: expected the login-namespaced challenge, got: ${JSON.stringify(loginResult)}`);
  }
  const regResult = webauthnChallengeTickets.consumeRegistrationChallenge(username);
  if (regResult !== "reg-challenge-abc") {
    throw new Error(`WebauthnChallengeTickets: expected the registration-namespaced challenge, got: ${JSON.stringify(regResult)}`);
  }

  // Single-use: a second consume of either must now return null.
  if (webauthnChallengeTickets.consumeLoginChallenge(username) !== null) {
    throw new Error("WebauthnChallengeTickets: expected a second consumeLoginChallenge to return null (single-use)");
  }
  if (webauthnChallengeTickets.consumeRegistrationChallenge(username) !== null) {
    throw new Error("WebauthnChallengeTickets: expected a second consumeRegistrationChallenge to return null (single-use)");
  }
});

registerTest("WebauthnChallengeTickets", "consuming a challenge for a username that never issued one returns null, not a throw", async () => {
  const result = webauthnChallengeTickets.consumeLoginChallenge(`never_issued_${Date.now()}`);
  if (result !== null) throw new Error(`WebauthnChallengeTickets: expected null for an unissued username, got: ${JSON.stringify(result)}`);
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -A 2 "WebauthnRepo\|WebauthnChallengeTickets"`
Expected: Module-not-found style failures (`webauthn-repo.js`/`webauthn-challenge-tickets.js` don't exist yet).

- [ ] **Step 6: Implement webauthn-repo.ts**

Create `src/kernel/state/webauthn-repo.ts`:

```typescript
import { getPool } from "./db.js";

export interface WebauthnCredentialRow {
  id: number;
  username: string;
  credential_id: string;
  public_key: Buffer;
  counter: number;
  device_label: string;
  created_at: Date;
  last_used_at: Date | null;
}

export async function insertCredential(
  username: string,
  credentialId: string,
  publicKey: Buffer,
  counter: number,
  deviceLabel: string
): Promise<void> {
  const db = getPool();
  await db.query(
    `INSERT INTO webauthn_credentials (username, credential_id, public_key, counter, device_label)
     VALUES ($1, $2, $3, $4, $5)`,
    [username, credentialId, publicKey, counter, deviceLabel]
  );
}

export async function getCredentialById(credentialId: string): Promise<WebauthnCredentialRow | null> {
  const db = getPool();
  const { rows } = await db.query(`SELECT * FROM webauthn_credentials WHERE credential_id = $1`, [credentialId]);
  return rows[0] ?? null;
}

export async function listCredentialsForUsername(username: string): Promise<WebauthnCredentialRow[]> {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT * FROM webauthn_credentials WHERE username = $1 ORDER BY created_at ASC`,
    [username]
  );
  return rows;
}

export async function updateCounterAndLastUsed(credentialId: string, newCounter: number): Promise<void> {
  const db = getPool();
  await db.query(
    `UPDATE webauthn_credentials SET counter = $2, last_used_at = now() WHERE credential_id = $1`,
    [credentialId, newCounter]
  );
}

// Ownership-checked in the SQL itself (WHERE id = $1 AND username = $2),
// not via a separate SELECT-then-DELETE — closes the same TOCTOU class
// createUser's own comment documents elsewhere in this codebase. Returns
// false both when the row doesn't exist and when it belongs to a
// different username, which is exactly the "you may not touch this" signal
// the route layer needs; it never distinguishes the two, so a caller can't
// probe for another user's credential IDs by observing the response.
export async function deleteCredential(id: number, username: string): Promise<boolean> {
  const db = getPool();
  const { rowCount } = await db.query(
    `DELETE FROM webauthn_credentials WHERE id = $1 AND username = $2`,
    [id, username]
  );
  return (rowCount ?? 0) > 0;
}
```

- [ ] **Step 7: Implement webauthn-challenge-tickets.ts**

Create `src/kernel/state/webauthn-challenge-tickets.ts`:

```typescript
// Short-lived, single-use WebAuthn ceremony challenges, keyed by username
// rather than a random opaque ticket — unlike oauth-state-tickets.ts (which
// needs an opaque token because a real browser redirect loses all other
// context), a WebAuthn ceremony is a synchronous same-page exchange: the
// caller already knows (or, for login, just supplied) the username at both
// the options-generation and verify steps, so the username itself is
// sufficient as the correlation key. Two entirely separate maps (not one
// map with a purpose field) so a registration challenge can never be
// consumed as a login challenge or vice versa, by construction rather than
// by an extra runtime check.
//
// A generous-but-bounded TTL: a WebAuthn ceremony is a real OS-level
// prompt (Face ID / Windows Hello dialog) that can take a few seconds
// longer than oauth-state-tickets.ts's redirect-carrying use case, but
// must not sit valid indefinitely if the user abandons it.
const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const MAX_TICKETS = 1000;

interface ChallengeEntry {
  challenge: string;
  expiresAt: number;
}

const registrationChallenges = new Map<string, ChallengeEntry>();
const loginChallenges = new Map<string, ChallengeEntry>();

function issue(map: Map<string, ChallengeEntry>, username: string, challenge: string): void {
  const now = Date.now();
  for (const [k, v] of map) {
    if (v.expiresAt < now) map.delete(k); // opportunistic sweep, same pattern as oauth-state-tickets.ts
  }
  if (map.size >= MAX_TICKETS) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
  map.set(username, { challenge, expiresAt: now + CHALLENGE_TTL_MS });
}

function consume(map: Map<string, ChallengeEntry>, username: string): string | null {
  const entry = map.get(username);
  map.delete(username); // single-use regardless of outcome
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.challenge;
}

export function issueRegistrationChallenge(username: string, challenge: string): void {
  issue(registrationChallenges, username, challenge);
}

export function consumeRegistrationChallenge(username: string): string | null {
  return consume(registrationChallenges, username);
}

export function issueLoginChallenge(username: string, challenge: string): void {
  issue(loginChallenges, username, challenge);
}

export function consumeLoginChallenge(username: string): string | null {
  return consume(loginChallenges, username);
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx tsc --noEmit && npm test 2>&1 | grep -A 2 "WebauthnRepo\|WebauthnChallengeTickets"`
Expected: all 5 new tests PASS, `tsc` clean.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json src/kernel/state/migrations/013_webauthn_credentials.ts src/kernel/state/migrations/index.ts src/kernel/state/webauthn-repo.ts src/kernel/state/webauthn-challenge-tickets.ts tests/index.test.ts
git commit -m "feat: webauthn data layer — migration, credential repo, challenge tickets"
```

---

### Task 2: Registration routes + server.ts wiring

**Files:**
- Create: `src/interaction/routes/webauthn-routes.ts`
- Modify: `src/server.ts`
- Test: `tests/index.test.ts` (new "WebauthnRoutes" category, registration tests)

**Interfaces:**
- Consumes: `webauthnRepo.insertCredential`/`getCredentialById`/`listCredentialsForUsername`/`updateCounterAndLastUsed`/`deleteCredential` (Task 1); `webauthnChallengeTickets.issueRegistrationChallenge`/`consumeRegistrationChallenge`/`issueLoginChallenge`/`consumeLoginChallenge` (Task 1); `usersRepo.getOrCreateApiKey`, `usersRepo.listUsernames` (existing); `validateApiKey` (existing, `src/kernel/auth-middleware.ts`).
- Produces (used by Task 3, and by server.ts): `createWebauthnRouter(deps?: Partial<WebauthnRouteDeps>): Router` — a factory, not a pre-built router, so tests can inject fake `@simplewebauthn/server` functions instead of needing real cryptographic fixtures. `WebauthnRouteDeps` interface: `{ generateRegistrationOptions: typeof generateRegistrationOptions; verifyRegistrationResponse: typeof verifyRegistrationResponse; generateAuthenticationOptions: typeof generateAuthenticationOptions; verifyAuthenticationResponse: typeof verifyAuthenticationResponse }`. Routes built in this task: `POST /api/webauthn/register-options`, `POST /api/webauthn/register-verify`. (Login/list/delete routes are added to the same router in Task 3 — same file, same factory, extended not duplicated.)

- [ ] **Step 1: Write the failing registration-route tests**

Add to `tests/index.test.ts`, near the top imports:

```typescript
import express from "express";
import { createWebauthnRouter } from "../src/interaction/routes/webauthn-routes.js";
```

(`express` is already a project dependency — this is the first test file to construct its own minimal app rather than spawning the full server subprocess, which is necessary here because DI-injected fake `@simplewebauthn/server` functions are plain JS references that cannot cross a subprocess boundary the way `spawnTestServer`'s env-var overrides do.)

Add a shared helper near the top of the test file's helper section (wherever `spawnTestServer`/`stopTestServer` are defined) — a lightweight in-process app+listener for exactly this kind of DI'd-router test:

```typescript
// Lightweight in-process alternative to spawnTestServer for testing a
// single router with injected fake dependencies — spawnTestServer starts a
// genuinely separate Node process, so DI overrides (plain JS function
// references, not env vars) can never reach it. Mounts real
// validateApiKey/authLimiter middleware (both already real, DB-backed —
// only the @simplewebauthn/server calls need faking), listens on an
// ephemeral port, and returns both the base URL and a close() to tear it
// down.
async function startRouterOnEphemeralPort(router: express.Router): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(router);
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}
```

Then add the registration tests:

```typescript
registerTest("WebauthnRoutes", "register-options requires authentication", async () => {
  const router = createWebauthnRouter();
  const { baseUrl, close } = await startRouterOnEphemeralPort(router);
  try {
    const res = await fetch(`${baseUrl}/api/webauthn/register-options`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (res.status !== 401) throw new Error(`WebauthnRoutes: expected 401 with no API key, got ${res.status}`);
  } finally {
    await close();
  }
});

registerTest("WebauthnRoutes", "register-options returns a real challenge for an authenticated user, and register-verify inserts a credential on a valid response", async () => {
  const username = `webauthn_route_user_${Date.now()}`;
  const apiKey = await createUser(username, "a-real-password-1234");

  let capturedRegOptsCall: any = null;
  let capturedVerifyCall: any = null;
  const router = createWebauthnRouter({
    generateRegistrationOptions: (async (opts: any) => {
      capturedRegOptsCall = opts;
      return { challenge: "fake-challenge-value", rp: { id: opts.rpID, name: opts.rpName }, user: { id: "fake-user-id", name: opts.userName, displayName: opts.userName } };
    }) as any,
    verifyRegistrationResponse: (async (opts: any) => {
      capturedVerifyCall = opts;
      return {
        verified: true,
        registrationInfo: {
          credential: { id: "fake-credential-id", publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] },
        },
      };
    }) as any,
  });
  const { baseUrl, close } = await startRouterOnEphemeralPort(router);
  try {
    const optsRes = await fetch(`${baseUrl}/api/webauthn/register-options`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    });
    if (optsRes.status !== 200) throw new Error(`WebauthnRoutes: expected 200 from register-options, got ${optsRes.status}`);
    const optsBody = await optsRes.json();
    if (optsBody.challenge !== "fake-challenge-value") throw new Error(`WebauthnRoutes: expected the generated challenge in the response, got: ${JSON.stringify(optsBody)}`);
    if (capturedRegOptsCall?.userName !== username) throw new Error(`WebauthnRoutes: expected generateRegistrationOptions called with userName="${username}", got: ${JSON.stringify(capturedRegOptsCall)}`);

    const verifyRes = await fetch(`${baseUrl}/api/webauthn/register-verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ response: { id: "fake-credential-id" }, deviceLabel: "My Test Phone" }),
    });
    if (verifyRes.status !== 200) throw new Error(`WebauthnRoutes: expected 200 from register-verify, got ${verifyRes.status}: ${await verifyRes.text()}`);
    if (capturedVerifyCall?.expectedChallenge !== "fake-challenge-value") {
      throw new Error(`WebauthnRoutes: expected register-verify to pass the previously-issued challenge to verifyRegistrationResponse, got: ${JSON.stringify(capturedVerifyCall)}`);
    }

    const stored = await webauthnRepo.getCredentialById("fake-credential-id");
    if (!stored) throw new Error("WebauthnRoutes: expected a real webauthn_credentials row after a successful register-verify");
    if (stored.username !== username) throw new Error(`WebauthnRoutes: expected the stored credential's username to be "${username}", got "${stored.username}"`);
    if (stored.device_label !== "My Test Phone") throw new Error(`WebauthnRoutes: expected device_label "My Test Phone", got "${stored.device_label}"`);
  } finally {
    await close();
  }
});

registerTest("WebauthnRoutes", "register-verify returns 400 when verification fails (e.g. expired/mismatched challenge), and inserts nothing", async () => {
  const username = `webauthn_route_fail_user_${Date.now()}`;
  const apiKey = await createUser(username, "a-real-password-1234");

  const router = createWebauthnRouter({
    generateRegistrationOptions: (async (opts: any) => ({ challenge: "another-challenge", rp: { id: opts.rpID, name: opts.rpName }, user: { id: "x", name: opts.userName, displayName: opts.userName } })) as any,
    verifyRegistrationResponse: (async () => ({ verified: false })) as any,
  });
  const { baseUrl, close } = await startRouterOnEphemeralPort(router);
  try {
    await fetch(`${baseUrl}/api/webauthn/register-options`, { method: "POST", headers: { "X-API-Key": apiKey } });
    const verifyRes = await fetch(`${baseUrl}/api/webauthn/register-verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ response: { id: "should-not-be-stored" }, deviceLabel: "Device" }),
    });
    if (verifyRes.status !== 400) throw new Error(`WebauthnRoutes: expected 400 on failed verification, got ${verifyRes.status}`);
    const stored = await webauthnRepo.getCredentialById("should-not-be-stored");
    if (stored) throw new Error("WebauthnRoutes: expected NO credential row to be inserted after a failed verification");
  } finally {
    await close();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: fails — `../src/interaction/routes/webauthn-routes.js` doesn't exist yet.

- [ ] **Step 3: Implement webauthn-routes.ts (registration half)**

Create `src/interaction/routes/webauthn-routes.ts`:

```typescript
import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  generateRegistrationOptions as realGenerateRegistrationOptions,
  verifyRegistrationResponse as realVerifyRegistrationResponse,
  generateAuthenticationOptions as realGenerateAuthenticationOptions,
  verifyAuthenticationResponse as realVerifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import * as webauthnRepo from "../../kernel/state/webauthn-repo.js";
import * as webauthnChallengeTickets from "../../kernel/state/webauthn-challenge-tickets.js";
import * as usersRepo from "../../kernel/state/users-repo.js";
import { ObservationPlatform } from "../../kernel/observation.js";

const observation = ObservationPlatform.getInstance();

// Injectable so tests can supply fake generate/verify results instead of
// fabricating real WebAuthn cryptographic fixtures (COSE keys, CBOR
// attestation objects, real signatures) by hand — matches this codebase's
// existing DI pattern (voice-session.ts's VoiceSessionDeps,
// scheduler.ts's injectable fetchRecentMessages). The real
// @simplewebauthn/server functions are themselves extensively tested
// upstream; this router's own job — correctly wiring challenges, storing
// results, checking ownership — is what these tests actually exercise.
export interface WebauthnRouteDeps {
  generateRegistrationOptions: typeof realGenerateRegistrationOptions;
  verifyRegistrationResponse: typeof realVerifyRegistrationResponse;
  generateAuthenticationOptions: typeof realGenerateAuthenticationOptions;
  verifyAuthenticationResponse: typeof realVerifyAuthenticationResponse;
}

const defaultDeps: WebauthnRouteDeps = {
  generateRegistrationOptions: realGenerateRegistrationOptions,
  verifyRegistrationResponse: realVerifyRegistrationResponse,
  generateAuthenticationOptions: realGenerateAuthenticationOptions,
  verifyAuthenticationResponse: realVerifyAuthenticationResponse,
};

// Same 20-per-15-minutes budget auth-routes.ts's authLimiter uses for
// /api/login — a forged assertion attempt against login-verify is the
// identical credential-guessing class that limiter exists for.
const webauthnLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts, try again later" },
});

// rpID must equal the exact domain the browser used to reach the server —
// derived per-request (req.hostname strips any port; req.protocol +
// req.get('host') keeps it for the origin check) rather than a fixed
// config value, so this self-adapts to whatever real hostname is actually
// serving the page (a Tailscale MagicDNS name, localhost, etc.) instead of
// risking a mismatch against a separately-configured value. Real browsers
// require rpID to be a genuine domain name — a bare IP address will not
// work; this is a real operational constraint of WebAuthn itself, not a
// gap in this code.
function currentRpId(req: any): string {
  return req.hostname;
}
function currentOrigin(req: any): string {
  return `${req.protocol}://${req.get("host")}`;
}

export function createWebauthnRouter(depsOverride: Partial<WebauthnRouteDeps> = {}): Router {
  const deps: WebauthnRouteDeps = { ...defaultDeps, ...depsOverride };
  const router = Router();

  router.post("/api/webauthn/register-options", validateApiKey, async (req: any, res: any) => {
    try {
      const existing = await webauthnRepo.listCredentialsForUsername(req.username);
      const options = await deps.generateRegistrationOptions({
        rpName: "Jarvis",
        rpID: currentRpId(req),
        userName: req.username,
        excludeCredentials: existing.map((c) => ({ id: c.credential_id })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      });
      webauthnChallengeTickets.issueRegistrationChallenge(req.username, options.challenge);
      res.json(options);
    } catch (err: any) {
      observation.logTelemetry("warn", "Webauthn", `register-options failed for "${req.username}": ${err.message}`);
      res.status(503).json({ error: "Couldn't start device registration — try again." });
    }
  });

  router.post("/api/webauthn/register-verify", validateApiKey, async (req: any, res: any) => {
    const { response, deviceLabel } = req.body || {};
    if (!response || typeof deviceLabel !== "string" || !deviceLabel.trim()) {
      return res.status(400).json({ error: "A registration response and device label are required." });
    }
    const expectedChallenge = webauthnChallengeTickets.consumeRegistrationChallenge(req.username);
    if (!expectedChallenge) {
      return res.status(400).json({ error: "That didn't complete in time, try again." });
    }
    try {
      const result = await deps.verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: currentOrigin(req),
        expectedRPID: currentRpId(req),
      });
      if (!result.verified || !result.registrationInfo) {
        return res.status(400).json({ error: "That didn't complete in time, try again." });
      }
      const { credential } = result.registrationInfo;
      await webauthnRepo.insertCredential(
        req.username,
        credential.id,
        Buffer.from(credential.publicKey),
        credential.counter,
        deviceLabel.trim()
      );
      observation.logAuditEvent(req.username, "webauthn-register", "success", `Enrolled device "${deviceLabel.trim()}"`);
      res.json({ ok: true });
    } catch (err: any) {
      observation.logTelemetry("warn", "Webauthn", `register-verify failed for "${req.username}": ${err.message}`);
      res.status(400).json({ error: "That didn't complete in time, try again." });
    }
  });

  return router;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsc --noEmit && npm test 2>&1 | grep -A 2 "WebauthnRoutes"`
Expected: all 3 new tests PASS, `tsc` clean.

- [ ] **Step 5: Wire into server.ts**

Modify `src/server.ts`. Add the import alongside the other route imports (near `import { authRouter } from "./interaction/routes/auth-routes.js";`):

```typescript
import { createWebauthnRouter } from "./interaction/routes/webauthn-routes.js";
```

Add the mount alongside the other `app.use(...Router)` calls (near `app.use(authRouter);`):

```typescript
app.use(createWebauthnRouter());
```

- [ ] **Step 6: Run the full suite to confirm no regressions**

Run: `npx tsc --noEmit && npm test 2>&1 | tail -10`
Expected: same pass count as before plus the new tests, no new failures.

- [ ] **Step 7: Commit**

```bash
git add src/interaction/routes/webauthn-routes.ts src/server.ts tests/index.test.ts
git commit -m "feat: webauthn registration routes (register-options, register-verify)"
```

---

### Task 3: Login routes + credential management routes

**Files:**
- Modify: `src/interaction/routes/webauthn-routes.ts`
- Test: `tests/index.test.ts` (more "WebauthnRoutes" tests)

**Interfaces:**
- Consumes: everything from Task 2 (same file, same `createWebauthnRouter` factory — this task extends it, not a new router).
- Produces: `POST /api/webauthn/login-options` (unauthenticated, rate-limited), `POST /api/webauthn/login-verify` (unauthenticated, rate-limited, returns `{username, api_key}` on success), `GET /api/webauthn/credentials` (authenticated, lists the caller's own enrolled devices), `DELETE /api/webauthn/credentials/:id` (authenticated, ownership-checked).

- [ ] **Step 1: Write the failing login/management-route tests**

Add to `tests/index.test.ts`:

```typescript
registerTest("WebauthnRoutes", "login-options reports hasCredentials:false for a user with none enrolled, without erroring", async () => {
  const username = `webauthn_nocred_user_${Date.now()}`;
  await createUser(username, "a-real-password-1234");
  const router = createWebauthnRouter();
  const { baseUrl, close } = await startRouterOnEphemeralPort(router);
  try {
    const res = await fetch(`${baseUrl}/api/webauthn/login-options`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    });
    if (res.status !== 200) throw new Error(`WebauthnRoutes: expected 200 even with zero enrolled credentials, got ${res.status}`);
    const body = await res.json();
    if (body.hasCredentials !== false) throw new Error(`WebauthnRoutes: expected hasCredentials:false, got: ${JSON.stringify(body)}`);
  } finally {
    await close();
  }
});

registerTest("WebauthnRoutes", "a full login round trip: options scoped to the user's real credential, verify returns {username, api_key}, counter updates", async () => {
  const username = `webauthn_login_user_${Date.now()}`;
  await createUser(username, "a-real-password-1234");
  await webauthnRepo.insertCredential(username, "real-login-cred-id", Buffer.from([5, 5, 5]), 3, "Laptop");

  let capturedAllowCredentials: any = null;
  let capturedVerifyDeps: any = null;
  const router = createWebauthnRouter({
    generateAuthenticationOptions: (async (opts: any) => {
      capturedAllowCredentials = opts.allowCredentials;
      return { challenge: "login-challenge-value", rpId: opts.rpID };
    }) as any,
    verifyAuthenticationResponse: (async (opts: any) => {
      capturedVerifyDeps = opts;
      return { verified: true, authenticationInfo: { newCounter: 4 } };
    }) as any,
  });
  const { baseUrl, close } = await startRouterOnEphemeralPort(router);
  try {
    const optsRes = await fetch(`${baseUrl}/api/webauthn/login-options`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username }),
    });
    const optsBody = await optsRes.json();
    if (optsBody.hasCredentials !== true) throw new Error(`WebauthnRoutes: expected hasCredentials:true, got: ${JSON.stringify(optsBody)}`);
    if (!Array.isArray(capturedAllowCredentials) || capturedAllowCredentials[0]?.id !== "real-login-cred-id") {
      throw new Error(`WebauthnRoutes: expected allowCredentials scoped to the user's real credential id, got: ${JSON.stringify(capturedAllowCredentials)}`);
    }

    const verifyRes = await fetch(`${baseUrl}/api/webauthn/login-verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, response: { id: "real-login-cred-id" } }),
    });
    if (verifyRes.status !== 200) throw new Error(`WebauthnRoutes: expected 200 from login-verify, got ${verifyRes.status}: ${await verifyRes.text()}`);
    const verifyBody = await verifyRes.json();
    if (verifyBody.username !== username || typeof verifyBody.api_key !== "string" || !verifyBody.api_key) {
      throw new Error(`WebauthnRoutes: expected {username, api_key} matching /api/login's shape, got: ${JSON.stringify(verifyBody)}`);
    }
    if (capturedVerifyDeps?.credential?.id !== "real-login-cred-id" || capturedVerifyDeps?.credential?.counter !== 3) {
      throw new Error(`WebauthnRoutes: expected verifyAuthenticationResponse called with the STORED credential (id + counter 3), got: ${JSON.stringify(capturedVerifyDeps?.credential)}`);
    }

    const updated = await webauthnRepo.getCredentialById("real-login-cred-id");
    if (updated?.counter !== 4) throw new Error(`WebauthnRoutes: expected counter updated to 4 after login, got ${updated?.counter}`);
    if (!updated?.last_used_at) throw new Error("WebauthnRoutes: expected last_used_at to be set after login");
  } finally {
    await close();
  }
});

registerTest("WebauthnRoutes", "login-verify returns a generic 401 on a failed verification, revealing nothing specific", async () => {
  const username = `webauthn_login_fail_user_${Date.now()}`;
  await createUser(username, "a-real-password-1234");
  await webauthnRepo.insertCredential(username, "will-fail-cred-id", Buffer.from([1]), 0, "Device");
  const router = createWebauthnRouter({
    generateAuthenticationOptions: (async (opts: any) => ({ challenge: "c", rpId: opts.rpID })) as any,
    verifyAuthenticationResponse: (async () => ({ verified: false, authenticationInfo: { newCounter: 0 } })) as any,
  });
  const { baseUrl, close } = await startRouterOnEphemeralPort(router);
  try {
    await fetch(`${baseUrl}/api/webauthn/login-options`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username }) });
    const res = await fetch(`${baseUrl}/api/webauthn/login-verify`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, response: { id: "will-fail-cred-id" } }),
    });
    if (res.status !== 401) throw new Error(`WebauthnRoutes: expected 401 on failed verification, got ${res.status}`);
    const body = await res.json();
    if (body.error !== "Invalid credentials") throw new Error(`WebauthnRoutes: expected the same generic "Invalid credentials" message /api/login uses, got: ${JSON.stringify(body)}`);
  } finally {
    await close();
  }
});

registerTest("WebauthnRoutes", "login-verify rejects an assertion whose credential id belongs to a DIFFERENT user than the claimed username", async () => {
  const realOwner = `webauthn_real_owner_${Date.now()}`;
  const claimedUsername = `webauthn_claimed_${Date.now()}`;
  await createUser(realOwner, "a-real-password-1234");
  await createUser(claimedUsername, "a-real-password-1234");
  await webauthnRepo.insertCredential(realOwner, "belongs-to-real-owner", Buffer.from([1]), 0, "Device");

  const router = createWebauthnRouter({
    generateAuthenticationOptions: (async (opts: any) => ({ challenge: "c", rpId: opts.rpID })) as any,
    // The route's ownership check (storedCredential.username !== username)
    // must reject BEFORE ever calling verifyAuthenticationResponse — this
    // fake returning verified:true proves that: if the route incorrectly
    // called it anyway for a mismatched-owner credential, this test would
    // wrongly see a 200 instead of the expected 401.
    verifyAuthenticationResponse: (async () => ({ verified: true, authenticationInfo: { newCounter: 1 } })) as any,
  });
  const { baseUrl, close } = await startRouterOnEphemeralPort(router);
  try {
    await fetch(`${baseUrl}/api/webauthn/login-options`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: claimedUsername }) });
    const res = await fetch(`${baseUrl}/api/webauthn/login-verify`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: claimedUsername, response: { id: "belongs-to-real-owner" } }),
    });
    if (res.status !== 401) throw new Error(`WebauthnRoutes: expected 401 when the credential belongs to a different user, got ${res.status}`);
  } finally {
    await close();
  }
});

registerTest("WebauthnRoutes", "GET /api/webauthn/credentials lists only the caller's own devices; DELETE is ownership-checked", async () => {
  const alice = `webauthn_alice_${Date.now()}`;
  const bob = `webauthn_bob_${Date.now()}`;
  const aliceKey = await createUser(alice, "a-real-password-1234");
  const bobKey = await createUser(bob, "a-real-password-1234");
  await webauthnRepo.insertCredential(alice, `alice-cred-${Date.now()}`, Buffer.from([1]), 0, "Alice's Phone");
  await webauthnRepo.insertCredential(bob, `bob-cred-${Date.now()}`, Buffer.from([2]), 0, "Bob's Phone");

  const router = createWebauthnRouter();
  const { baseUrl, close } = await startRouterOnEphemeralPort(router);
  try {
    const listRes = await fetch(`${baseUrl}/api/webauthn/credentials`, { headers: { "X-API-Key": aliceKey } });
    const listBody = await listRes.json();
    if (!Array.isArray(listBody) || listBody.length !== 1 || listBody[0].device_label !== "Alice's Phone") {
      throw new Error(`WebauthnRoutes: expected only Alice's own device listed, got: ${JSON.stringify(listBody)}`);
    }
    const bobList = await (await fetch(`${baseUrl}/api/webauthn/credentials`, { headers: { "X-API-Key": bobKey } })).json();
    const bobsRealId = bobList[0].id;

    const crossDeleteRes = await fetch(`${baseUrl}/api/webauthn/credentials/${bobsRealId}`, { method: "DELETE", headers: { "X-API-Key": aliceKey } });
    if (crossDeleteRes.status !== 404) throw new Error(`WebauthnRoutes: expected 404 when deleting another user's device, got ${crossDeleteRes.status}`);
    const stillThere = await webauthnRepo.listCredentialsForUsername(bob);
    if (stillThere.length !== 1) throw new Error("WebauthnRoutes: Bob's device must still exist after Alice's rejected delete attempt");

    const ownDeleteRes = await fetch(`${baseUrl}/api/webauthn/credentials/${bobsRealId}`, { method: "DELETE", headers: { "X-API-Key": bobKey } });
    if (ownDeleteRes.status !== 200) throw new Error(`WebauthnRoutes: expected 200 when Bob deletes his own device, got ${ownDeleteRes.status}`);
    const goneNow = await webauthnRepo.listCredentialsForUsername(bob);
    if (goneNow.length !== 0) throw new Error("WebauthnRoutes: expected Bob's device gone after his own delete");
  } finally {
    await close();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -B1 -A2 "login-options\|login-verify\|credentials lists"`
Expected: 404s / failures — the routes don't exist yet.

- [ ] **Step 3: Implement the login and credential-management routes**

Modify `src/interaction/routes/webauthn-routes.ts` — add these routes inside `createWebauthnRouter`, after the `register-verify` route and before the final `return router;`:

```typescript
  router.post("/api/webauthn/login-options", webauthnLoginLimiter, async (req: any, res: any) => {
    const { username } = req.body || {};
    if (typeof username !== "string" || !username.trim()) {
      return res.status(400).json({ error: "Username is required." });
    }
    try {
      const existing = await webauthnRepo.listCredentialsForUsername(username);
      if (existing.length === 0) {
        // Not an error — an expected, common case (this account has no
        // enrolled device yet). The client falls through to the password
        // form; see the spec's "silently fall through" error-handling rule.
        return res.json({ hasCredentials: false });
      }
      const options = await deps.generateAuthenticationOptions({
        rpID: currentRpId(req),
        allowCredentials: existing.map((c) => ({ id: c.credential_id })),
        userVerification: "preferred",
      });
      webauthnChallengeTickets.issueLoginChallenge(username, options.challenge);
      res.json({ ...options, hasCredentials: true });
    } catch (err: any) {
      observation.logTelemetry("warn", "Webauthn", `login-options failed for "${username}": ${err.message}`);
      res.status(503).json({ error: "Couldn't start sign-in — try again." });
    }
  });

  router.post("/api/webauthn/login-verify", webauthnLoginLimiter, async (req: any, res: any) => {
    const { username, response } = req.body || {};
    if (typeof username !== "string" || !username.trim() || !response) {
      return res.status(400).json({ error: "Username and response are required." });
    }
    const expectedChallenge = webauthnChallengeTickets.consumeLoginChallenge(username);
    if (!expectedChallenge) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    try {
      const credentialId = response.id;
      const storedCredential = typeof credentialId === "string" ? await webauthnRepo.getCredentialById(credentialId) : null;
      // The credential must exist AND belong to the exact username this
      // login-verify call claims — otherwise a signed assertion for
      // attacker's own enrolled device, replayed with a victim's username
      // in the request body, would be accepted as the victim logging in.
      if (!storedCredential || storedCredential.username !== username) {
        observation.logAuditEvent(username, "webauthn-login", "failed", "No matching credential for this username");
        return res.status(401).json({ error: "Invalid credentials" });
      }
      const result = await deps.verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: currentOrigin(req),
        expectedRPID: currentRpId(req),
        credential: {
          id: storedCredential.credential_id,
          publicKey: new Uint8Array(storedCredential.public_key),
          counter: storedCredential.counter,
        },
      });
      if (!result.verified) {
        observation.logAuditEvent(username, "webauthn-login", "failed", "Assertion verification failed");
        return res.status(401).json({ error: "Invalid credentials" });
      }
      await webauthnRepo.updateCounterAndLastUsed(storedCredential.credential_id, result.authenticationInfo.newCounter);
      const apiKey = await usersRepo.getOrCreateApiKey(username);
      observation.logAuditEvent(username, "webauthn-login", "success", `Signed in via device "${storedCredential.device_label}"`);
      res.json({ username, api_key: apiKey });
    } catch (err: any) {
      observation.logTelemetry("warn", "Webauthn", `login-verify failed for "${username}": ${err.message}`);
      res.status(401).json({ error: "Invalid credentials" });
    }
  });

  router.get("/api/webauthn/credentials", validateApiKey, async (req: any, res: any) => {
    try {
      const rows = await webauthnRepo.listCredentialsForUsername(req.username);
      res.json(rows.map((r) => ({ id: r.id, device_label: r.device_label, created_at: r.created_at, last_used_at: r.last_used_at })));
    } catch (err: any) {
      observation.logTelemetry("warn", "Webauthn", `Listing credentials failed for "${req.username}": ${err.message}`);
      res.status(503).json({ error: "Couldn't load your devices — try again." });
    }
  });

  router.delete("/api/webauthn/credentials/:id", validateApiKey, async (req: any, res: any) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid device id." });
    }
    try {
      const deleted = await webauthnRepo.deleteCredential(id, req.username);
      if (!deleted) {
        // Never distinguishes "doesn't exist" from "belongs to someone
        // else" — same reasoning as deleteCredential's own comment.
        return res.status(404).json({ error: "Device not found." });
      }
      observation.logAuditEvent(req.username, "webauthn-revoke", "success", `Removed device id ${id}`);
      res.json({ ok: true });
    } catch (err: any) {
      observation.logTelemetry("warn", "Webauthn", `Deleting credential failed for "${req.username}": ${err.message}`);
      res.status(503).json({ error: "Couldn't remove that device — try again." });
    }
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsc --noEmit && npm test 2>&1 | grep -A2 "WebauthnRoutes"`
Expected: all WebauthnRoutes tests (Task 2 + Task 3, 8 total) PASS.

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `npm test 2>&1 | tail -10`
Expected: same pass/fail baseline as before plus the new tests.

- [ ] **Step 6: Commit**

```bash
git add src/interaction/routes/webauthn-routes.ts tests/index.test.ts
git commit -m "feat: webauthn login routes and self-service credential management"
```

---

### Task 4: Frontend — vendor the browser library, login-screen wiring, account-settings device management

**Files:**
- Create: `src/interaction/static/vendor/simplewebauthn/index.umd.min.js`
- Modify: `src/interaction/static/index.html`

**Interfaces:**
- Consumes: `POST /api/webauthn/login-options`, `POST /api/webauthn/login-verify` (unauthenticated), `POST /api/webauthn/register-options`, `POST /api/webauthn/register-verify`, `GET /api/webauthn/credentials`, `DELETE /api/webauthn/credentials/:id` (authenticated) — all from Tasks 2/3. Global `SimpleWebAuthnBrowser` object (from the vendored bundle) exposing `.browserSupportsWebAuthn()`, `.startRegistration({optionsJSON})`, `.startAuthentication({optionsJSON})`.
- Produces: nothing consumed by a later task — this is the last implementation task.

- [ ] **Step 1: Vendor the browser library**

Run:

```bash
mkdir -p src/interaction/static/vendor/simplewebauthn
cp node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js src/interaction/static/vendor/simplewebauthn/index.umd.min.js
```

This is vendored locally rather than CDN-loaded (unlike `cytoscape` elsewhere in this file) because this is the login gate itself — a CDN outage must never be able to take down the ability to sign in at all. The file is ~9KB minified; re-run this same copy command after any future `npm install @simplewebauthn/browser@<newer>` to update it.

Expected: `src/interaction/static/vendor/simplewebauthn/index.umd.min.js` exists, starts with `/* [@simplewebauthn/browser@13.3.0] */`.

- [ ] **Step 2: Load the vendored script and add the login-screen markup**

Modify `src/interaction/static/index.html`. Add the script tag near the other `<script src=...>` tag (after the existing `cytoscape` line):

```html
    <script src="/vendor/simplewebauthn/index.umd.min.js"></script>
```

In the `login-overlay` div, add a new WebAuthn-first block as the FIRST child inside the card (before the existing `login-personal-fields` div), so it can be shown/hidden as the default path:

```html
        <div id="login-webauthn-fields" class="hidden space-y-4">
            <p id="login-webauthn-hint" class="text-xs text-secondary text-center"></p>
            <button id="login-webauthn-submit" class="w-full py-3 bg-primary/5 hover:bg-primary/10 border border-primary/20 text-primary hover:text-white font-bold tracking-widest uppercase text-xs rounded-xl transition-all font-mono">UNLOCK WITH FACE ID / FINGERPRINT</button>
            <p id="login-webauthn-error" class="text-[10px] font-mono text-danger hidden"></p>
            <button id="login-webauthn-use-password" class="w-full text-center text-[9px] font-mono text-secondary/60 hover:text-secondary tracking-wider uppercase transition-all">Use password instead</button>
        </div>

```

- [ ] **Step 3: Wire the login-screen JS**

Modify `src/interaction/static/index.html`'s `<script>` section. In `showLoginGate()`, right after the existing `if (loginGateWired) return; loginGateWired = true;` line block finishes wiring its existing listeners (i.e. after the `toggle.addEventListener(...)` block that already exists), add the new WebAuthn wiring plus a call to attempt the WebAuthn-first path:

```javascript
        document.getElementById('login-webauthn-submit').addEventListener('click', submitWebauthnLogin);
        document.getElementById('login-webauthn-use-password').addEventListener('click', () => {
            document.getElementById('login-webauthn-fields').classList.add('hidden');
            document.getElementById('login-personal-fields').classList.remove('hidden');
        });

        attemptWebauthnFirstLogin();
    }

    // Tries the "Unlock with Face ID / fingerprint" path automatically for
    // a returning user on a device that's both WebAuthn-capable and has a
    // remembered username with at least one enrolled credential — falls
    // through to the normal password form otherwise, silently (this is an
    // expected, common case per the spec, not an error). Guards on
    // typeof SimpleWebAuthnBrowser so a failed/blocked load of the vendored
    // script (should be effectively impossible since it's local, not CDN,
    // but this is the login gate — it must never hard-fail) degrades to
    // the password form instead of breaking the page.
    async function attemptWebauthnFirstLogin() {
        const webauthnFields = document.getElementById('login-webauthn-fields');
        const personalFields = document.getElementById('login-personal-fields');
        const rememberedUsername = localStorage.getItem('last_username');
        if (typeof SimpleWebAuthnBrowser === 'undefined' || !SimpleWebAuthnBrowser.browserSupportsWebAuthn() || !rememberedUsername) {
            return; // password form (already the default-visible state) stays as-is
        }
        try {
            const res = await fetch('/api/webauthn/login-options', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: rememberedUsername }),
            });
            if (!res.ok) return;
            const options = await res.json();
            if (!options.hasCredentials) return;
            document.getElementById('login-webauthn-hint').textContent = `Signing in as ${rememberedUsername}`;
            webauthnFields.dataset.username = rememberedUsername;
            webauthnFields.dataset.optionsJson = JSON.stringify(options);
            webauthnFields.classList.remove('hidden');
            personalFields.classList.add('hidden');
        } catch (e) {
            console.warn('WebAuthn login-options check failed, falling back to password form:', e);
        }
    }

    async function submitWebauthnLogin() {
        const errorEl = document.getElementById('login-webauthn-error');
        const fields = document.getElementById('login-webauthn-fields');
        const submitBtn = document.getElementById('login-webauthn-submit');
        const username = fields.dataset.username;
        const options = JSON.parse(fields.dataset.optionsJson || '{}');
        errorEl.classList.add('hidden');
        submitBtn.disabled = true;
        submitBtn.textContent = 'WAITING FOR DEVICE...';
        try {
            const assertionResponse = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options });
            const verifyRes = await fetch('/api/webauthn/login-verify', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, response: assertionResponse }),
            });
            const data = await verifyRes.json().catch(() => ({}));
            if (!verifyRes.ok) {
                errorEl.textContent = data.error || "That didn't work — try again, or use your password.";
                errorEl.classList.remove('hidden');
                submitBtn.disabled = false;
                submitBtn.textContent = 'UNLOCK WITH FACE ID / FINGERPRINT';
                return;
            }
            localStorage.setItem('admin_api_key', data.api_key);
            localStorage.setItem('last_username', data.username);
            window.location.href = '/';
        } catch (e) {
            // The user cancelled the OS prompt, or the device/browser
            // genuinely can't complete it right now — not a server error,
            // so this stays quiet and just re-enables the button rather
            // than showing a scary error for a routine cancellation.
            console.warn('WebAuthn authentication ceremony did not complete:', e);
            submitBtn.disabled = false;
            submitBtn.textContent = 'UNLOCK WITH FACE ID / FINGERPRINT';
        }
    }
```

Also modify the existing `submitLogin()` function to remember the username on a successful password login too (so WebAuthn-first can trigger next time even if this login happened via password) — find its success path (`localStorage.setItem('admin_api_key', data.api_key); window.location.href = '/';`) and change it to:

```javascript
            localStorage.setItem('admin_api_key', data.api_key);
            localStorage.setItem('last_username', username);
            window.location.href = '/';
```

- [ ] **Step 4: Add the account-settings "Biometric devices" section**

Modify `src/interaction/static/index.html`. Add a new settings panel, mirroring the existing "Google Account" panel's structure, right after it (after the closing `</div>` of the `Google Account` `holo-panel` block):

```html
                <div class="holo-panel rounded-2xl p-5 w-full">
                    <h3 class="font-display font-semibold text-sm text-white mb-1">Biometric Devices</h3>
                    <p class="text-sm text-secondary mb-4 max-w-xl">Enroll this device for "Unlock with Face ID / fingerprint" instead of typing your password. Password sign-in always stays available as a fallback.</p>
                    <button onclick="enrollWebauthnDevice()" id="btn-enroll-webauthn" class="px-4 py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 text-white text-sm rounded-lg transition-all">Add This Device</button>
                    <div id="webauthn-device-list" class="mt-4 space-y-2"></div>
                </div>
```

- [ ] **Step 5: Wire the account-settings JS**

Modify `src/interaction/static/index.html`. Add these functions right after `disconnectGoogleAccount()`'s closing brace:

```javascript
    // ---------- Biometric device enrollment/management ----------
    async function loadWebauthnDevices() {
        const listEl = document.getElementById('webauthn-device-list');
        if (!listEl || !CURRENT_API_KEY) return;
        try {
            const res = await authFetch('/api/webauthn/credentials', { headers: { 'X-API-Key': CURRENT_API_KEY } });
            if (!res.ok) { listEl.innerHTML = ''; return; }
            const devices = await res.json();
            if (devices.length === 0) {
                listEl.innerHTML = '<p class="text-[11px] text-secondary/60">No devices enrolled yet.</p>';
                return;
            }
            listEl.innerHTML = devices.map(d => `
                <div class="flex items-center justify-between bg-white/[0.02] border border-white/5 rounded-lg px-3 py-2">
                    <div>
                        <p class="text-xs text-white">${d.device_label}</p>
                        <p class="text-[10px] text-secondary/50">${d.last_used_at ? 'Last used ' + new Date(d.last_used_at).toLocaleDateString() : 'Never used'}</p>
                    </div>
                    <button onclick="removeWebauthnDevice(${d.id})" class="text-[10px] font-mono text-danger hover:text-danger/80 uppercase tracking-wider">Remove</button>
                </div>
            `).join('');
        } catch (e) {
            console.warn('Failed to load biometric devices:', e);
        }
    }

    async function enrollWebauthnDevice() {
        if (!CURRENT_API_KEY) { addNotification("Log in first.", "warning"); return; }
        if (typeof SimpleWebAuthnBrowser === 'undefined' || !SimpleWebAuthnBrowser.browserSupportsWebAuthn()) {
            addNotification("This browser doesn't support device biometric sign-in.", "warning");
            return;
        }
        const deviceLabel = prompt("Name this device (e.g. \"iPhone\", \"Work laptop\"):", "");
        if (!deviceLabel || !deviceLabel.trim()) return;
        try {
            const optsRes = await authFetch('/api/webauthn/register-options', { method: 'POST', headers: { 'X-API-Key': CURRENT_API_KEY } });
            if (!optsRes.ok) { addNotification("Couldn't start device registration.", "danger"); return; }
            const options = await optsRes.json();
            const attestationResponse = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });
            const verifyRes = await authFetch('/api/webauthn/register-verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-API-Key': CURRENT_API_KEY },
                body: JSON.stringify({ response: attestationResponse, deviceLabel: deviceLabel.trim() }),
            });
            if (!verifyRes.ok) {
                const body = await verifyRes.json().catch(() => ({}));
                addNotification(body.error || "Couldn't complete device registration.", "danger");
                return;
            }
            addNotification("Device enrolled — you can now unlock with it.", "success");
            loadWebauthnDevices();
        } catch (e) {
            console.warn('WebAuthn registration ceremony did not complete:', e);
            addNotification("Device registration didn't complete.", "warning");
        }
    }

    async function removeWebauthnDevice(id) {
        if (!CURRENT_API_KEY) return;
        if (!confirm('Remove this device? You will no longer be able to unlock with it.')) return;
        try {
            const res = await authFetch(`/api/webauthn/credentials/${id}`, { method: 'DELETE', headers: { 'X-API-Key': CURRENT_API_KEY } });
            if (!res.ok) { addNotification("Couldn't remove that device.", "danger"); return; }
            addNotification("Device removed.", "success");
            loadWebauthnDevices();
        } catch (e) {
            console.warn('Failed to remove biometric device:', e);
            addNotification("Couldn't remove that device.", "danger");
        }
    }
```

Then find the existing `if (tabId === 'settings') { loadSystemSettings(); updatePushStatusUI(); updateGoogleConnectionStatusUI(); }` line and add the new call:

```javascript
        if (tabId === 'settings') { loadSystemSettings(); updatePushStatusUI(); updateGoogleConnectionStatusUI(); loadWebauthnDevices(); }
```

- [ ] **Step 6: Verify the inline scripts still parse cleanly**

This file has no build/tsc coverage for its inline `<script>` blocks (matching the precedent from the chat-image-upload feature earlier this project). Run a one-off syntax check:

```bash
node -e "
const fs = require('fs');
const html = fs.readFileSync('src/interaction/static/index.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
for (const s of scripts) {
  new Function(s); // throws SyntaxError on any malformed block
}
console.log('All ' + scripts.length + ' inline <script> blocks parsed cleanly.');
"
```

Expected: `All N inline <script> blocks parsed cleanly.` with no thrown error.

- [ ] **Step 7: Run the full backend suite once more to confirm nothing else broke**

Run: `npx tsc --noEmit && npm test 2>&1 | tail -10`
Expected: same baseline as Task 3's end, no new failures (this task touches no backend `.ts` files, so this is a final sanity check, not an expected-changes check).

- [ ] **Step 8: Commit**

```bash
git add src/interaction/static/vendor/simplewebauthn/index.umd.min.js src/interaction/static/index.html
git commit -m "feat: webauthn frontend — login-screen unlock flow, biometric device management in settings"
```

---

## Manual verification (the user's own step, not verifiable from this sandbox)

No real biometric hardware or OS-level authenticator exists in this sandboxed dev environment (matches the spec's own "Testing approach" section). Once deployed live:

1. Open the app on a device with Face ID / Windows Hello / a fingerprint sensor, over a real hostname (not a bare IP — see this plan's Global Constraints on `rpID`).
2. Sign in with username/password once, then go to Settings → Biometric Devices → "Add This Device", complete the OS prompt, confirm it appears in the device list.
3. Sign out (clear `localStorage` or open a private window), reload the login page — confirm "Unlock with Face ID / fingerprint" appears automatically and completes a real login.
4. Confirm "Use password instead" still works, and that removing a device from Settings makes it stop being offered on the next login attempt.
