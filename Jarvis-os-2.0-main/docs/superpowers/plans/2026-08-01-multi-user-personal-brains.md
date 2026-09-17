# Multi-User Access, Personal Brains, and a Shared Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace single-tenant registration and single-tenant Google integration with invite-only onboarding (hard-capped at 10 personal accounts), a default per-user capability bundle, encrypted-at-rest per-user Google OAuth (Calendar + Gmail), real offboarding, and a one-click mechanism for rolling a new capability out to everyone already onboarded.

**Architecture:** `oauth_tokens` moves from one row per provider (global) to one row per `(provider, username)`, with token columns encrypted at rest via a new AES-256-GCM helper. A new `invite_tokens` table backs admin-issued, single-use signup links; redeeming one grants a new `DEFAULT_PERSONAL_CAPABILITIES` bundle automatically. `calendar.ts` and a new Gmail-API-based provider both thread `username` through every call — the existing single-tenant code paths become the general case (every caller, admin included, now reads/writes their own row) rather than a special admin-only path running alongside a new personal one. Everything personal a user tells Jarvis already lands in tables scoped per username (`kg_facts` etc., fixed previously) — no new "personal brain" schema is needed.

**Tech Stack:** Node.js/TypeScript, Express, PostgreSQL via `pg`, Google OAuth2/Calendar API/Gmail API, Node's built-in `crypto` module (no new dependency for encryption).

**Full design context:** `docs/superpowers/specs/2026-08-01-multi-user-personal-brains-design.md` — read this first if any task below is ambiguous; it explains *why*, this plan only covers *what/how*.

## Global Constraints

- The 10-person cap counts non-admin accounts only: `COUNT(*) FROM users WHERE username != 'admin' < 10`, checked at invite-generation time, not at registration.
- `DEFAULT_PERSONAL_CAPABILITIES` is a plain subset of the existing `ALL_CAPABILITIES` array in `src/kernel/security.ts` — it does NOT need its own grant-route validation logic (unlike `EXTRA_GRANTABLE_CAPABILITIES` from a separate, unrelated piece of work not present on this branch); every name in it is already a valid, grantable capability.
- `calendar.read`/`calendar.write`/`email.read`/`email.send` join `DEFAULT_PERSONAL_CAPABILITIES` only once the personal-OAuth tasks (8-13) are actually complete — Task 4 ships the bundle without them; a later task in this plan adds them once the underlying capability exists to back them.
- Every existing single-tenant admin usage of Calendar (and the new personal Gmail work) must keep working for the admin identity specifically — admin is just the first `(provider, "admin")` row, not a special code path.
- Token encryption: `OAUTH_TOKEN_ENCRYPTION_KEY` (32 random bytes, base64) must be present and valid at startup once Task 6 ships, or the process refuses to start — matching the existing `INTERNAL_API_KEY` "refuse to start with a guessable/default key" precedent in `auth-middleware.ts`.
- Decryption failure (corrupt ciphertext, wrong key) fails closed — treated as "not connected," never a thrown exception that crashes a request, never a silent fallback to reading the field unencrypted.
- `npx tsc --noEmit` and `npm test` must both pass after every task below, before that task's commit.
- Never reorder/renumber a migration once committed on this branch's history — this plan's migration is `007_multi_user_oauth`; if a conflicting `007` lands on `main` first (from either of the two other in-flight PRs on this repo), renumber to the next free id, don't overwrite.
- No live Google OAuth round-trips or live token-revocation calls in any automated test in this plan — verified via careful code tracing and the existing db-integration pattern against a throwaway Postgres, matching this codebase's established discipline. Real manual verification (one person actually connecting a real account) is a deliberate, separate step after implementation, not something any task here performs automatically.

---

## File Structure

| File | Change |
|---|---|
| `src/kernel/state/migrations/007_multi_user_oauth.ts` | Create — `oauth_tokens` PK change (with backfill) + `invite_tokens` table |
| `src/kernel/state/migrations/index.ts` | Modify — register `m007` |
| `src/kernel/security.ts` | Modify — add `DEFAULT_PERSONAL_CAPABILITIES` |
| `src/kernel/state/invites-repo.ts` | Create — invite CRUD |
| `src/interaction/routes/invites-routes.ts` | Create — `POST/DELETE /api/invites` |
| `src/interaction/routes/auth-routes.ts` | Modify — register requires invite token, grants default bundle |
| `src/interaction/static/index.html` | Modify — signup page, Connect Google Account button |
| `src/kernel/token-crypto.ts` | Create — AES-256-GCM encrypt/decrypt helpers |
| `src/kernel/state/oauth-repo.ts` | Modify — per-`(provider, username)`, encrypted |
| `src/kernel/oauth-state-tickets.ts` | Create — single-use, username-bound OAuth state tokens |
| `src/capabilities/providers/calendar.ts` | Modify — thread `username` through every function |
| `src/capabilities/providers/personal-gmail.ts` | Create — Gmail-API-based personal email provider |
| `src/capabilities/tools.ts` | Modify — pass `username` to calendar/personal-email calls |
| `src/interaction/routes/integrations-routes.ts` | Modify — combined Google connect/callback routes, disconnect route |
| `src/interaction/routes/admin-routes.ts` | Create — `DELETE /api/admin/users/:username` |
| `src/interaction/routes/permissions-routes.ts` | Modify — `POST /api/permissions/grant-all` |
| `tests/index.test.ts` | Modify — unit tests for every new pure/testable piece |
| `tests/db-integration.test.ts` | Modify — invite redemption, remove-user cascade, real-Postgres tests |
| `.env.example` | Modify — document `OAUTH_TOKEN_ENCRYPTION_KEY` |

---

## Task 1: Migration `007_multi_user_oauth`

**Files:**
- Create: `src/kernel/state/migrations/007_multi_user_oauth.ts`
- Modify: `src/kernel/state/migrations/index.ts`

**Interfaces:**
- Produces: `oauth_tokens` with `PRIMARY KEY (provider, username)`, a `username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE` column; `invite_tokens` table.

- [ ] **Step 1: Write the migration**

Create `src/kernel/state/migrations/007_multi_user_oauth.ts`:

```typescript
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
const migration: Migration = {
  id: "007_multi_user_oauth",
  description:
    "Scope oauth_tokens to (provider, username) instead of a single global row per provider, backfilling existing rows to 'admin', and add invite_tokens for admin-issued single-use signup links.",
  up: async (client) => {
    await client.query(`ALTER TABLE oauth_tokens ADD COLUMN username TEXT;`);
    await client.query(`UPDATE oauth_tokens SET username = 'admin' WHERE username IS NULL;`);
    await client.query(`ALTER TABLE oauth_tokens ALTER COLUMN username SET NOT NULL;`);
    await client.query(`ALTER TABLE oauth_tokens ADD CONSTRAINT oauth_tokens_username_fkey FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE;`);
    await client.query(`ALTER TABLE oauth_tokens DROP CONSTRAINT oauth_tokens_pkey;`);
    await client.query(`ALTER TABLE oauth_tokens ADD PRIMARY KEY (provider, username);`);

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
```

Note: `username TEXT NOT NULL REFERENCES users(username)` will fail if any existing `oauth_tokens` row's backfilled `'admin'` value isn't itself present in `users` — but `admin` is never a row in `users` (it's the `INTERNAL_API_KEY` identity, confirmed in `users-repo.ts`'s own comment on `listUsernames()`). Adding a real FK to `users(username)` would therefore break the admin backfill. **Do not add the FK constraint in this migration for the `'admin'` case** — instead, skip the FK and rely on application-level integrity (every future write path here always uses a real `username`, either `'admin'` or a genuine `users` row), OR add the FK but first verify: if it fails against the live schema during Task verification (Step 3 below), remove the `ADD CONSTRAINT` line and note in the migration's comment why (`admin` is a synthetic identity, not a real `users` row, so a hard FK can't include it). Verify this against the actual throwaway-Postgres run in Step 3 before deciding which version ships.

- [ ] **Step 2: Register it**

In `src/kernel/state/migrations/index.ts`, add the import and append to `ALL_MIGRATIONS`:

```typescript
import m007 from "./007_multi_user_oauth.js";
```
```typescript
export const ALL_MIGRATIONS = [m001, m002, m003, m004, m005, m006, m007];
```

- [ ] **Step 3: Verify against a throwaway Postgres instance**

Same pattern used throughout this codebase's history for schema changes:

