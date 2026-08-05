import crypto from "crypto";
import { ObservationPlatform } from "./observation.js";
import * as usersRepo from "./state/users-repo.js";

const observation = ObservationPlatform.getInstance();

// No literal-fallback here on purpose: a missing/short key must fail loudly
// at boot rather than silently granting admin access to a guessable default.
// This runs at module load, same as when it lived inline in server.ts — the
// first import of this module (server.ts's own, at startup) still fails
// fast before app.listen() ever runs.
const ADMIN_API_KEY = process.env.INTERNAL_API_KEY;
if (!ADMIN_API_KEY || ADMIN_API_KEY.length < 16) {
  console.error(
    "[server] FATAL: INTERNAL_API_KEY is not set (or shorter than 16 characters). " +
    "Refusing to start with a guessable/default admin key — set INTERNAL_API_KEY to a long random string in .env."
  );
  process.exit(1);
}

// Plain === on a secret is subject to a timing attack in theory (string
// comparison short-circuits on the first mismatched byte). Compares
// equal-length buffers either way so the time taken doesn't leak how many
// leading characters of a guess were correct.
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// Header-only: query-string keys end up in access logs, browser history and
// Referer headers, so ?api_key=... is intentionally not accepted.
export const validateApiKey = async (req: any, res: any, next: any) => {
  const apiKey = req.headers["x-api-key"];
  const requestInfo = {
    url: req.originalUrl,
    ip: req.ip,
    headers: req.headers,
  };

  if (!apiKey) {
    observation.logTelemetry("warn", "Security", "Access denied: Missing API Key", requestInfo);
    return res.status(401).json({ error: "Missing API Key" });
  }
  if (typeof apiKey === "string" && safeCompare(apiKey, ADMIN_API_KEY)) {
    req.username = "admin";
    return next();
  }
  try {
    const username = await usersRepo.getUsernameByApiKey(apiKey);
    if (username) {
      req.username = username;
      return next();
    }
  } catch (err: any) {
    observation.logTelemetry("warn", "Database", `API key lookup failed: ${err.message}`, requestInfo);
    return res.status(503).json({ error: "Authentication service unavailable" });
  }
  // Deliberately not logging the submitted key itself — it's the caller's
  // (possibly malicious) guess, not a secret worth persisting into telemetry.
  // 401, not 403: this means "not authenticated at all" (bad/unrecognized
  // credentials), which must stay distinct from the 403s below (a *valid*
  // key missing one specific capability grant) — the client's authFetch
  // treats these very differently (see index.html), and conflating them
  // here previously caused a legitimate permission-403 from one panel (e.g.
  // command execution, for a non-admin user) to wipe the entire session's
  // API key, silently breaking unrelated features like chat.
  console.warn(
    `[Security] Access denied: Invalid API Key for ${req.method} ${req.originalUrl} ` +
    `from IP ${req.ip}. Headers: ${JSON.stringify(req.headers)}`
  );
  observation.logTelemetry("warn", "Security", "Access denied: Invalid API Key", requestInfo);
  return res.status(401).json({ error: "Invalid API Key" });
};
