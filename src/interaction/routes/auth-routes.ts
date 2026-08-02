import { Router } from "express";
import rateLimit from "express-rate-limit";
import { ObservationPlatform } from "../../kernel/observation.js";
import * as usersRepo from "../../kernel/state/users-repo.js";
import * as invitesRepo from "../../kernel/state/invites-repo.js";
import * as permissions from "../../kernel/security.js";
import { MAX_NON_ADMIN_USERS } from "./invites-routes.js";

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
    // Same format + reserved-username checks createUser enforces
    // (users-repo.ts's exported validateNewUsername — the single shared
    // function both this pre-check and createUser's own first step call,
    // so they can never validate a username differently), run here BEFORE
    // redeemInvite is ever called. Without this, a malformed username (an
    // email address, a space, under 3 chars) or a reserved one ("admin",
    // any case variant — the identity auth-middleware.ts grants every
    // capability to) would sail past every other check in this handler,
    // burn the caller's single-use invite via redeemInvite, and only THEN
    // get rejected by createUser's own check — leaving the user with no
    // account and an admin-recoverable-only wasted invite. Running it here,
    // before any write, means either kind of bad username gets a clean 400
    // with the invite left completely untouched. Deliberately NOT
    // pre-checking UsernameTakenError here — that one needs a DB lookup and
    // is inherently race-dependent (TOCTOU) no matter where it runs, so it
    // stays exactly where it was: inside createUser's atomic
    // INSERT ... ON CONFLICT DO NOTHING, below. This one call is inside the
    // try block (not before it) specifically so it shares the same catch
    // block below that already maps InvalidUsernameError/
    // ReservedUsernameError/UsernameTakenError to a clean 400.
    usersRepo.validateNewUsername(username);

    // Check-first: validate the invite is real, unused, and unexpired
    // BEFORE touching it at all, so a bad/expired/reused token is still
    // rejected with the same 400 it always was, without ever attempting a
    // claim.
    //
    // But the CLAIM itself (redeemInvite) is now the first WRITE this
    // handler performs — before createUser, not after. Previously
    // createUser ran first: under N concurrent requests using the SAME
    // valid invite token, this read-only pre-check passed for all N
    // (nothing had been claimed yet), so all N calls to createUser
    // succeeded and created N real, working accounts — only one of the N
    // subsequent redeemInvite() calls actually won the atomic claim,
    // leaving N-1 real, usable accounts (with zero capability grants, but
    // API keys that work for login and reach every validateApiKey-only
    // route) behind a 400 response the caller had no reason to trust.
    // Claiming first means a losing race participant is now rejected by
    // redeemInvite's atomic `UPDATE ... WHERE used_by IS NULL` before
    // createUser ever runs, so no account is created for them at all.
    // redeemInvite's SQL requires no pre-existing user row (it just
    // records who claimed it), so this ordering is safe.
    //
    // The tradeoff this reordering accepts: if createUser then fails for
    // some other reason (e.g. UsernameTakenError) after a successful
    // redeemInvite, the invite is burned with no account created — a much
    // smaller, self-contained cost (one wasted invite an admin can just
    // reissue) than the old bug (a live account a losing race participant
    // could log into with zero grants but full API access).
    const invite = await invitesRepo.getInvite(inviteToken);
    if (!invite || invite.used_by || invite.expires_at.getTime() <= Date.now()) {
      return res.status(400).json({ error: "Invalid or expired invite token." });
    }

    // Re-check the MAX_NON_ADMIN_USERS cap here, alongside the invite
    // validation above and before the invite is claimed — invites-routes.ts's
    // POST /api/invites only checks this cap at invite-CREATION time, which
    // does nothing to stop invites already issued (e.g. a burst minted
    // before any of them were redeemed) from being redeemed past the cap.
    // Checked before redeemInvite so a request doomed by the cap doesn't
    // needlessly burn the token. This does leave one narrow, much smaller
    // race of its own — two concurrent registrations against two DIFFERENT
    // valid tokens could both read the count as 9 and both proceed — but
    // that's a self-limiting, one-time-at-most overshoot by a handful of
    // accounts, not the unbounded blow-past-the-cap-with-no-error-anywhere
    // bug this closes.
    const nonAdminCount = await invitesRepo.countNonAdminUsers();
    if (nonAdminCount >= MAX_NON_ADMIN_USERS) {
      return res.status(403).json({ error: `Already at the ${MAX_NON_ADMIN_USERS}-person limit — this invite can no longer be redeemed.` });
    }

    const redeemed = await invitesRepo.redeemInvite(inviteToken, username);
    if (!redeemed) {
      // Rare TOCTOU: someone else redeemed this exact token between the
      // pre-check above and this call. No account has been created at this
      // point, so nothing needs to be undone.
      observation.logTelemetry("warn", "Database", `Invite ${inviteToken} was redeemed concurrently during registration of ${username}`);
      return res.status(400).json({ error: "Invalid or expired invite token." });
    }

    const apiKey = await usersRepo.createUser(username, password);
    for (const capability of permissions.DEFAULT_PERSONAL_CAPABILITIES) {
      await permissions.grantCapability(username, capability, "system:invite-redemption");
    }
    observation.logAuditEvent(username, "register", "success", `Registered new user: ${username}`);
    res.json({ username, api_key: apiKey });
  } catch (err: any) {
    if (
      err instanceof usersRepo.UsernameTakenError ||
      err instanceof usersRepo.ReservedUsernameError ||
      err instanceof usersRepo.InvalidUsernameError
    ) {
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