```bash
docker run -d --name jarvis-test-pg-mu --rm -e POSTGRES_USER=testuser -e POSTGRES_PASSWORD=testpass -e POSTGRES_DB=testdb -p 15435:5432 pgvector/pgvector:pg16
until docker exec jarvis-test-pg-mu pg_isready -U testuser -d testdb >/dev/null 2>&1; do sleep 1; done
POSTGRES_USER=testuser POSTGRES_PASSWORD=testpass POSTGRES_DB=testdb POSTGRES_HOST=localhost POSTGRES_PORT=15435 \
  DB_INTEGRATION_TEST_CONFIRM=i-accept-data-loss-in-this-database npx tsx tests/db-integration.test.ts
docker stop jarvis-test-pg-mu
```

Expected: `Applied migration "007_multi_user_oauth"` in the output, all existing db-integration tests still pass. Resolve the FK question from Step 1 based on what actually happens here — if the migration fails on the FK constraint, remove it and adjust the migration's comment to explain why before moving on.

- [ ] **Step 4: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no errors

```bash
git add src/kernel/state/migrations/007_multi_user_oauth.ts src/kernel/state/migrations/index.ts
git commit -m "feat: scope oauth_tokens per-user and add invite_tokens"
```

---

## Task 2: `DEFAULT_PERSONAL_CAPABILITIES` and the invites repo

**Files:**
- Modify: `src/kernel/security.ts`
- Create: `src/kernel/state/invites-repo.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Produces: `DEFAULT_PERSONAL_CAPABILITIES: readonly string[]` (security.ts); `createInvite(createdBy: string, expiresInDays?: number): Promise<{token: string; expiresAt: Date}>`, `redeemInvite(token: string, username: string): Promise<boolean>`, `revokeInvite(token: string): Promise<boolean>`, `countNonAdminUsers(): Promise<number>` (invites-repo.ts)

- [ ] **Step 1: Add `DEFAULT_PERSONAL_CAPABILITIES` to `security.ts`**

Add near `ALL_CAPABILITIES`, after its closing `] as const;`:

```typescript
// Granted automatically the moment an invite is redeemed (Task 4) — every
// name here must already be a member of ALL_CAPABILITIES above; this is a
// subset used for auto-provisioning, not a separate grantable-capability
// concept. calendar.read/write and email.read/send are deliberately
// excluded here until the personal-OAuth work (Tasks 8-13) actually ships —
// granting them earlier would point a new user at the shared admin Google
// account, not their own. Add them here once that work is live, not before.
export const DEFAULT_PERSONAL_CAPABILITIES: readonly string[] = [
  "web.search",
  "news.read",
  "tts.speak",
  "knowledge.read",
  "identity.read",
  "hud.read",
  "feature.propose",
  "system.sandbox_execute",
];
```

- [ ] **Step 2: Write the failing test for the subset invariant**

Add to `tests/index.test.ts`, near the other `Permissions`-style tests:

```typescript
registerTest("Permissions", "every DEFAULT_PERSONAL_CAPABILITIES entry is a real, valid capability", () => {
  const all = new Set(permissions.ALL_CAPABILITIES as readonly string[]);
  for (const cap of permissions.DEFAULT_PERSONAL_CAPABILITIES) {
    if (!all.has(cap)) {
      throw new Error(`Permissions: DEFAULT_PERSONAL_CAPABILITIES contains "${cap}", which is not in ALL_CAPABILITIES`);
    }
  }
});
```

Check how `permissions` is imported at the top of `tests/index.test.ts` (likely `import * as permissions from "../src/kernel/security.js";` or similar — confirm the existing import style before adding this test) and add `DEFAULT_PERSONAL_CAPABILITIES` to whatever's already imported if it's a named import rather than a namespace import.

- [ ] **Step 3: Run the test, confirm it passes (it should pass immediately given Step 1's list is a real subset — this test exists to catch a FUTURE typo, not to drive new logic)**

Run: `npm test 2>&1 | grep "DEFAULT_PERSONAL_CAPABILITIES"`
Expected: `[PASSED]`

- [ ] **Step 4: Write `invites-repo.ts`**

Create `src/kernel/state/invites-repo.ts`, following the established repo pattern (`getPool()`, try/catch degrade-cleanly for reads, real errors surfaced for writes with no sensible fallback — matching `build-requests-repo.ts`'s conventions):

```typescript
import crypto from "crypto";
import { getPool } from "./db.js";
import { ObservationPlatform } from "../observation.js";

const observation = ObservationPlatform.getInstance();

export interface InviteToken {
  token: string;
  created_by: string;
  created_at: Date;
  expires_at: Date;
  used_by: string | null;
  used_at: Date | null;
}

export async function countNonAdminUsers(): Promise<number> {
  const db = getPool();
  const { rows } = await db.query(`SELECT COUNT(*)::int AS count FROM users WHERE username != 'admin'`);
  return rows[0]?.count ?? 0;
}

export async function createInvite(createdBy: string, expiresInDays = 7): Promise<InviteToken> {
  const db = getPool();
  const token = crypto.randomBytes(24).toString("hex");
  const { rows } = await db.query(
    `INSERT INTO invite_tokens (token, created_by, expires_at) VALUES ($1, $2, now() + ($3 || ' days')::interval) RETURNING *`,
    [token, createdBy, expiresInDays]
  );
  return rows[0];
}

// Atomic claim: the WHERE clause requires the invite to still be unused and
// unexpired, so two near-simultaneous redemption attempts for the same
// token can't both succeed — whichever UPDATE actually matches a row wins,
// the other gets rowCount 0 and this returns false. Mirrors the same
// concurrency discipline createUser's ON CONFLICT DO NOTHING already uses.
export async function redeemInvite(token: string, username: string): Promise<boolean> {
  const db = getPool();
  const { rowCount } = await db.query(
    `UPDATE invite_tokens SET used_by = $1, used_at = now()
     WHERE token = $2 AND used_by IS NULL AND expires_at > now()`,
    [username, token]
  );
  return !!rowCount;
}

export async function revokeInvite(token: string): Promise<boolean> {
  const db = getPool();
  const { rowCount } = await db.query(`DELETE FROM invite_tokens WHERE token = $1 AND used_by IS NULL`, [token]);
  return !!rowCount;
}

export async function getInvite(token: string): Promise<InviteToken | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(`SELECT * FROM invite_tokens WHERE token = $1`, [token]);
    return rows[0] || null;
  } catch (err: any) {
    observation.logTelemetry("warn", "Database", `getInvite failed: ${err.message}`);
    return null;
  }
}
```

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no errors

```bash
git add src/kernel/security.ts src/kernel/state/invites-repo.ts tests/index.test.ts
git commit -m "feat: add DEFAULT_PERSONAL_CAPABILITIES and the invites repo"
```

---

## Task 3: Invite routes (`POST`/`DELETE /api/invites`)

**Files:**
- Create: `src/interaction/routes/invites-routes.ts`
- Modify: `src/server.ts` (mount the router — check how other extracted routers are mounted, e.g. `app.use(permissionsRouter)`, and follow the same pattern)
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `invites-repo.ts` (Task 2)
- Produces: `POST /api/invites` (admin-only, body `{}`, returns `{token, url, expiresAt}`), `DELETE /api/invites/:token` (admin-only)

- [ ] **Step 1: Write the router**

Create `src/interaction/routes/invites-routes.ts`:

```typescript
import { Router } from "express";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import * as invitesRepo from "../../kernel/state/invites-repo.js";
import { ObservationPlatform } from "../../kernel/observation.js";

const observation = ObservationPlatform.getInstance();

export const invitesRouter = Router();

const MAX_NON_ADMIN_USERS = 10;

