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
