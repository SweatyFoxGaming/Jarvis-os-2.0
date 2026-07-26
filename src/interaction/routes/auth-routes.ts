import { Router } from "express";
import rateLimit from "express-rate-limit";
import { ObservationPlatform } from "../../kernel/observation.js";
import * as usersRepo from "../../kernel/state/users-repo.js";

const observation = ObservationPlatform.getInstance();

// Off by default: with no gate, anyone who can reach this port (including
// everyone on a Tailscale tailnet — see README's remote-access section) could
// self-provision a working API key with full tool/integration access. Flip
// this on only for the window you actually want a new account created.
const ALLOW_REGISTRATION = (process.env.ALLOW_REGISTRATION || "false").toLowerCase() === "true";

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
  if (!ALLOW_REGISTRATION) {
    return res.status(403).json({ error: "Registration is currently disabled. Set ALLOW_REGISTRATION=true to enable it." });
  }
  const { username, password } = req.body;
  if (typeof username !== "string" || !username.trim() || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  try {
    const apiKey = await usersRepo.createUser(username, password);
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