invitesRouter.post("/api/invites", validateApiKey, async (req: any, res: any) => {
  if (req.username !== "admin") {
    return res.status(403).json({ error: "Only admin can create invites" });
  }
  try {
    const count = await invitesRepo.countNonAdminUsers();
    if (count >= MAX_NON_ADMIN_USERS) {
      return res.status(403).json({ error: `Already at the ${MAX_NON_ADMIN_USERS}-person limit — remove someone before inviting another.` });
    }
    const invite = await invitesRepo.createInvite(req.username);
    observation.logAuditEvent(req.username, "invite_created", "success", `Invite created, expires ${invite.expires_at.toISOString()}`);
    res.json({ token: invite.token, expiresAt: invite.expires_at });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

invitesRouter.delete("/api/invites/:token", validateApiKey, async (req: any, res: any) => {
  if (req.username !== "admin") {
    return res.status(403).json({ error: "Only admin can revoke invites" });
  }
  try {
    const revoked = await invitesRepo.revokeInvite(req.params.token);
    if (!revoked) {
      return res.status(404).json({ error: "Invite not found, or already used" });
    }
    observation.logAuditEvent(req.username, "invite_revoked", "success", `Invite ${req.params.token.slice(0, 8)}... revoked`);
    res.json({ status: "success" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 2: Mount the router in `server.ts`**

Find where a comparable extracted router is mounted (e.g. `app.use(permissionsRouter)`), add `app.use(invitesRouter)` alongside it, and add the import at the top of the file matching the existing import style for other routers.

- [ ] **Step 3: Write the failing HTTP-boundary test**

Add to `tests/index.test.ts`, near the other `HTTP Boundary` tests (check the current highest port number used by `spawnTestServer` calls in this file and pick the next free one, e.g. if the highest existing is 3015, use 3016):

```typescript
registerTest("HTTP Boundary", "POST /api/invites is refused for a non-admin user, even with a valid key", async () => {
  const port = 3016; // confirm this port isn't already used elsewhere in this file before committing
  const child = await spawnTestServer(port, { INTERNAL_API_KEY: TEST_ADMIN_API_KEY });
  try {
    await grantCapability("non_admin_user", "web.search", "test-harness");
    const res = await fetch(`http://127.0.0.1:${port}/api/invites`, {
      method: "POST",
      headers: { "X-API-Key": TEST_ADMIN_API_KEY },
    });
    // TEST_ADMIN_API_KEY maps to "admin" per auth-middleware.ts's INTERNAL_API_KEY
    // identity — this test needs a NON-admin caller instead. Check how other
    // tests in this category simulate a non-admin authenticated request (the
    // pattern used for "newly capability-gated routes reject unauthenticated
    // requests and admit a granted admin" or similar existing tests) and
    // follow that exact approach rather than inventing a new one — likely
    // registering a real non-admin user via a live-Postgres-gated test, or
    // reusing whatever mechanism the existing permission-focused HTTP
    // Boundary tests already established for this exact "authenticated but
    // not admin" scenario.
    if (res.status !== 403) {
      throw new Error(`HTTP Boundary: expected 403 for a non-admin caller, got ${res.status}`);
    }
  } finally {
    await stopTestServer(child);
  }
});
```

The comment inside this test step is deliberate: read the existing HTTP Boundary tests in this file first to find the established pattern for simulating "authenticated as a real non-admin user" in this test harness (there's precedent — the permissions/capability-gated route tests already had to solve this), and write the real, working version of this test using that exact pattern rather than the placeholder reasoning shown above. Do not leave the comment in the final code — replace it with the actual working test body.

- [ ] **Step 4: Run tests, verify pass, typecheck, commit**

Run: `npx tsc --noEmit && npm test`
Expected: no errors, all tests pass

```bash
git add src/interaction/routes/invites-routes.ts src/server.ts tests/index.test.ts
git commit -m "feat: add admin-only invite generation/revocation routes"
```

---

## Task 4: Registration requires an invite token

**Files:**
- Modify: `src/interaction/routes/auth-routes.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `invitesRepo.redeemInvite` (Task 2), `permissions.DEFAULT_PERSONAL_CAPABILITIES`/`grantCapability` (Task 2, existing `security.ts`)

- [ ] **Step 1: Replace the `ALLOW_REGISTRATION` check with invite-token validation**

In `src/interaction/routes/auth-routes.ts`, replace:

```typescript
authRouter.post("/api/register", authLimiter, async (req, res) => {
  if (!ALLOW_REGISTRATION) {
    return res.status(403).json({ error: "Registration is currently disabled. Set ALLOW_REGISTRATION=true to enable it." });
  }
  const { username, password } = req.body;
```

with:

```typescript
authRouter.post("/api/register", authLimiter, async (req, res) => {
  const { username, password, inviteToken } = req.body;
  if (typeof inviteToken !== "string" || !inviteToken.trim()) {
    return res.status(400).json({ error: "An invite token is required to register." });
  }
```

Remove the now-unused `ALLOW_REGISTRATION` constant and its associated comment entirely (registration is invite-gated now, not flag-gated) — verify with `grep -rn "ALLOW_REGISTRATION" src/` that no other file still reads it before removing the constant; if something else does, leave the constant but stop using it in this route specifically, and note the discrepancy in your report.

- [ ] **Step 2: Redeem the invite atomically with account creation, grant the default bundle**

Immediately after the existing `const apiKey = await usersRepo.createUser(username, password);` line, insert:

```typescript
    const redeemed = await invitesRepo.redeemInvite(inviteToken, username);
    if (!redeemed) {
      // The account was already created above — this is a genuine ordering
      // tension (createUser has no sensible "undo" and redeemInvite has no
      // sensible "check without claiming"), resolved by validating the
      // invite is real and unused BEFORE calling createUser instead. Revert
      // this Step to do that check-first, not user-creation-first: fetch
      // the invite via invitesRepo.getInvite(inviteToken) first, verify
      // it exists, has no used_by, and expires_at is in the future: if not,
      // return 400 immediately without ever calling createUser; only once
      // that pre-check passes should createUser and then redeemInvite
      // (still checked for the TOCTOU race, but now failing an already-rare
      // case rather than the common one) both run.
    }
```

That inline comment describes the actual required design — implement it that way (pre-check via `getInvite`, then `createUser`, then `redeemInvite` as the atomic claim against the rare race) rather than the naive create-then-redeem order shown first. After successful redemption, grant the default bundle:

```typescript
    for (const capability of permissions.DEFAULT_PERSONAL_CAPABILITIES) {
      await permissions.grantCapability(username, capability, "system:invite-redemption");
    }
```

Add the necessary imports (`invitesRepo` from `../../kernel/state/invites-repo.js`, `permissions` from `../../kernel/security.js` — check whether `security.js` is already imported under a different name in this file before adding a duplicate import).

- [ ] **Step 3: Write the failing tests**

Add to `tests/index.test.ts`:

```typescript
registerTest("Auth", "register is refused with no invite token", async () => {
  // This test exercises the route's synchronous validation only (missing/
  // empty inviteToken), which needs no live Postgres — verify this holds by
  // checking the route code path: the inviteToken presence check must run
  // before any database call. If it doesn't, adjust this test to the
  // HTTP Boundary category with spawnTestServer instead, matching how
  // other DB-dependent route tests in this file are structured.
});
```

Given registration genuinely requires Postgres (creating a real user, redeeming a real invite), the real test for the full happy path belongs in `tests/db-integration.test.ts`, not `tests/index.test.ts`. Add there instead:

```typescript
registerTest("register grants DEFAULT_PERSONAL_CAPABILITIES on successful invite redemption, against real Postgres", async () => {
  const invite = await invitesRepo.createInvite("admin");
  const apiKey = await usersRepo.createUser("test_personal_user", "a-real-password-123");
  const redeemed = await invitesRepo.redeemInvite(invite.token, "test_personal_user");
  if (!redeemed) throw new Error("expected redeemInvite to succeed for a fresh, unused invite");
  for (const capability of permissions.DEFAULT_PERSONAL_CAPABILITIES) {
    await permissions.grantCapability("test_personal_user", capability, "test-harness");
  }
  for (const capability of permissions.DEFAULT_PERSONAL_CAPABILITIES) {
    if (!permissions.hasGrant("test_personal_user", capability)) {
      throw new Error(`expected "test_personal_user" to have "${capability}" after default-bundle grant`);
    }
  }
  const secondRedeem = await invitesRepo.redeemInvite(invite.token, "someone_else");
  if (secondRedeem) throw new Error("expected a second redemption of the same invite to fail");
});
```

This test exercises the repo-level building blocks directly (matching this file's existing style of testing against real Postgres without necessarily spinning up the full HTTP server) rather than the full HTTP route — a genuine HTTP-level test of `/api/register` with a live server is a reasonable addition too if you have time, but the repo-level test above is the one that must exist.

- [ ] **Step 4: Run tests (including against a throwaway Postgres per Task 1's pattern), typecheck, commit**

Run: `npx tsc --noEmit && npm test`, then the db-integration suite against a throwaway container (same recipe as Task 1 Step 3).
Expected: no errors, all tests pass including the new one.

```bash
git add src/interaction/routes/auth-routes.ts tests/index.test.ts tests/db-integration.test.ts
git commit -m "fix: require a valid invite token to register, grant the default capability bundle"
```

---

## Task 5: Frontend signup flow

**Files:**
- Modify: `src/interaction/static/index.html`

**Interfaces:**
- Consumes: `POST /api/register` (now requiring `inviteToken`, Task 4)

There is currently no signup/login form in this frontend at all — access today is provisioned by directly calling `/api/register` out of band and handing someone their API key. This task adds the first real self-service signup UI.

- [ ] **Step 1: Add a signup view**

Read the existing settings/API-key-entry section around `CURRENT_API_KEY = e.target.value.trim()` (line ~4399) and the surrounding markup to match this codebase's existing visual/structural conventions (the `holo-chip` card style already used throughout, per patterns seen in the build-requests panel) before adding new markup — this task's exact HTML/CSS should follow what's already established, not invent a new visual language.

Add: a route/view detection for a URL shape like `/invite/:token` (check `window.location.pathname` on page load) that, when present, shows a signup form instead of the normal dashboard/login state — fields for username and password, the invite token carried from the URL (not user-typed), a submit button that `POST`s to `/api/register` with `{username, password, inviteToken}`, and on success stores the returned `api_key` into `localStorage` under the same key (`admin_api_key`) the existing API-key-entry flow already uses, then reloads into the normal dashboard view — reusing the exact same "you're now logged in" state transition the existing manual API-key-entry path already produces, not a new one.

- [ ] **Step 2: Manual verification**

Start the dev server (`npm run dev`), generate a real invite via `curl -X POST localhost:3000/api/invites -H "X-API-Key: <your admin key>"`, visit `http://localhost:3000/invite/<token>` in a browser, confirm the signup form appears, submit it, confirm you land in a working logged-in dashboard state afterward, and confirm a second visit to the same invite URL correctly fails (already used).

- [ ] **Step 3: Commit**

```bash
git add src/interaction/static/index.html
git commit -m "feat: add a real signup flow for invite-based registration"
```

---

## Task 6: Token encryption helper

**Files:**
- Create: `src/kernel/token-crypto.ts`
- Modify: `src/server.ts` (startup key validation)
- Modify: `.env.example`
- Test: `tests/index.test.ts`

**Interfaces:**
- Produces: `encryptToken(plaintext: string): string`, `decryptToken(ciphertext: string): string | null` (returns `null` on any decryption failure — fail closed, never throws to a caller that isn't specifically testing the failure path)

- [ ] **Step 1: Write the failing tests**

```typescript
import { encryptToken, decryptToken } from "../src/kernel/token-crypto.js";

registerTest("TokenCrypto", "encryptToken then decryptToken round-trips the original plaintext", () => {
  const original = "a-real-looking-refresh-token-value-1234567890";
  const encrypted = encryptToken(original);
  if (encrypted === original) {
    throw new Error("TokenCrypto: encrypted output must not equal the plaintext");
  }
  const decrypted = decryptToken(encrypted);
  if (decrypted !== original) {
    throw new Error(`TokenCrypto: expected round-trip to recover "${original}", got "${decrypted}"`);
  }
});

registerTest("TokenCrypto", "decryptToken fails closed (returns null, does not throw) on tampered ciphertext", () => {
  const encrypted = encryptToken("some-token");
  const tampered = encrypted.slice(0, -4) + "abcd"; // corrupt the tail
  const result = decryptToken(tampered);
  if (result !== null) {
    throw new Error(`TokenCrypto: expected null for tampered ciphertext, got "${result}"`);
  }
});

registerTest("TokenCrypto", "decryptToken fails closed on garbage input, does not throw", () => {
  const result = decryptToken("not-even-valid-base64-or-the-right-shape!!!");
  if (result !== null) {
    throw new Error(`TokenCrypto: expected null for garbage input, got "${result}"`);
  }
});

registerTest("TokenCrypto", "two encryptions of the same plaintext produce different ciphertext (real IV usage)", () => {
  const a = encryptToken("same-value");
  const b = encryptToken("same-value");
  if (a === b) {
    throw new Error("TokenCrypto: expected different ciphertext across calls (IV should be random per call), got identical output");
  }
});
```

These tests need `OAUTH_TOKEN_ENCRYPTION_KEY` set in the test environment — check how the test file's setup already handles required env vars (e.g. `TEST_ADMIN_API_KEY`'s pattern) and set a real, valid test key the same way, either at the top of the test file or via a `beforeAll`-style setup this file's structure already uses.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep TokenCrypto`
Expected: FAIL — module doesn't exist yet

- [ ] **Step 3: Implement**

Create `src/kernel/token-crypto.ts`:

```typescript
import crypto from "crypto";

// Application-level encryption for anything stored in oauth_tokens — real
// people's real Google refresh tokens, not just Jarvis's own operational
// state. Protects against the realistic threat here (someone getting query
// access to Postgres — a backup leak, a compromised process — without also
// having this key), which matters more for a self-hosted deployment than
// disk-level encryption would. AES-256-GCM: IV + auth tag + ciphertext
// packed into one stored string (colon-separated, each base64), so a single
// TEXT column holds everything needed to decrypt.
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12; // 96-bit IV is the GCM-recommended size

function getKey(): Buffer {
  const raw = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "OAUTH_TOKEN_ENCRYPTION_KEY is not set — generate one with `openssl rand -base64 32` and set it before storing any OAuth tokens."
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `OAUTH_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}) — generate one with \`openssl rand -base64 32\`.`
    );
  }
  return key;
}

