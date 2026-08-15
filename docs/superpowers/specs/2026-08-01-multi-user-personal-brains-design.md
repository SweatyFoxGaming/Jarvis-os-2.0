# Multi-User Access, Personal Brains, and a Shared Core — Design Spec

**Status:** approved by user via brainstorming dialogue (2026-08-01)

## Problem

Jarvis is single-tenant today in every way that matters for a real multi-person group.
Registration exists but is off by default (`ALLOW_REGISTRATION=false`); a self-registered
user starts with zero capability grants and stays that way until admin manually grants
each one — there is no path to a working personal assistant without hands-on admin
provisioning per person, per capability. Every external integration (Gmail, Google
Calendar) is single-tenant: one shared credential set for the whole deployment, keyed
globally, not per user. `oauth_tokens` has a bare `provider TEXT PRIMARY KEY` — one row
per provider, period. A second person "connecting their email" today would mean handing
Jarvis the admin's own Gmail access, not their own.

Long-term memory is a mixed bag: `kg_entities`/`kg_facts`/`kg_relationships`,
`self_reflections`, `proactive_thoughts`, and `conversation_history` are already correctly
scoped per username (fixed after a real cross-user leak was found previously).
`memory_records`, on inspection, turns out to be Jarvis's own curated general/operational
knowledge with an admin-approval workflow (`briefing-memory-routes.ts`), not raw personal
facts — closer to "shared skills/general knowledge" than "private facts about a specific
person."

The user wants a small, trusted group — a hard cap of 10 people — each with their own
login, each able to connect their own personal Google account (email + calendar) so Jarvis
can act on their behalf specifically, with onboarding that's actually automated (no
manual per-person capability provisioning), and Jarvis's core personality/skills/learning
remaining one shared thing across everyone rather than fragmenting per user.

## Non-goals

- **No true fact-distillation hive-mind.** The user explicitly chose the simpler model:
  Jarvis stays one shared entity (personality, learned skills, general knowledge) with each
  person's private facts and connected-account content strictly isolated to them — not a
  system where private facts from one person get generalized and folded into what everyone
  else's Jarvis knows. That's a real, harder problem (safe generalization without leaking
  PII) explicitly deferred, not attempted here.
- **No open/public registration.** Invite-only, hard-capped at 10 accounts. `ALLOW_REGISTRATION`
  is replaced by invite-token validation, not supplemented by it.
