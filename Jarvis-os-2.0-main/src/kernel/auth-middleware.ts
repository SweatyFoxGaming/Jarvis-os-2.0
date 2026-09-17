import crypto from "crypto";
import { ObservationPlatform } from "./observation.js";
import * as usersRepo from "./state/users-repo.js";
import { type Request, type Response, type NextFunction } from 'express';

const observation = ObservationPlatform.getInstance();

// No literal-fallback here on purpose: a missing/short key must fail loudly
// at boot rather than silently granting admin access to a guessable default.
// This runs at module load, same as when it lived inline in server.ts — the
// first import of this module (server.ts's own, at startup) still fails
// fast before app.listen() ever runs.

// Exported so other modules (e.g. server.ts's /ws/events direct-API-key
// auth path) resolve the admin key the same way this module does, instead
// of re-deriving it from process.env.INTERNAL_API_KEY alone — that alone
// would miss a deployment that sets ADMIN_API_KEY and (per .env.example's
// default) leaves INTERNAL_API_KEY empty. Guaranteed truthy by the
// fail-fast check right below — any importer gets a real, non-empty key.
export const ADMIN_API_KEY = process.env.ADMIN_API_KEY
  || process.env.INTERNAL_API_KEY;

if (!ADMIN_API_KEY) {
  console.error(
    "[server] FATAL: ADMIN_API_KEY is not set. Refusing to start with a guessable/default admin key — set ADMIN_API_KEY to a long random string in .env."
  );
  process.exit(1);
}

if (ADMIN_API_KEY.length < 16) {
  console.warn("[Security] ADMIN_API_KEY is too short. Using default internal key.");
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const requestKeyHeader = req.headers["x-api-key"];

  if (!requestKeyHeader) {
    console.warn(`[Security] Access denied: Missing API Key for ${req.method} ${req.url} from IP ${req.ip}`);
    return res.status(401).json({ error: "Access denied: Missing API Key" });
  }

  // Coerce request header and ADMIN_API_KEY to guaranteed single strings
  const requestKey = Array.isArray(requestKeyHeader) ? requestKeyHeader[0] : requestKeyHeader;
  const adminKey = typeof ADMIN_API_KEY === 'string' ? ADMIN_API_KEY : '';

  if (!requestKey) return res.status(401).json({ error: "Missing key" });
  const keyBuffer = Buffer.from(requestKey);
  const adminBuffer = Buffer.from(adminKey);

  // timingSafeEqual throws an uncatchable RangeError if buffer lengths differ
  if (keyBuffer.length !== adminBuffer.length || !crypto.timingSafeEqual(keyBuffer, adminBuffer)) {
    console.warn(`[Security] Access denied: Invalid API Key for ${req.method} ${req.url} from IP ${req.ip}`);
    return res.status(401).json({ error: "Access denied: Invalid API Key" });
  }

  next();
}

// Plain === on a secret is subject to a timing attack in theory (string
// comparison short-circuits on the first mismatched byte). Compares
// equal-length buffers either way so the time taken doesn't leak how many
// leading characters of a guess were correct.
export function safeCompare(a: string, b: string): boolean {
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
  // Redact the submitted key itself before it ever reaches telemetry/logs
  // below -- the comment at the bottom of this function already explains
  // why the key isn't logged directly; req.headers carries it too, and
  // both the logTelemetry calls and the console.warn further down used to
  // serialize the raw headers object, writing every guessed/malicious key
  // straight into logs.
  const redactedHeaders = { ...req.headers, "x-api-key": "[REDACTED]" };
  const requestInfo = {
    url: req.originalUrl,
    ip: req.ip,
    headers: redactedHeaders,
  };

  if (!apiKey) {
    observation.logTelemetry("warn", "Security", "Access denied: Missing API Key", requestInfo);
    return res.status(401).json({ error: "Missing API Key" });
  }
  // A raw x-api-key header appearing twice makes Express hand back a
  // string[] instead of a string -- coerce to a single string before any
  // comparison, matching authMiddleware's own normalization above.
  const submittedKey = Array.isArray(apiKey) ? apiKey[0] : apiKey;
  // safeCompare, not a raw crypto.timingSafeEqual(...) call: timingSafeEqual
  // throws a RangeError ("Input buffers must have the same byte length") on
  // ANY length mismatch, and this function has no try/catch -- an attacker
  // submitting a key of any length other than ADMIN_API_KEY's own would
  // trigger an unhandled promise rejection with no response ever sent,
  // hanging the request/connection indefinitely. Pre-authentication,
  // trivially remote, on every route this middleware guards. safeCompare
  // (defined just above) already handles the length-mismatch case safely.
  if (!submittedKey || !safeCompare(ADMIN_API_KEY, submittedKey)) {
    try {
      const username = await usersRepo.getUsernameByApiKey(submittedKey);
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
      `from IP ${req.ip}. Headers: ${JSON.stringify(redactedHeaders)}`
    );
    observation.logTelemetry("warn", "Security", "Access denied: Invalid API Key", requestInfo);
    return res.status(401).json({ error: "Invalid API Key" });
  }
  req.username = "admin";
  return next();
};