export function encryptToken(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptToken(stored: string): string | null {
  try {
    const key = getKey();
    const [ivB64, authTagB64, ciphertextB64] = stored.split(":");
    if (!ivB64 || !authTagB64 || !ciphertextB64) return null;
    const iv = Buffer.from(ivB64, "base64");
    const authTag = Buffer.from(authTagB64, "base64");
    const ciphertext = Buffer.from(ciphertextB64, "base64");
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf-8");
  } catch {
    // Tampered ciphertext, wrong key, corrupt/garbage input — all fail
    // closed the same way: treat as undecryptable, never throw past this
    // boundary, never partially return something that looks plausible.
    return null;
  }
}
```

- [ ] **Step 4: Startup validation in `server.ts`**

Find where `INTERNAL_API_KEY` is validated at module load (the "refuse to start with a guessable/default admin key" check in `auth-middleware.ts`) and add an equivalent check in `server.ts` near its own startup validation code: if `process.env.OAUTH_TOKEN_ENCRYPTION_KEY` is unset or doesn't decode to exactly 32 bytes, log a clear fatal error and exit — matching the existing pattern's severity and wording style, not a warning that lets the process continue in a broken state.

- [ ] **Step 5: Document in `.env.example`**

Add near the existing `GOOGLE_CLIENT_ID`/`GOOGLE_REDIRECT_URI` block:

```
# Generate with: openssl rand -base64 32
OAUTH_TOKEN_ENCRYPTION_KEY=
```

- [ ] **Step 6: Run tests, typecheck, commit**

Run: `npx tsc --noEmit && npm test`
Expected: no errors, all tests pass

```bash
git add src/kernel/token-crypto.ts src/server.ts .env.example tests/index.test.ts
git commit -m "feat: add AES-256-GCM encryption for stored OAuth tokens"
```

---

## Task 7: `oauth-repo.ts` becomes per-user and encrypted

**Files:**
- Modify: `src/kernel/state/oauth-repo.ts`
- Modify: `src/capabilities/providers/calendar.ts` (minimal call-site update only — full username threading is Task 10)
- Test: `tests/db-integration.test.ts`

**Interfaces:**
- Consumes: `encryptToken`/`decryptToken` (Task 6)
- Produces: `saveTokens(provider: string, username: string, accessToken: string, refreshToken: string, expiry: Date): Promise<void>`, `getTokens(provider: string, username: string): Promise<StoredOAuthTokens | null>`

- [ ] **Step 1: Update `oauth-repo.ts`**

Replace the full file content:

```typescript
import { getPool } from "./db.js";
import { encryptToken, decryptToken } from "../token-crypto.js";

export interface StoredOAuthTokens {
  provider: string;
  username: string;
  access_token: string;
  refresh_token: string;
  expiry: Date;
}

export async function saveTokens(
  provider: string,
  username: string,
  accessToken: string,
  refreshToken: string,
  expiry: Date
): Promise<void> {
  const db = getPool();
  await db.query(
    `INSERT INTO oauth_tokens (provider, username, access_token, refresh_token, expiry)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider, username) DO UPDATE SET access_token = $3, refresh_token = $4, expiry = $5, updated_at = now()`,
    [provider, username, encryptToken(accessToken), encryptToken(refreshToken), expiry]
  );
}

export async function getTokens(provider: string, username: string): Promise<StoredOAuthTokens | null> {
  const db = getPool();
  const { rows } = await db.query(`SELECT * FROM oauth_tokens WHERE provider = $1 AND username = $2`, [provider, username]);
  const row = rows[0];
  if (!row) return null;
  const accessToken = decryptToken(row.access_token);
  const refreshToken = decryptToken(row.refresh_token);
  // Fail closed per this plan's Global Constraints: a decryption failure
  // (corrupt data, wrong key) is treated as "not connected", not a crash
  // and not a silent return of ciphertext-as-if-it-were-a-real-token.
  if (accessToken === null || refreshToken === null) return null;
  return { provider: row.provider, username: row.username, access_token: accessToken, refresh_token: refreshToken, expiry: row.expiry };
}

export async function deleteTokens(provider: string, username: string): Promise<boolean> {
  const db = getPool();
  const { rowCount } = await db.query(`DELETE FROM oauth_tokens WHERE provider = $1 AND username = $2`, [provider, username]);
  return !!rowCount;
}
```

- [ ] **Step 2: Minimal call-site fix in `calendar.ts`**

`calendar.ts` currently calls `oauthRepo.saveTokens(PROVIDER, ...)`/`oauthRepo.getTokens(PROVIDER)` with no username — these calls now need a second argument. To keep this task's diff minimal (full username-threading through every `calendar.ts` function is Task 10's job), hardcode `"admin"` as a placeholder at each of the 3 call sites (`exchangeCodeForTokens`, `getValidAccessToken`'s read, `getValidAccessToken`'s refresh-then-save) — e.g. `oauthRepo.saveTokens(PROVIDER, "admin", data.access_token, data.refresh_token, expiry);`. This preserves today's exact behavior (single-tenant, admin-only) while making the codebase compile against the new signature; Task 10 replaces every one of these hardcoded `"admin"` strings with a real `username` parameter.

- [ ] **Step 3: Verify against a throwaway Postgres, confirming the encrypted round-trip works against a real database, not just the in-memory unit tests from Task 6**

```bash
docker run -d --name jarvis-test-pg-mu2 --rm -e POSTGRES_USER=testuser -e POSTGRES_PASSWORD=testpass -e POSTGRES_DB=testdb -p 15436:5432 pgvector/pgvector:pg16
until docker exec jarvis-test-pg-mu2 pg_isready -U testuser -d testdb >/dev/null 2>&1; do sleep 1; done
```

Add a test to `tests/db-integration.test.ts`:

```typescript
registerTest("oauth-repo: saveTokens/getTokens round-trip real encrypted values against real Postgres", async () => {
  await oauthRepo.saveTokens("test_provider", "test_oauth_user", "real-access-token-value", "real-refresh-token-value", new Date(Date.now() + 3600_000));
  const result = await oauthRepo.getTokens("test_provider", "test_oauth_user");
  if (!result || result.access_token !== "real-access-token-value" || result.refresh_token !== "real-refresh-token-value") {
    throw new Error(`oauth-repo: expected round-tripped plaintext tokens, got: ${JSON.stringify(result)}`);
  }
  // Confirm it's genuinely encrypted at rest, not stored as plaintext —
  // query the raw column value directly and check it doesn't contain the
  // original plaintext substring.
  const db = getPool();
  const { rows } = await db.query(`SELECT access_token FROM oauth_tokens WHERE provider = $1 AND username = $2`, ["test_provider", "test_oauth_user"]);
  if (rows[0].access_token.includes("real-access-token-value")) {
    throw new Error("oauth-repo: expected the stored column to be encrypted, found the plaintext value directly in it");
  }
});
```

Run with `DB_INTEGRATION_TEST_CONFIRM=i-accept-data-loss-in-this-database` per the established pattern, then tear the container down.

- [ ] **Step 4: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no errors

```bash
git add src/kernel/state/oauth-repo.ts src/capabilities/providers/calendar.ts tests/db-integration.test.ts
git commit -m "feat: scope oauth-repo per-user, encrypt tokens at rest"
```

---

## Task 8: OAuth state-ticket store

**Files:**
- Create: `src/kernel/oauth-state-tickets.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Produces: `issueOAuthStateTicket(username: string): string`, `consumeOAuthStateTicket(state: string): string | null` (returns the username, or null)

This mirrors `src/kernel/confirm-tickets.ts` exactly (same proven single-use pattern already used twice in this codebase) — read that file first.

- [ ] **Step 1: Write the failing tests**

```typescript
import { issueOAuthStateTicket, consumeOAuthStateTicket } from "../src/kernel/oauth-state-tickets.js";

registerTest("OAuthStateTickets", "issue then consume round-trips the username", () => {
  const state = issueOAuthStateTicket("test_user");
  const username = consumeOAuthStateTicket(state);
  if (username !== "test_user") {
    throw new Error(`OAuthStateTickets: expected "test_user", got: ${username}`);
  }
});

registerTest("OAuthStateTickets", "single-use — a second consume of the same state fails", () => {
  const state = issueOAuthStateTicket("test_user");
  consumeOAuthStateTicket(state);
  const second = consumeOAuthStateTicket(state);
  if (second !== null) {
    throw new Error(`OAuthStateTickets: expected null on reuse, got: ${second}`);
  }
});

registerTest("OAuthStateTickets", "rejects an unknown state value", () => {
  const result = consumeOAuthStateTicket("not-a-real-state-value");
  if (result !== null) {
    throw new Error(`OAuthStateTickets: expected null for an unknown state, got: ${result}`);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep OAuthStateTickets`
Expected: FAIL — module doesn't exist yet

- [ ] **Step 3: Implement**

Create `src/kernel/oauth-state-tickets.ts` as a close structural copy of `src/kernel/confirm-tickets.ts`, adapted for a simpler single value (`username`) rather than `{buildRequestId, username}`:

```typescript
// Single-use tokens carrying identity across an OAuth redirect — Google's
// callback is the user's own browser navigating back after consent, which
// can't attach an X-API-Key header, so this is how the callback route
// learns which user initiated the connection. Same proven shape as
// src/kernel/confirm-tickets.ts. No separate expiry clock: an OAuth consent
// flow completes in seconds in the same browser tab, so single-use
// (invalidated the moment it's consumed) is sufficient — there's no
// legitimate reason for a state value to survive being read once.
const stateTickets = new Map<string, string>();

export function issueOAuthStateTicket(username: string): string {
  const state = crypto.randomUUID();
  stateTickets.set(state, username);
  return state;
}

export function consumeOAuthStateTicket(state: string): string | null {
  const username = stateTickets.get(state);
  stateTickets.delete(state); // single-use regardless of outcome
  return username ?? null;
}
```

- [ ] **Step 4: Run tests, verify pass, typecheck, commit**

Run: `npx tsc --noEmit && npm test`
Expected: no errors, all tests pass

```bash
git add src/kernel/oauth-state-tickets.ts tests/index.test.ts
git commit -m "feat: add a single-use OAuth state-ticket store"
```

---

## Task 9: Combined "Connect Google Account" routes

**Files:**
- Modify: `src/interaction/routes/integrations-routes.ts`

**Interfaces:**
- Consumes: `oauth-state-tickets.ts` (Task 8), `calendar.ts`'s `getAuthUrl`/`exchangeCodeForTokens` (modified in this task to accept scopes/username)
- Produces: `GET /api/integrations/google/auth-url` (replaces the calendar-only one, requests both Calendar and Gmail scopes), `GET /api/integrations/google/callback` (replaces the calendar-only callback)

- [ ] **Step 1: Widen the requested scope in `calendar.ts`**

In `calendar.ts`, change:

```typescript
const SCOPE = "https://www.googleapis.com/auth/calendar";
```

to:

```typescript
const SCOPE = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
].join(" ");
```

Change `getAuthUrl()`'s signature to accept a `state` parameter and include it in the returned URL:

```typescript
export function getAuthUrl(state: string): string {
  const { clientId, redirectUri } = requireOAuthConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}
```

- [ ] **Step 2: Replace the calendar-only routes in `integrations-routes.ts`**

Replace the existing `/api/integrations/calendar/auth-url` and `/api/integrations/calendar/callback` routes with:

```typescript
integrationsRouter.get("/api/integrations/google/auth-url", validateApiKey, (req: any, res: any) => {
  try {
    const state = issueOAuthStateTicket(req.username);
    res.json({ url: calendar.getAuthUrl(state) });
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

// No validateApiKey — same reasoning as the calendar-only callback this
// replaces: Google's redirect is the user's own browser, which can't carry
// an X-API-Key header. Identity crosses this boundary via the state
// parameter instead, validated below.
integrationsRouter.get("/api/integrations/google/callback", async (req: any, res: any) => {
  const { code, error, state } = req.query;
  if (error) {
    observation.logTelemetry("warn", "Integrations", `Google OAuth authorization denied: ${error}`);
    return res.status(400).send("<html><body>Google account authorization was denied.</body></html>");
  }
  if (!code || !state) {
    return res.status(400).send("<html><body>Missing authorization code or state.</body></html>");
  }
  const username = consumeOAuthStateTicket(state as string);
  if (!username) {
    return res.status(403).send("<html><body>Invalid or expired connection attempt — please try again.</body></html>");
  }
  try {
    await calendar.exchangeCodeForTokens(code as string, username);
    res.send("<html><body>Google account connected — you can close this tab.</body></html>");
  } catch (err: any) {
    observation.logTelemetry("error", "Integrations", `Google OAuth callback failed for "${username}": ${err.message}`);
    res.status(err.status || 500).send("<html><body>Failed to connect your Google account. Try again from the dashboard.</body></html>");
  }
});
```

Note this removed the `requireCapability("calendar.write")` gate the old auth-url route had — issuing an auth URL doesn't itself grant anything (the callback is where real access is established), and every authenticated user should be able to start the connect flow for their own account regardless of whether they already hold `calendar.write` (they might be connecting specifically to establish it). Add the import for `issueOAuthStateTicket`/`consumeOAuthStateTicket` at the top of the file.

- [ ] **Step 3: Update `exchangeCodeForTokens` to accept and use `username`**

In `calendar.ts`, change the signature and its one internal `saveTokens` call:

```typescript
export async function exchangeCodeForTokens(code: string, username: string): Promise<void> {
  // ...unchanged body until the final line...
  await oauthRepo.saveTokens(PROVIDER, username, data.access_token, data.refresh_token, expiry);
  observation.logTelemetry("info", "Integrations", `Google account connected for "${username}".`);
}
```

- [ ] **Step 4: Run tsc, fix any remaining call-site mismatches, run tests, commit**

Task 7 hardcoded `"admin"` for the other 2 `oauth-repo` call sites inside `getValidAccessToken` — those remain hardcoded until Task 10. This task only touches `exchangeCodeForTokens`. Confirm `npx tsc --noEmit` is clean given this partial state (it should be — `getValidAccessToken` doesn't need to change yet, it's still fully self-consistent as an admin-only function until Task 10 threads `username` through it too).

Run: `npx tsc --noEmit && npm test`
Expected: no errors, all tests pass

```bash
git add src/capabilities/providers/calendar.ts src/interaction/routes/integrations-routes.ts
git commit -m "feat: combined Connect Google Account flow with state-token identity"
```

---

## Task 10: Thread `username` through the rest of `calendar.ts`, update every call site

**Files:**
- Modify: `src/capabilities/providers/calendar.ts`
- Modify: `src/capabilities/tools.ts`

**Interfaces:**
- Produces: `getValidAccessToken(username: string)`, `calendarRequest(path, username, init?)`, `listEvents(username: string, timeMinISO?, timeMaxISO?, maxResults?)`, `createEvent(username: string, summary, startISO, endISO, description?)`

- [ ] **Step 1: Thread `username` through the remaining internal functions**

In `calendar.ts`, update `getValidAccessToken`, `calendarRequest`, `listEvents`, and `createEvent` to each accept `username` as their first parameter, replacing the two remaining hardcoded `"admin"` strings from Task 7 with the real parameter, and passing `username` through the internal call chain (`listEvents`/`createEvent` → `calendarRequest` → `getValidAccessToken` → `oauthRepo.getTokens`/`saveTokens`).

- [ ] **Step 2: Update the two chat-tool call sites in `tools.ts`**

`executeTool` already receives `username` as its third parameter (confirmed — it's already used by the `get_briefing` case). Update:

```typescript
case "calendar_list_events":
  output = await calendar.listEvents(args.timeMinISO, args.timeMaxISO);
  break;
case "calendar_create_event":
  output = await calendar.createEvent(args.summary, args.startISO, args.endISO, args.description);
  break;
```

to:

```typescript
case "calendar_list_events":
  output = await calendar.listEvents(username, args.timeMinISO, args.timeMaxISO);
  break;
case "calendar_create_event":
  output = await calendar.createEvent(username, args.summary, args.startISO, args.endISO, args.description);
  break;
```

- [ ] **Step 3: Grep for any other call sites**

Run `grep -rn "calendar\.\(listEvents\|createEvent\|getAuthUrl\|exchangeCodeForTokens\)" src/` and confirm every result matches the new signatures — fix any remaining mismatch (e.g. if `integrations-routes.ts` has a direct calendar route beyond the OAuth ones already updated in Task 9).

- [ ] **Step 4: Add `calendar.read`/`calendar.write` to `DEFAULT_PERSONAL_CAPABILITIES`**

Per this plan's Global Constraints, this is where they finally join the default bundle — the underlying per-user capability now genuinely exists. In `src/kernel/security.ts`, add `"calendar.read"` and `"calendar.write"` to the `DEFAULT_PERSONAL_CAPABILITIES` array, and update the comment above it to remove the "deliberately excluded" language for these two specifically (leave `email.read`/`email.send` still excluded — that's Task 13's job).

- [ ] **Step 5: Run tests, typecheck, commit**

Run: `npx tsc --noEmit && npm test`
Expected: no errors, all tests pass (existing calendar-related tests, if any check the old signatures, need updating — check `tests/index.test.ts` for any direct references to `calendar.listEvents`/`calendar.createEvent` and fix their call sites too)

```bash
git add src/capabilities/providers/calendar.ts src/capabilities/tools.ts src/kernel/security.ts
git commit -m "feat: thread username through calendar.ts, calendar becomes genuinely per-user"
```

---

## Task 11: "Connect Google Account" button and status in the frontend

**Files:**
- Modify: `src/interaction/static/index.html`

**Interfaces:**
- Consumes: `GET /api/integrations/google/auth-url` (Task 9)

- [ ] **Step 1: Add a Connect Google Account button and connection-status display**

In the settings/integrations area of the dashboard (find where TTS/other integration toggles already live, matching existing structure), add a button that calls `GET /api/integrations/google/auth-url`, opens the returned `url` in a new tab/window (`window.open(data.url, '_blank')`), and a status indicator showing whether the current user has a connection (this requires a small new read-only endpoint or reuses `GET /api/permissions` — check whether `hasGrant(username, "calendar.read")` is a reasonable proxy for "connected," or whether a dedicated `GET /api/integrations/google/status` returning whether an `oauth_tokens` row exists for this user is more accurate; prefer the dedicated status endpoint since a capability grant and an actual live connection are conceptually different things — a user could hold the capability without ever having connected).

- [ ] **Step 2: Add the status endpoint if Step 1 determined it's needed**

`GET /api/integrations/google/status` (`validateApiKey` only, no special capability): returns `{connected: boolean}` based on whether `oauthRepo.getTokens("google_calendar", req.username)` returns non-null.

- [ ] **Step 3: Manual verification**

Log in as a personal test user (created via the Task 5 signup flow), confirm the button appears, confirm clicking it opens a real Google consent screen (this part legitimately requires `GOOGLE_CLIENT_ID`/`SECRET`/`REDIRECT_URI` to be configured — if they aren't in your dev environment, verify as much of the flow as possible up to that point and note what couldn't be verified).

- [ ] **Step 4: Commit**

```bash
git add src/interaction/static/index.html src/interaction/routes/integrations-routes.ts
git commit -m "feat: add Connect Google Account button and connection status"
```

---

## Task 12: Personal Gmail provider

**Files:**
- Create: `src/capabilities/providers/personal-gmail.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Produces: `sendPersonalEmail(username: string, to: string, subject: string, text: string): Promise<{messageId: string}>`, `fetchPersonalRecentMessages(username: string, limit?: number): Promise<any[]>`

This is a new module, not a change to the existing `email.ts` (which stays exactly as-is for admin's own SMTP/IMAP-based email — untouched by this entire plan).

- [ ] **Step 1: Implement using the Gmail REST API**

Create `src/capabilities/providers/personal-gmail.ts`, following `calendar.ts`'s exact structural pattern (its own `getValidAccessToken`-equivalent, reusing `oauthRepo.getTokens("google_calendar", username)` — **the same `PROVIDER` string as Calendar**, since both scopes were granted in the same combined OAuth consent in Task 9, so there is only ever one token row per `(provider="google_calendar", username)` covering both):

```typescript
import { ObservationPlatform } from "../../kernel/observation.js";
import * as oauthRepo from "../../kernel/state/oauth-repo.js";
import { fetchWithRetry } from "../../kernel/http-retry.js";

const observation = ObservationPlatform.getInstance();
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const PROVIDER = "google_calendar"; // shared with calendar.ts — one combined OAuth grant covers both scopes

export class PersonalGmailError extends Error {
  constructor(message: string, public status = 500) {
    super(message);
  }
}

async function getValidAccessToken(username: string): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new PersonalGmailError("Google isn't configured — set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET.", 503);
  }
  const stored = await oauthRepo.getTokens(PROVIDER, username);
  if (!stored) {
    throw new PersonalGmailError("You haven't connected a Google account yet — use Connect Google Account in the dashboard.", 401);
  }
  if (new Date(stored.expiry).getTime() > Date.now() + 60_000) {
    return stored.access_token;
  }
  const res = await fetchWithRetry(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: stored.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  }, { label: "Personal Gmail token refresh" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // A refresh failure here (invalid_grant) means the user revoked access
    // on Google's side, or the refresh token otherwise went stale — this is
    // exactly the reconnect-needed case Task 15 handles. Throwing here with
    // a 401 lets that task's handling recognize it and prompt reconnection.
    throw new PersonalGmailError(`Google token refresh failed (${res.status}): ${body}`, 401);
  }
  const data = await res.json() as { access_token: string; expires_in: number };
  const expiry = new Date(Date.now() + data.expires_in * 1000);
  await oauthRepo.saveTokens(PROVIDER, username, data.access_token, stored.refresh_token, expiry);
  return data.access_token;
}