- **No per-user vault or files scoping in this pass.** `vault.read`/`vault.write`/
  `files.read`/`files.write` stay off the table for personal users entirely — these are
  single shared spaces today (effectively the admin's own notes), and granting them to
  multiple people would defeat the isolation this whole spec is for. Making them genuinely
  per-user is a future, separate piece of work if ever wanted.
- **No automatic capability backfill on deploy.** When a new capability is added to the
  codebase, it does not silently reach existing users. Extending it to everyone already
  onboarded is one deliberate admin action (`grant-all`), never a side effect of a code
  change — preserving this codebase's existing principle that every grant is an explicit,
  audited human decision, established by the `ALL_CAPABILITIES`/`EXTRA_GRANTABLE_CAPABILITIES`
  split.
- **No fix to the Groq shared-quota problem or backup/restore testing here.** Both are
  real, pre-existing risks (from the earlier platform review) that this rollout makes more
  consequential — more simultaneous users compete for the same LLM quota, and a DB loss now
  means losing multiple people's personal accounts and history, not just one operator's.
  Tracked as explicit follow-ups, not fixed in this spec.
- **No "deactivate, keep data" option.** Removing a user is full deletion of their account
  and personal data. A softer deactivate-but-retain path is a reasonable future addition,
  not default behavior here.
- **No in-app privacy/consent explainer UI.** Google's own OAuth consent screen covers the
  legal minimum; a friendlier in-app explanation of what Jarvis does with a connected
  account is a nice-to-have for a trusted circle of 10, not required for this pass.

## Architecture — the shape of a new person joining

```
Admin generates an invite (checks the 10-person cap)
        │
        ▼
Person opens the invite link → registers (invite token required, not ALLOW_REGISTRATION)
        │
        ▼
Account created, DEFAULT_PERSONAL_CAPABILITIES granted automatically
        │
        ▼
Person is immediately functional (chat, web search, sandbox, etc.) — no admin step needed
        │
        ▼
Whenever they want: "Connect Google Account" → OAuth consent (Calendar + Gmail scopes)
        │
        ▼
Their tokens stored (encrypted) keyed to (provider, their username)
        │
        ▼
"Check my email" / "add to my calendar" now uses THEIR token — admin's own
email/calendar integration is completely untouched throughout
```

Everything a person tells Jarvis about themselves lands in tables already scoped to their
username (`kg_facts` etc.) — no new personal-data table is needed; the fix is routing
discipline (personal facts never write to the shared `memory_records`), not new schema.

## Data model

**`invite_tokens`** (new):
```sql
CREATE TABLE invite_tokens (
  token TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_by TEXT NULL,
  used_at TIMESTAMPTZ NULL
);
```
A `used_by` value makes redemption single-use and self-documenting (who used which invite).

**`oauth_tokens`** (modified): primary key changes from `provider` alone to
`(provider, username)`, with `username TEXT NOT NULL REFERENCES users(username) ON DELETE
CASCADE` — removing a user cleanly removes their connected-account tokens. `access_token`/
`refresh_token` are stored **encrypted** (see Components below), not plaintext — this
applies to every row including the existing admin calendar row once the migration runs.

**`DEFAULT_PERSONAL_CAPABILITIES`** (new constant, `src/kernel/security.ts`, alongside the
existing `ALL_CAPABILITIES`/`EXTRA_GRANTABLE_CAPABILITIES`):
```ts
export const DEFAULT_PERSONAL_CAPABILITIES = [
  "web.search",
  "news.read",
  "tts.speak",
  "knowledge.read",
  "identity.read",
  "hud.read",
  "feature.propose",
  "system.sandbox_execute",
  // calendar.read/write and email.read/send join this list once the
  // per-user OAuth components below actually ship — granting them before
  // that lands would point a new user at the shared admin Google account,
  // not their own. Do not add them here until that work is live.
] as const;
```

No new table for personal facts — `kg_facts`/`kg_relationships`/`kg_entities` (already
username-scoped) are the destination for anything personal extracted from a connected
account, exactly as they already are for anything learned in conversation.

## Components

**1. Invite system** — `POST /api/invites` (admin-only): checks
`COUNT(*) FROM users WHERE username != 'admin' < 10` before minting — the cap is 10
invited/personal accounts *in addition to* the admin/operator identity, not 10 accounts
total including admin, matching "a user group of max 10 people" as distinct from the
person running the deployment. A 7-day-expiry token; returns a shareable URL. `DELETE
/api/invites/:token` (admin-only) revokes an unused one.

**2. Registration** — `POST /api/register` requires a valid, unused, unexpired invite
token instead of checking `ALLOW_REGISTRATION`. On success: creates the user, marks the
invite used, grants `DEFAULT_PERSONAL_CAPABILITIES`, returns an API key immediately (same
response shape as today).

**3. Token encryption** — a small helper (e.g. `src/kernel/token-crypto.ts`) wrapping
Node's built-in `crypto` module: AES-256-GCM, a dedicated `OAUTH_TOKEN_ENCRYPTION_KEY`
environment variable (32 random bytes, base64-encoded — generated once via `openssl rand
-base64 32`, documented in `.env.example`), IV + auth tag + ciphertext packed into one
stored string. Startup fails loudly if this key is missing or malformed once this feature
ships, matching the existing `INTERNAL_API_KEY` "refuse to start with a guessable/default
key" precedent — this is not an optional hardening step, it protects real people's real
email access.

**4. Per-user Google OAuth flow** — one combined "Connect Google Account" button
requesting both Calendar and Gmail scopes in a single consent screen, reusing the existing
`GOOGLE_CLIENT_ID`/`SECRET`/`REDIRECT_URI` (one registered Google app, many users' individual
consents). The callback can't carry an `X-API-Key` (it's the user's own browser navigating
back from Google) — identity crosses that boundary via OAuth's `state` parameter, carrying
a short-lived, single-use, username-bound token minted the same way as this codebase's
existing confirm-ticket/voice-ticket pattern. The callback validates and consumes it, then
stores the resulting tokens (encrypted) as `(provider, that_username)`.

