import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  generateRegistrationOptions as realGenerateRegistrationOptions,
  verifyRegistrationResponse as realVerifyRegistrationResponse,
  generateAuthenticationOptions as realGenerateAuthenticationOptions,
  verifyAuthenticationResponse as realVerifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { validateApiKey, ADMIN_API_KEY } from "../../kernel/auth-middleware.js";
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

// login-verify actually grants access on success (a forged/replayed
// assertion is the identical credential-guessing class auth-routes.ts's
// authLimiter exists for on /api/login), so it keeps that exact
// 20-per-15-minutes IP-keyed budget. login-options never grants access by
// itself — it only returns whether an account has credentials plus a
// throwaway challenge — but it's called automatically on EVERY login-page
// render (see index.html's attemptWebauthnFirstLogin()), so it needs its
// own, separate, more generous budget: sharing one rateLimit(...)
// instance/store between the two routes would let ordinary page-load
// traffic burn through the same budget login-verify needs for actual
// unlock attempts, especially since this deployment's real gateway strips
// the Host header with no trust-proxy configured, collapsing req.ip to one
// shared value for every real caller (see currentRpId/currentOrigin's
// comment above for the same underlying proxy fact). 3x login-verify's
// limit, same window and message shape, keeps it in the same order of
// magnitude as the established 20-per-15-minutes pattern while being
// meaningfully more forgiving for a call this low-risk and this frequent.
const webauthnLoginOptionsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts, try again later" },
});
const webauthnLoginVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts, try again later" },
});

// IP-keyed limiting alone only bounds guesses from a single source address
// — a distributed attacker using many source IPs (or, in this deployment,
// every real caller collapsing to the same req.ip because of the
// stripped-Host/no-trust-proxy gap noted above) could otherwise throw
// unlimited guesses at one specific account with no per-account backoff.
// Mirrors auth-routes.ts's loginUsernameLimiter exactly for login-verify
// (same 20-per-15-minutes window/limit, same lowercased-username keying,
// same message shape) since it protects the identical
// grants-access-on-success action. login-options gets its own separate,
// more generous username-keyed instance for the same page-load-traffic
// reason the IP-keyed split above exists — attemptWebauthnFirstLogin()
// calls login-options with the remembered username on every render, and
// that must not be able to exhaust the budget a real login-verify attempt
// for that same account will need moments later.
const webauthnLoginOptionsUsernameLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => (typeof req.body?.username === "string" ? req.body.username.toLowerCase() : "unknown"),
  message: { error: "Too many attempts for this account, try again later" },
});
const webauthnLoginVerifyUsernameLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => (typeof req.body?.username === "string" ? req.body.username.toLowerCase() : "unknown"),
  message: { error: "Too many attempts for this account, try again later" },
});