async function gmailRequest(username: string, path: string, init: RequestInit = {}): Promise<any> {
  const accessToken = await getValidAccessToken(username);
  const res = await fetchWithRetry(`${GMAIL_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
  }, { label: `Gmail API ${init.method || "GET"} ${path}` });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new PersonalGmailError(`Gmail API error (${res.status}): ${body}`, res.status);
  }
  return res.json();
}

// Gmail's send endpoint takes a raw base64url-encoded RFC 2822 message, not
// a JSON body of {to, subject, text} — this builds the minimal valid one.
function buildRawMessage(to: string, subject: string, text: string): string {
  const message = [`To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", text].join("\r\n");
  return Buffer.from(message).toString("base64url");
}

export async function sendPersonalEmail(username: string, to: string, subject: string, text: string): Promise<{ messageId: string }> {
  const result = await gmailRequest(username, "/users/me/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw: buildRawMessage(to, subject, text) }),
  });
  observation.logTelemetry("info", "Integrations", `Personal Gmail sent for "${username}": "${subject}" (${result.id})`);
  return { messageId: result.id };
}

export async function fetchPersonalRecentMessages(username: string, limit = 10): Promise<any[]> {
  const list = await gmailRequest(username, `/users/me/messages?maxResults=${limit}`);
  return list.messages || [];
}
```

- [ ] **Step 2: Wire the chat tool dispatch**

In `tools.ts`, the existing `send_email` case calls `emailIntegration.sendEmail` unconditionally (the admin's shared account). Since personal accounts need their *own* email tool distinct from the admin-level one (per this plan's design — the two paths never cross), do not change the existing `send_email` tool's behavior. Instead, this is intentionally deferred: check with the controller whether a new, separate tool declaration (e.g. `send_personal_email`) is wanted for this plan, or whether this is out of scope for the initial rollout (connecting the account and having it available via a future direct API route, per Task 11's pattern, without a chat-tool binding yet). Do not invent a new tool declaration unprompted — this is a real open question the brief flags rather than resolves, since the design spec didn't explicitly commit to a chat-tool-level binding for personal email (only calendar tools were explicitly threaded through in Task 10). If in doubt, implement Step 1 only (the provider exists and is tested) and report this as a decision needed, rather than guessing at new tool-declaration wording.

- [ ] **Step 3: Write tests for the pure/testable pieces**

```typescript
import { PersonalGmailError } from "../src/capabilities/providers/personal-gmail.js";