**5. Personal Gmail provider** — a new module (not a change to the existing `email.ts`,
which stays exactly as-is for admin's own SMTP/IMAP-based email). Uses the real Gmail API
with the per-user OAuth token, since that's what the OAuth consent actually grants —
cleaner than retrofitting SMTP/IMAP onto OAuth tokens.

**6. `calendar.ts` extended in place** — add a `username` parameter to its existing
functions (already OAuth-based, the pattern transfers directly) rather than duplicating it.

**7. Tool-dispatch routing** — when a user asks about "my email"/"my calendar", the tool
layer passes `req.username` through to the per-user provider functions. Admin-level
email/calendar tools (briefings, autonomous objectives) are untouched, on a separate code
path that never reads per-user tokens.

**8. Disconnect flow** — self-service endpoint deletes that user's `oauth_tokens` row and
makes a best-effort call to Google's revocation endpoint
(`POST https://oauth2.googleapis.com/revoke?token=...`) so the grant is actually cut on
Google's side, not just forgotten locally.

**9. Admin remove-user** — `DELETE /api/admin/users/:username` (admin-only): full cascade
delete of the account, personal facts/history, and connected-account tokens (with the same
Google-side revocation as #8), plus clearing their capability grants. Full removal, not a
soft deactivate.

**10. Reconnect detection** — when a Google API call fails on token refresh (revoked/
expired), the provider marks that connection as needing reconnect rather than surfacing a
raw API error, and pushes a real notification through the existing push-notification system
("Your Google connection needs renewing — click Connect Google Account again") — not just a
failed tool-call response the user might not even see.

**11. Bulk capability rollout** — `POST /api/permissions/grant-all` (admin-only): given a
capability name, grants it to every existing user who doesn't already have it, calling the
same `grantCapability` function per user underneath (so each grant is still individually
audited) rather than any silent bulk-write. This is the mechanism for both "extend an
existing capability to everyone" and "roll out a brand-new one to the whole group" — one
click instead of ten manual grants, with every grant still an explicit, recorded action.

## Error handling

- **Invite redemption**: expired, already-used, or unknown tokens are rejected with a
  clear message, no partial account creation.
- **10-person cap**: rejected clearly at invite-generation time, not buried until
  registration fails later.
- **OAuth state token**: single-use regardless of outcome (same discipline as the existing
  confirm-ticket/voice-ticket pattern) — a replayed or forged `state` value is rejected,
  never silently accepted.
- **Token decryption failure** (e.g. the encryption key was rotated without a migration
  path): fails closed — treated as "not connected," the user is prompted to reconnect,
  never a crash or a silent fallback to an unencrypted read.
- **Google API auth failures**: never surfaced as a raw upstream error to the user or the
  LLM — always translated into the reconnect-needed state and notification described in
  Component 10.
- **Remove-user**: if the best-effort Google revocation call fails, the local deletion
  still proceeds (their Jarvis access is definitely gone even if Google-side revocation
  needs a retry) — logged, not blocking.

## Testing

- Unit tests: 10-person cap enforcement (pure logic over a count), invite token
  validation (expired/used/unknown), `DEFAULT_PERSONAL_CAPABILITIES` grant-on-redemption,
  encrypt/decrypt round-trip (including a tampered-ciphertext case, which must fail closed
  not throw an unhandled exception), `grant-all`'s per-user grant loop.
- Integration-style (throwaway Postgres, matching this codebase's established pattern):
  invite → register → verify default capabilities actually landed; remove-user → verify
  cascade deletion of facts/history/tokens.
- **Live Google OAuth round-trips are not tested here**, matching this codebase's existing
  discipline around not exercising real third-party write APIs in automated tests — verified
  by careful code tracing during implementation, with real manual verification (one person
  actually connecting a real account) as a deliberate, separate step before this is trusted,
  not something a subagent or test suite does automatically.

## Open follow-ups (explicitly out of scope here)

- Groq's shared LLM rate/token quota has no per-consumer coordination — more simultaneous
  users makes this ceiling more likely to matter.
- Postgres backup/restore has never been tested end-to-end — this rollout raises the stakes
  of that gap from "you lose your own data" to "you lose everyone's."
- Per-user vault/files scoping, if ever wanted.
- A "deactivate but keep data" option alongside full user removal.
- An in-app explanation of what a connected Google account is used for, beyond Google's own
  consent screen.
- **No key-rotation tooling for `OAUTH_TOKEN_ENCRYPTION_KEY`.** The fail-closed behavior on
  decryption failure (see Error handling) protects against a botched rotation corrupting
  data silently, but there's no supported procedure here for rotating the key and
  re-encrypting existing rows. If that's ever needed, it's a follow-up, not assumed solved
  by "fails closed."

**Next priority after this ships:** a broader pass specifically on hardening Jarvis's own
security posture — the user's explicit next focus, given the stakes of running real
personal accounts for multiple people.
