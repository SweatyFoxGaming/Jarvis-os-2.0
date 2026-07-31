import { ObservationPlatform } from "./observation.js";

const observation = ObservationPlatform.getInstance();

export interface FetchWithRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  // Identifies the call in telemetry — a caller's own request label
  // (e.g. "GitHub API POST /repos/x/y/issues") reads far better in logs
  // than a bare URL, especially once query strings/API keys are involved.
  label?: string;
  // Per-attempt timeout in ms. A connection that's accepted but then stalls
  // (no response ever arrives) previously hung this call — and everything
  // that awaits it — indefinitely, since plain fetch() has no timeout of
  // its own. Defaults to 20s; pass 0 to disable (rarely needed).
  timeoutMs?: number;
}

// The upper bound this codebase will ever actually sleep for a server-sent
// Retry-After, regardless of what the header says. A malicious or
// misconfigured upstream sending an absurd value (a huge second count, or a
// far-future HTTP-date) would otherwise make the caller sleep for that
// entire duration — a trivial DoS vector against any request that reaches
// this code path.
const MAX_RETRY_AFTER_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retry-After is either a whole number of seconds or an HTTP-date — both
// are valid per RFC 9110 and real APIs use both (GitHub sends seconds,
// some others send a date).
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  let ms: number | null = null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    ms = seconds * 1000;
  } else {
    const dateMs = Date.parse(header);
    if (!Number.isNaN(dateMs)) ms = Math.max(0, dateMs - Date.now());
  }
  return ms === null ? null : Math.min(ms, MAX_RETRY_AFTER_MS);
}

/**
 * A thin retry layer over fetch() for this codebase's external HTTP
 * integrations (GitHub, Wikipedia, Brave Search, NewsAPI, Google Calendar)
 * — none of which previously retried a transient failure at all, so a
 * single 429 or momentary 5xx failed the whole call outright with no
 * recovery, unlike the Groq/Gemini LLM call sites, which already have
 * their own fallback/retry logic.
 *
 * Retry semantics are deliberately conservative about side effects:
 *   - A 429 (rate limited) means the request was REJECTED before any
 *     processing happened — safe to retry regardless of HTTP method.
 *   - A 5xx or network-level failure is only retried for idempotent
 *     methods (GET/HEAD) — for a POST/PUT/PATCH, there's no way to know
 *     whether the server actually processed the request before the
 *     response was lost, and blindly retrying could double-send an
 *     email, double-create a GitHub issue/PR, double-book a calendar
 *     event, etc. These still fail on the first attempt, exactly as
 *     before this existed.
 *
 * Honors a real Retry-After header when the server sends one, falling
 * back to exponential backoff with jitter otherwise.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: FetchWithRetryOptions = {}
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const method = (init.method || "GET").toUpperCase();
  const isIdempotent = method === "GET" || method === "HEAD";
  const label = opts.label || url;

  let lastNetworkErr: any = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      // Only add our own timeout signal when the caller didn't already
      // supply one — an explicit caller signal means they're managing
      // their own cancellation policy (e.g. a request-scoped abort).
      const signal = init.signal ?? (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined);
      res = await fetch(url, { ...init, signal });
    } catch (err: any) {
      lastNetworkErr = err;
      if (!isIdempotent || attempt === maxRetries) throw err;
      const delay = baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs;
      observation.logTelemetry(
        "warn",
        "Integrations",
        `${label}: network error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delay)}ms: ${err.message || err}`
      );
      await sleep(delay);
      continue;
    }

    const retryableStatus = res.status === 429 || (res.status >= 500 && isIdempotent);
    if (retryableStatus && attempt < maxRetries) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
      const delay = retryAfterMs ?? baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs;
      observation.logTelemetry(
        "warn",
        "Integrations",
        `${label}: ${res.status} (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delay)}ms`
      );
      await sleep(delay);
      continue;
    }
    return res;
  }
  // Unreachable — the loop above always either returns a response or
  // throws — but satisfies TypeScript's control-flow analysis.
  throw lastNetworkErr || new Error(`fetchWithRetry exhausted retries for ${label}`);
}