registerTest("PersonalGmail", "throws a 401 PersonalGmailError with a clear message when no account is connected", async () => {
  const { sendPersonalEmail } = await import("../src/capabilities/providers/personal-gmail.js");
  try {
    await sendPersonalEmail("user_with_no_connection", "someone@example.com", "subject", "body");
    throw new Error("PersonalGmail: expected this to throw");
  } catch (err: any) {
    if (!(err instanceof PersonalGmailError) || err.status !== 401) {
      throw new Error(`PersonalGmail: expected a 401 PersonalGmailError, got: ${err}`);
    }
  }
});
```

Note: this test requires either a live-Postgres-degrades-to-null path (matching this codebase's existing "degrades cleanly when Postgres isn't reachable" convention — `oauthRepo.getTokens` on a fresh/unreachable DB naturally returns null the same way it would for "no connection"), or it belongs in `tests/db-integration.test.ts` if it needs to distinguish "no DB" from "DB reachable but genuinely no row." Follow whichever this codebase's existing similar tests (e.g. `reviewCodeDiff`'s no-client tests) established as the right category — this one likely works fine in the no-Postgres suite since both cases produce the same `null`/401 outcome.

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npx tsc --noEmit && npm test`
Expected: no errors, all tests pass

```bash
git add src/capabilities/providers/personal-gmail.ts tests/index.test.ts
git commit -m "feat: add the personal Gmail provider (Gmail API, per-user OAuth)"
```

