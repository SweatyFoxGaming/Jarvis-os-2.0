# Biometric Login (WebAuthn/Passkeys) — Design Spec

## Problem

Jarvis currently authenticates every account (admin and personal) with a typed username/password (`POST /api/login`, `src/interaction/routes/auth-routes.ts`), which exchanges valid credentials for an `api_key` the client then uses for every subsequent request. The user wants a stronger, more convenient day-to-day unlock — facial or fingerprint recognition — as an added security measure.

## Goal

Day-to-day login becomes "tap to unlock with Face ID / Windows Hello / fingerprint" instead of typing a password, using each device's own native biometric hardware via the browser's built-in WebAuthn API. Password login stays fully intact underneath as the fallback (lost/new device, no biometric hardware, non-WebAuthn browser) — nothing about the existing login is removed. Available to any account, admin or personal, opt-in per user.

## Design, confirmed with the project owner before implementation

### Where the biometric check happens

**Device-native only (WebAuthn), never server-side facial recognition.** The browser calls `navigator.credentials.get()`; the OS shows its own native Face ID / Windows Hello / Android fingerprint prompt and verifies locally. The OS then signs a server-issued one-time challenge with a private key that never leaves the device's secure hardware (Secure Enclave / TPM / Android Keystore). Jarvis's server only ever sees and stores a **public key** — it never receives, stores, or evaluates any actual biometric data (no face images, no fingerprint templates). This is the same mechanism behind "Sign in with passkey" on major sites, not a custom biometric pipeline.

### New dependency

`@simplewebauthn/server` (Node) and `@simplewebauthn/browser` (client) — the standard, actively-maintained libraries for this exact flow. WebAuthn's underlying cryptographic verification (attestation/assertion signature checking, challenge/origin validation, counter-based clone detection) is genuinely security-critical and not something to hand-roll; these libraries are what virtually every production WebAuthn integration is built on.

### Data model

New migration `013_webauthn_credentials.ts`:

```sql
CREATE TABLE webauthn_credentials (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,      -- base64url, from the authenticator
  public_key BYTEA NOT NULL,               -- COSE public key, from @simplewebauthn/server's verification result
  counter BIGINT NOT NULL DEFAULT 0,       -- clone-detection signature counter
  device_label TEXT NOT NULL,              -- user-chosen or auto-generated, e.g. "iPhone", "Work laptop"
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX idx_webauthn_credentials_username ON webauthn_credentials(username);
```

One row per enrolled device per user — a user can enroll multiple devices (phone + laptop), each independently revocable. `ON DELETE CASCADE` matches the existing FK convention this codebase already uses for per-user rows (verified against `db.ts`'s real FK definitions, per the existing pattern other migrations already follow).

### New routes (`src/interaction/routes/auth-routes.ts`, alongside the existing `/api/register`/`/api/login`)

**Enrollment (requires an already-authenticated session — `validateApiKey`, not `authLimiter`-gated the way login is, since this isn't a credential-guessing surface):**
- `POST /api/webauthn/register-options` — server generates a challenge (via `@simplewebauthn/server`'s `generateRegistrationOptions`), stores it short-lived (same in-memory ticket pattern `oauth-state-tickets.ts` already uses for OAuth's CSRF-binding state, reused here rather than inventing a second short-lived-token mechanism), returns the options blob the browser needs to call `navigator.credentials.create()`.
- `POST /api/webauthn/register-verify` — receives the browser's attestation response + a `deviceLabel`, verifies it against the stored challenge via `verifyRegistrationResponse`, inserts the new `webauthn_credentials` row.

**Login (unauthenticated, like `/api/login` — needs the same `authLimiter` treatment since a forged assertion attempt is exactly the credential-guessing class that limiter exists for):**
- `POST /api/webauthn/login-options` — takes `username`, generates a challenge (`generateAuthenticationOptions`) scoped to that user's enrolled credential IDs, returns it.
- `POST /api/webauthn/login-verify` — receives the browser's signed assertion, verifies it (`verifyAuthenticationResponse`) against the matching `webauthn_credentials` row's stored public key, updates `counter`/`last_used_at`, and on success returns **the exact same `{ username, api_key }` shape `/api/login` already returns** (via the existing `usersRepo.getOrCreateApiKey`) — so every downstream client-side code path (storing `CURRENT_API_KEY`, all subsequent `X-API-Key` requests) needs zero changes beyond how that shape gets produced.

### UI changes (`src/interaction/static/index.html`)

- **Login screen:** "Unlock with Face ID / fingerprint" as the primary, default action when the browser supports WebAuthn (`window.PublicKeyCredential` exists) and the entered/remembered username has at least one enrolled credential — falls through to the existing password form otherwise, with a manual "use password instead" link always available.
- **Account settings:** a new "Biometric devices" section — "Add this device" (triggers enrollment), and a list of already-enrolled devices with their label, last-used date, and a "Remove" action (`DELETE /api/webauthn/credentials/:id`, ownership-checked against `req.username`).

### Error handling

- WebAuthn unsupported browser / no enrolled credential for this username: silently fall through to the password form, no error surfaced (this is an expected, common case, not a failure).
- Assertion verification fails (bad signature, counter regression suggesting a cloned authenticator, expired/mismatched challenge): `401`, same generic "Invalid credentials" the password path already returns — never reveal which specific check failed.
- Registration challenge expired or mismatched origin: `400`, clear "That didn't complete in time, try again" — a real UX case (the user closing/reopening the OS prompt), not a security-sensitive one.

## Testing approach

- **`@simplewebauthn/server`'s verification functions**: unit-tested via the library's own documented test vectors/fixtures (mocking a real, valid attestation/assertion payload) rather than needing a real physical authenticator — this is exactly how the library's own test suite and its downstream integrations are conventionally tested.
- **Route-level tests**: fake credential rows in a test DB, asserting `register-verify` correctly inserts a row, `login-verify` correctly returns `{username, api_key}` on a valid assertion and `401` on a tampered one, and correctly rejects a login attempt using another user's `credential_id`.
- **Manual, the user's own step, not verifiable from this sandboxed dev environment**: enrolling and logging in with a real device's Face ID/Windows Hello/fingerprint sensor — no real biometric hardware or OS-level authenticator exists in this sandbox to exercise end to end.

## Explicitly deferred / not in scope

- Server-side facial recognition (a real camera capturing and comparing faces) — explicitly rejected in favor of device-native WebAuthn; would require enrollment photo storage, liveness/spoof detection, and a materially larger privacy/security surface.
- Step-up re-authentication before specific sensitive in-session actions (e.g. re-prompting biometric before revealing a plaintext API key) — this spec covers primary login only; step-up is a natural follow-up once primary login is live, not built here.
- Cross-device credential sync (passkeys that follow a user across devices via iCloud Keychain/Google Password Manager) — each enrolled credential here is tied to the specific device it was created on, the simpler and more common WebAuthn deployment shape; platform-level passkey sync is a browser/OS feature that may partially apply automatically depending on the user's own device setup, but isn't something this design builds or depends on.
