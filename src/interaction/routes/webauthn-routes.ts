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
      const apiKey = await usersRepo.getOrCreateApiKey(username);
      observation.logAuditEvent(username, "webauthn-login", "success", `Signed in via device "${storedCredential.device_label}"`);
      res.json({ username, api_key: apiKey });
    } catch (err: any) {
      // By construction, this only fires for a genuine thrown exception —
      // a DB error from getCredentialById/updateCounterAndLastUsed/
      // getOrCreateApiKey, or verifyAuthenticationResponse itself throwing
      // (e.g. on a malformed response object) — since a completed
      // verification that's simply invalid (verified:false or an
      // ownership mismatch) is already handled explicitly above and never
      // reaches here. Mirrors /api/login's (auth-routes.ts) wording for
      // the same infrastructure-failure class, so a real outage isn't
      // misreported to WebAuthn users as "your credential is invalid."
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