---

## Task 13: Add `email.read`/`email.send` to the default bundle, close the loop

**Files:**
- Modify: `src/kernel/security.ts`

**Interfaces:** None new — this is the final piece of the sequencing constraint from Task 2/10.

- [ ] **Step 1: Add the two remaining capabilities to `DEFAULT_PERSONAL_CAPABILITIES`**

Now that personal Gmail access genuinely exists (Task 12), add `"email.read"` and `"email.send"` to the array in `src/kernel/security.ts`, and remove the "deliberately excluded" comment entirely — the full bundle from the design spec is now complete and accurate.

- [ ] **Step 2: Run tests, typecheck, commit**

Run: `npx tsc --noEmit && npm test`
Expected: no errors, all tests pass (the Task 2 subset-invariant test should still pass trivially — these are still real `ALL_CAPABILITIES` entries)

```bash
git add src/kernel/security.ts
git commit -m "feat: complete the default personal capability bundle"
```

---

## Task 14: Disconnect flow (self-service)

**Files:**
- Modify: `src/interaction/routes/integrations-routes.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Produces: `DELETE /api/integrations/google` (self-service, `validateApiKey` only, no special capability — anyone can disconnect their own account)

- [ ] **Step 1: Implement the disconnect route**

```typescript
integrationsRouter.delete("/api/integrations/google", validateApiKey, async (req: any, res: any) => {
  try {
    const stored = await oauthRepo.getTokens("google_calendar", req.username);
    await oauthRepo.deleteTokens("google_calendar", req.username);
    if (stored) {
      // Best-effort: the local deletion above is what actually matters for
      // Jarvis's own access, and must not be blocked by this call failing.
      fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(stored.refresh_token)}`, { method: "POST" })
        .catch((err) => observation.logTelemetry("warn", "Integrations", `Google-side revocation failed for "${req.username}": ${err.message}`));
    }
    observation.logAuditEvent(req.username, "google_account_disconnected", "success", "");
    res.json({ status: "success" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 2: Add a "Disconnect" button next to Task 11's status display**

In `index.html`, add a disconnect button shown when `GET /api/integrations/google/status` reports `connected: true`, calling the new `DELETE` route and refreshing the status display on success.

- [ ] **Step 3: Write the failing test**

```typescript
registerTest("Integrations", "DELETE /api/integrations/google degrades cleanly when Postgres isn't reachable", async () => {
  const result = await oauthRepo.deleteTokens("google_calendar", "nonexistent_user");
  if (result !== false) {
    throw new Error(`Integrations: expected deleteTokens to return false for a nonexistent row, got: ${result}`);
  }
});
```

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npx tsc --noEmit && npm test`
Expected: no errors, all tests pass

```bash
git add src/interaction/routes/integrations-routes.ts src/interaction/static/index.html tests/index.test.ts
git commit -m "feat: add self-service Google account disconnect, revoking on Google's side too"
```

---

## Task 15: Admin remove-user

**Files:**
- Create: `src/interaction/routes/admin-routes.ts`
- Modify: `src/server.ts` (mount)
- Test: `tests/db-integration.test.ts`

**Interfaces:**
- Produces: `DELETE /api/admin/users/:username` (admin-only)

- [ ] **Step 1: Implement**

Create `src/interaction/routes/admin-routes.ts`:

```typescript
import { Router } from "express";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import { getPool } from "../../kernel/state/db.js";
import * as oauthRepo from "../../kernel/state/oauth-repo.js";
import { ObservationPlatform } from "../../kernel/observation.js";

const observation = ObservationPlatform.getInstance();

export const adminRouter = Router();

adminRouter.delete("/api/admin/users/:username", validateApiKey, async (req: any, res: any) => {
  if (req.username !== "admin") {
    return res.status(403).json({ error: "Only admin can remove a user" });
  }
  const { username } = req.params;
  if (username === "admin") {
    return res.status(400).json({ error: "Cannot remove the admin identity" });
  }
  try {
    const stored = await oauthRepo.getTokens("google_calendar", username);
    if (stored) {
      fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(stored.refresh_token)}`, { method: "POST" })
        .catch((err) => observation.logTelemetry("warn", "Integrations", `Google-side revocation failed removing "${username}": ${err.message}`));
    }
    // ON DELETE CASCADE (users -> api_keys, users -> oauth_tokens per
    // migration 007) handles those two tables. kg_entities/self_reflections/
    // proactive_thoughts/conversation_history are username-scoped but were
    // NOT given a foreign key back to users when they were scoped (migration
    // 004 predates users existing as a referenceable identity concept in
    // this shape) — verify this against the actual schema before assuming
    // cascade handles them; if they're plain TEXT columns with no FK, this
    // route must explicitly DELETE from each of those tables by username
    // too, in the same transaction as the users deletion, or personal data
    // survives account removal contrary to this plan's design.
    const db = getPool();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM kg_entities WHERE username = $1`, [username]);
      await client.query(`DELETE FROM self_reflections WHERE username = $1`, [username]);
      await client.query(`DELETE FROM proactive_thoughts WHERE username = $1`, [username]);
      await client.query(`DELETE FROM conversation_history WHERE username = $1`, [username]);
      const { rowCount } = await client.query(`DELETE FROM users WHERE username = $1`, [username]);
      await client.query("COMMIT");
      if (!rowCount) {
        return res.status(404).json({ error: "User not found" });
      }
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    observation.logAuditEvent(req.username, "user_removed", "success", `Removed "${username}"`);
    res.json({ status: "success" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
```

Resolve the inline comment's open question by reading `src/kernel/state/db.ts`'s actual `kg_entities`/`self_reflections`/`proactive_thoughts`/`conversation_history` table definitions before finalizing this list — confirm whether `kg_facts`/`kg_relationships` need their own explicit deletes too (they reference `kg_entities(id)` — check whether that FK is `ON DELETE CASCADE`; if it is, deleting from `kg_entities` alone cascades to them and no separate delete is needed; if not, add explicit deletes for those two tables as well before the `kg_entities` delete, in the same transaction).

- [ ] **Step 2: Mount the router**

Add `app.use(adminRouter)` in `server.ts` alongside the other extracted routers.

- [ ] **Step 3: Write the failing db-integration test**

```typescript
registerTest("admin remove-user cascades personal data deletion, against real Postgres", async () => {
  await usersRepo.createUser("user_to_remove", "a-real-password-123");
  await knowledgeGraphRepo.upsertEntity("user_to_remove", "Test Entity", "concept");
  const db = getPool();
  await db.query(`DELETE FROM kg_entities WHERE username = $1`, ["user_to_remove"]);
  await db.query(`DELETE FROM users WHERE username = $1`, ["user_to_remove"]);
  const { rows } = await db.query(`SELECT * FROM kg_entities WHERE username = $1`, ["user_to_remove"]);
  if (rows.length !== 0) {
    throw new Error("expected all kg_entities rows for the removed user to be gone");
  }
});
```

Adjust this test once Step 1's real transaction logic is finalized — it should exercise the actual route handler's deletion logic (or the equivalent repo-level calls it makes), not just re-derive the SQL inline as shown above; the version here is a starting shape, not the final test.

- [ ] **Step 4: Run tests (including throwaway-Postgres verification), typecheck, commit**

Run: `npx tsc --noEmit && npm test`, then the db-integration suite against a throwaway container.
Expected: no errors, all tests pass

```bash
git add src/interaction/routes/admin-routes.ts src/server.ts tests/db-integration.test.ts
git commit -m "feat: add admin user removal with full personal-data cascade deletion"
```

---

## Task 16: Reconnect-needed detection and notification

**Files:**
- Modify: `src/capabilities/providers/calendar.ts`
- Modify: `src/capabilities/providers/personal-gmail.ts`

**Interfaces:** None new — this hardens existing error paths from Tasks 10 and 12.

- [ ] **Step 1: On a token-refresh failure, notify instead of just throwing**

In both `calendar.ts`'s `getValidAccessToken` and `personal-gmail.ts`'s `getValidAccessToken`, in the branch where `refreshAccessToken`'s (or the equivalent inline fetch's) response is not `ok`, before throwing the existing error: also fire a push notification to that user via `scheduler.pushNotification` (import it — check the exact import path/pattern used elsewhere, e.g. `build-approval.ts`), something like `` `Your Google connection needs renewing, sir — click Connect Google Account again in the dashboard.` ``, type `"warning"`. This should not block or delay the throw (fire-and-forget, matching this codebase's existing notification conventions) — the tool call still fails with a clear message either way; this adds a second, more durable signal the user will actually see even if they're not staring at the failed chat response.

Do not fire this notification on every failed API call — only specifically on a refresh-token failure (the case that means reconnection is actually needed), not on a transient network error or a different kind of API failure that doesn't indicate the connection itself is broken.

- [ ] **Step 2: Manual trace verification**

Read both modified functions and confirm: a transient 500 from Google's token endpoint does NOT fire the reconnect notification (that's not a "reconnect needed" situation, just a retry-able blip — though note `fetchWithRetry` already handles retries for idempotent-safe cases; a token refresh is a POST, so per this codebase's existing retry semantics it won't auto-retry regardless, but the DISTINCTION that matters here is specifically "the token itself is invalid" vs "the request itself failed for some other transient reason" — an `invalid_grant`/401-style response is the token-invalid case; other status codes are not, and should not fire this notification since reconnecting wouldn't help). Adjust the failure-branch condition to check specifically for a 400/401-class response if the current code doesn't already distinguish this precisely enough.

- [ ] **Step 3: Run tests, typecheck, commit**

Run: `npx tsc --noEmit && npm test`
Expected: no errors, all tests pass

```bash
git add src/capabilities/providers/calendar.ts src/capabilities/providers/personal-gmail.ts
git commit -m "feat: notify users when their Google connection needs to be renewed"
```

---

## Task 17: Bulk capability rollout (`grant-all`)

**Files:**
- Modify: `src/interaction/routes/permissions-routes.ts`
- Test: `tests/db-integration.test.ts`

**Interfaces:**
- Produces: `POST /api/permissions/grant-all` (admin-only, body `{capability: string}`)

- [ ] **Step 1: Implement**

Add to `permissions-routes.ts`:

```typescript
permissionsRouter.post("/api/permissions/grant-all", validateApiKey, async (req: any, res: any) => {
  if (req.username !== "admin") {
    return res.status(403).json({ error: "Only admin can bulk-grant capabilities" });
  }
  const { capability } = req.body;
  if (!capability) {
    return res.status(400).json({ error: "capability is required" });
  }
  if (!(permissions.ALL_CAPABILITIES as readonly string[]).includes(capability)) {
    return res.status(400).json({ error: `Unknown capability "${capability}"` });
  }
  const usernames = await usersRepo.listUsernames();
  const granted: string[] = [];
  for (const username of usernames) {
    if (username === "admin") continue; // admin already has every ALL_CAPABILITIES entry via bootstrap
    if (!permissions.hasGrant(username, capability)) {
      await permissions.grantCapability(username, capability, req.username);
      granted.push(username);
    }
  }
  res.json({ status: "success", capability, grantedTo: granted });
});
```

Add the `usersRepo` import (`../../kernel/state/users-repo.js`) at the top of the file.

- [ ] **Step 2: Write the failing test**

```typescript
registerTest("grant-all grants a capability to every existing non-admin user, against real Postgres", async () => {
  await usersRepo.createUser("bulk_grant_user_1", "a-real-password-123");
  await usersRepo.createUser("bulk_grant_user_2", "a-real-password-123");
  const usernames = await usersRepo.listUsernames();
  for (const username of usernames) {
    if (username === "admin") continue;
    if (!permissions.hasGrant(username, "news.read")) {
      await permissions.grantCapability(username, "news.read", "admin");
    }
  }
  if (!permissions.hasGrant("bulk_grant_user_1", "news.read") || !permissions.hasGrant("bulk_grant_user_2", "news.read")) {
    throw new Error("expected both users to have the bulk-granted capability");
  }
});
```

- [ ] **Step 3: Run tests, typecheck, commit**

Run: `npx tsc --noEmit && npm test`, then the db-integration suite against a throwaway container.
Expected: no errors, all tests pass

```bash
git add src/interaction/routes/permissions-routes.ts tests/db-integration.test.ts
git commit -m "feat: add a one-click bulk capability rollout for existing users"
```

---

## Final check

- [ ] Run `npx tsc --noEmit && npm test && npm run test:db` one more time end to end (the last with a throwaway Postgres) and confirm everything passes together.
- [ ] Confirm `grep -rn "ALLOW_REGISTRATION" src/` reflects the actual final state (either fully removed, or explicitly still used somewhere with a documented reason).
- [ ] Confirm `DEFAULT_PERSONAL_CAPABILITIES` contains exactly the 10 capabilities the design spec specifies (8 initial + calendar.read/write + email.read/send), no more, no less.
- [ ] Manually verify the full happy path once, with real Google credentials configured: generate an invite, redeem it, connect a real Google account, confirm calendar/email tool calls work for that new personal identity, disconnect, confirm the tokens are gone both locally and (check via `https://myaccount.google.com/permissions`) on Google's side.
- [ ] Update `README.md`/`ARCHITECTURE.md` if either documents the old single-tenant registration/OAuth model, so the docs-accuracy check (`scripts/check-docs-accuracy.sh`) doesn't fail and future readers aren't misled.