// rpID must equal the exact domain the browser used to reach the server,
// and expectedOrigin must equal the exact scheme+host the browser sent in
// its Origin header — but this deployment's only externally-reachable path
// is a separate FastAPI gateway (src/api.py) that strips the incoming Host
// header before proxying to this Express app, and this Express app never
// calls app.set('trust proxy', ...). So req.hostname/req.protocol/
// req.get('host') never reflect the browser's real origin in the real
// deployment — every real WebAuthn ceremony over HTTPS would fail origin
// validation if we relied on them alone.
//
// invites-routes.ts's buildInviteUrl() already hit this exact
// operator-must-configure-the-real-origin problem for invite links, and
// established the fix: prefer process.env.PUBLIC_BASE_URL (the one place
// this deployment's externally-reachable origin is actually configured,
// e.g. a Tailscale Serve hostname) when it's set, and fall back to
// request-derived values otherwise. We follow the same pattern here: once
// an operator sets PUBLIC_BASE_URL (which they may already have, for
// invites), rpID/expectedOrigin become correct for real ceremonies. This
// does NOT fix the proxy/trust-proxy problem for an operator who hasn't
// set PUBLIC_BASE_URL — that's a real, separate infra decision (whether to
// trust the proxy, and how) outside this fix wave's scope, not something
// to silently paper over here.
//
// Falling back to req.hostname/req.protocol+req.get('host') when
// PUBLIC_BASE_URL is unset keeps existing dev/local behavior (a Tailscale
// MagicDNS name, localhost, etc.) working exactly as before. Real browsers
// require rpID to be a genuine domain name — a bare IP address will not
// work; this is a real operational constraint of WebAuthn itself, not a
// gap in this code.
function currentRpId(req: any): string {
  const base = process.env.PUBLIC_BASE_URL;
  if (base) {
    try {
      return new URL(base).hostname;
    } catch {
      // Malformed PUBLIC_BASE_URL — fall through to the request-derived value
      // rather than crash a login/registration attempt over an operator typo.
    }
  }
  return req.hostname;
}
function currentOrigin(req: any): string {
  const base = process.env.PUBLIC_BASE_URL;
  if (base) {
    try {
      const url = new URL(base);
      return `${url.protocol}//${url.host}`;
    } catch {
      // Malformed PUBLIC_BASE_URL — fall through to the request-derived value.
    }
  }
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

  router.post("/api/webauthn/login-options", webauthnLoginOptionsLimiter, webauthnLoginOptionsUsernameLimiter, async (req: any, res: any) => {
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

  router.post("/api/webauthn/login-verify", webauthnLoginVerifyLimiter, webauthnLoginVerifyUsernameLimiter, async (req: any, res: any) => {
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
      // No stored row for this credential id at all — there's nothing to
      // run cryptographic verification against, so this is the one
      // legitimate case that skips it. A real WebAuthn credential_id is a
      // large random value from actual authenticator hardware, not
      // realistically guessable/enumerable, so this narrow asymmetry is
      // much lower risk than the wrong-owner case below.
      if (!storedCredential) {
        observation.logAuditEvent(username, "webauthn-login", "failed", "No matching credential for this id");
        return res.status(401).json({ error: "Invalid credentials" });
      }
      // Whenever a stored credential is found at all, verification always
      // runs against it — on the SAME code path whether its owner matches
      // the claimed username or not. Ownership is folded into the final
      // accept decision below rather than short-circuited beforehand, so a
      // "wrong owner" attempt and a "right owner, bad signature" attempt
      // both pay the same crypto-verification cost. Otherwise, returning
      // early on an ownership mismatch would let response timing alone
      // reveal whether a given credential_id belongs to a specific
      // username, even though both cases return the identical body.
      //
      // @simplewebauthn/server's verifyAuthenticationResponse only RETURNS
      // {verified:false} for a bad signature. Every other rejection reason
      // — challenge mismatch, origin mismatch, RP-ID mismatch,
      // user-not-present, user-verification failure, and counter regression
      // (specifically how a cloned/replayed authenticator gets caught) —
      // THROWS instead. The spec requires all of these to be
      // indistinguishable from the client's point of view: the same generic
      // 401 "Invalid credentials", never a 503 (a 503 must mean a real
      // infra problem, not "your credential didn't verify"). So this call
      // gets its own try/catch, separate from the outer one below (which is
      // reserved for genuine infra failures — getCredentialById,
      // updateCounterAndLastUsed, getOrCreateApiKey/the admin path). Any
      // throw here is treated exactly like an explicit verified:false.
      let result;
      try {
        result = await deps.verifyAuthenticationResponse({
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
      } catch (verifyErr: any) {
        observation.logAuditEvent(
          username,
          "webauthn-login",
          "failed",
          `Assertion verification threw: ${verifyErr.message}`
        );
        return res.status(401).json({ error: "Invalid credentials" });
      }
      const ownershipMatches = storedCredential.username === username;
      if (!result.verified || !ownershipMatches) {
        observation.logAuditEvent(
          username,
          "webauthn-login",
          "failed",
          ownershipMatches ? "Assertion verification failed" : "No matching credential for this username"
        );
        return res.status(401).json({ error: "Invalid credentials" });
      }
      await webauthnRepo.updateCounterAndLastUsed(storedCredential.credential_id, result.authenticationInfo.newCounter);
      // "admin" is the synthetic operator identity backed by
      // ADMIN_API_KEY/INTERNAL_API_KEY — never a real row in the `users`
      // table. usersRepo.getOrCreateApiKey() inserts into `api_keys`, which
      // has a FOREIGN KEY on users(username); calling it for "admin" always
      // throws a FK violation, which the outer catch below would turn into
      // a misleading 503 even though the WebAuthn ceremony itself genuinely
      // succeeded. register-verify has no such FK, so admin can enroll a
      // device fine and then never be able to use it — this special-case
      // is what actually makes that login succeed, returning the real
      // ADMIN_API_KEY directly instead of trying to mint a per-user key
      // that can't exist for this identity.
      const apiKey = username === "admin" ? ADMIN_API_KEY : await usersRepo.getOrCreateApiKey(username);
      observation.logAuditEvent(username, "webauthn-login", "success", `Signed in via device "${storedCredential.device_label}"`);
      res.json({ username, api_key: apiKey });
    } catch (err: any) {
      // By construction, this only fires for a genuine thrown exception —
      // a DB error from getCredentialById/updateCounterAndLastUsed/
      // getOrCreateApiKey — since verifyAuthenticationResponse throwing is
      // now caught above and turned into the same 401 a completed-but-
      // invalid verification (verified:false or an ownership mismatch)
      // already gets, and neither of those reaches here either. Mirrors
      // /api/login's (auth-routes.ts) wording for the same
      // infrastructure-failure class, so a real outage isn't misreported to
      // WebAuthn users as "your credential is invalid."
      observation.logTelemetry("warn", "Webauthn", `login-verify failed for "${username}": ${err.message}`);
      res.status(503).json({ error: "Login is temporarily unavailable" });
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

  return router;
}
