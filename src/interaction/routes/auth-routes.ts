import { Router } from "express";
import rateLimit from "express-rate-limit";
import { ObservationPlatform } from "../../kernel/observation.js";
import * as usersRepo from "../../kernel/state/users-repo.js";
import * as invitesRepo from "../../kernel/state/invites-repo.js";
import * as permissions from "../../kernel/security.js";

const observation = ObservationPlatform.getInstance();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts, try again later" },
});

// authLimiter alone only bounds guesses from a single IP — a distributed
// attacker (many source IPs) could otherwise throw unlimited password
// guesses at one specific username with no per-account backoff. This is
// the same 20-per-15-minutes budget as authLimiter, just keyed on the
// submitted username instead of the caller's address, so the two limits
// apply independently and in combination. Lowercased so varying case can't
// be used to split one account's guesses across multiple buckets. Applied
// only to /api/login, not /api/register — a taken-username check on
// registration isn't a credential-guessing surface the way a login attempt is.
const loginUsernameLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => (typeof req.body?.username === "string" ? req.body.username.toLowerCase() : "unknown"),
  message: { error: "Too many attempts for this account, try again later" },
});

export const authRouter = Router();

// Authentication Endpoints
authRouter.post("/api/register", authLimiter, async (req, res) => {
  const { username, password, inviteToken } = req.body;
  if (typeof inviteToken !== "string" || !inviteToken.trim()) {
    return res.status(400).json({ error: "An invite token is required to register." });
  }
  if (typeof username !== "string" || !username.trim() || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  try {
    // Check-first, not create-then-redeem: createUser has no sensible
    // "undo" and redeemInvite has no sensible "check without claiming", so
    // validate the invite is real and unused BEFORE ever calling
    // createUser. redeemInvite is still called after createUser to close
    // the TOCTOU race atomically, but by then it's failing an already-rare
    // case (someone else claimed the same token in between) rather than
    // the common one (bad/expired/reused token).
    const invite = await invitesRepo.getInvite(inviteToken);
    if (!invite || invite.used_by || invite.expires_at.getTime() <= Date.now()) {
      return res.status(400).json({ error: "Invalid or expired invite token." });
    }
    const apiKey = await usersRepo.createUser(username, password);
    const redeemed = await invitesRepo.redeemInvite(inviteToken, username);
    if (!redeemed) {
      // The account was already created above — this is the rare TOCTOU
      // race (someone else redeemed the same token between the pre-check
      // and this call) rather than the common bad-token case, which was
      // already rejected above before createUser ran.
      observation.logTelemetry("warn", "Database", `Invite ${inviteToken} was redeemed concurrently during registration of ${username}`);
      return res.status(400).json({ error: "Invalid or expired invite token." });
    }
    for (const capability of permissions.DEFAULT_PERSONAL_CAPABILITIES) {
      await permissions.grantCapability(username, capability, "system:invite-redemption");
    }
    observation.logAuditEvent(username, "register", "success", `Registered new user: ${username}`);
    res.json({ username, api_key: apiKey });
  } catch (err: any) {
    if (err instanceof usersRepo.UsernameTakenError || err instanceof usersRepo.ReservedUsernameError) {
      return res.status(400).json({ error: err.message });
    }
    observation.logTelemetry("warn", "Database", `Registration failed: ${err.message}`);
    res.status(503).json({ error: "Registration is temporarily unavailable" });
  }
});

authRouter.post("/api/login", authLimiter, loginUsernameLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (typeof username !== "string" || !username.trim() || typeof password !== "string" || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }
  try {
    const valid = await usersRepo.verifyCredentials(username, password);
    if (!valid) {
      observation.logAuditEvent(username, "login", "failed", "Invalid credentials provided");
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const apiKey = await usersRepo.getOrCreateApiKey(username);
    observation.logAuditEvent(username, "login", "success", `User logged in: ${username}`);
    res.json({ username, api_key: apiKey });
  } catch (err: any) {
    observation.logTelemetry("warn", "Database", `Login failed: ${err.message}`);
    res.status(503).json({ error: "Login is temporarily unavailable" });
  }
});
