import { ObservationPlatform } from "../../kernel/observation.js";
import * as oauthRepo from "../../kernel/state/oauth-repo.js";
import { fetchWithRetry } from "../../kernel/http-retry.js";
import * as scheduler from "../../kernel/scheduler.js";

const observation = ObservationPlatform.getInstance();
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
// Shared with calendar.ts's own PROVIDER constant — Calendar and Gmail
// scopes were both granted in ONE combined OAuth consent (see calendar.ts's
// SCOPE), so there is only ever one token row per (provider="google_calendar",
// username) covering both. This is intentional, not a copy-paste bug.
const PROVIDER = "google_calendar";

export class PersonalGmailError extends Error {
  constructor(message: string, public status = 500) {
    super(message);
  }
}

async function getValidAccessToken(username: string): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new PersonalGmailError("Google isn't configured — set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET.", 503);
  }

  let stored: Awaited<ReturnType<typeof oauthRepo.getTokens>>;
  try {
    stored = await oauthRepo.getTokens(PROVIDER, username);
  } catch (err: any) {
    // oauthRepo.getTokens() has no internal try/catch of its own — a lookup
    // failure (Postgres unreachable, DNS failure, etc.) rejects rather than
    // resolving to null. From this caller's perspective that's exactly as
    // actionable as "no row for this user": either way there's no usable
    // token, so it's treated the same as not-connected rather than letting a
    // raw DB error leak out where a clear "connect your account" message
    // belongs.
    observation.logTelemetry("warn", "Integrations", `Personal Gmail token lookup failed for "${username}": ${err.message}`);
    stored = null;
  }
  if (!stored) {
    throw new PersonalGmailError("You haven't connected a Google account yet — use Connect Google Account in the dashboard.", 401);
  }
  if (new Date(stored.expiry).getTime() > Date.now() + 60_000) {
    return stored.access_token;
  }
  const res = await fetchWithRetry(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: stored.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  }, { label: "Personal Gmail token refresh" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // A refresh failure here (invalid_grant) means the user revoked access
    // on Google's side, or the refresh token otherwise went stale — this is
    // exactly the reconnect-needed case Task 15 handles. Throwing here with
    // a 401 lets that task's handling recognize it and prompt reconnection.
    //
    // Only a 400/401-class response from Google is actually the "refresh
    // token itself is invalid" (invalid_grant) case — that's the one signal
    // that means reconnecting is genuinely required, so it also gets a
    // durable push notification (fire-and-forget, must not delay this
    // throw). A transient 5xx from Google's token endpoint does NOT fire
    // it: reconnecting wouldn't help with a retry-able blip.
    if (res.status === 400 || res.status === 401) {
      scheduler.pushNotification(
        username,
        "Your Google connection needs renewing, sir — click Connect Google Account again in the dashboard.",
        "warning"
      );
    }
    throw new PersonalGmailError(`Google token refresh failed (${res.status}): ${body}`, 401);
  }
  const data = await res.json() as { access_token: string; expires_in: number };
  const expiry = new Date(Date.now() + data.expires_in * 1000);
  await oauthRepo.saveTokens(PROVIDER, username, data.access_token, stored.refresh_token, expiry);
  return data.access_token;
}

async function gmailRequest(username: string, path: string, init: RequestInit = {}): Promise<any> {
  const accessToken = await getValidAccessToken(username);
  const res = await fetchWithRetry(`${GMAIL_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
  }, { label: `Gmail API ${init.method || "GET"} ${path}` });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new PersonalGmailError(`Gmail API error (${res.status}): ${body}`, res.status);
  }
  return res.json();
}

// Gmail's send endpoint takes a raw base64url-encoded RFC 2822 message, not
// a JSON body of {to, subject, text} — this builds the minimal valid one.
function buildRawMessage(to: string, subject: string, text: string): string {
  const message = [`To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", text].join("\r\n");
  return Buffer.from(message).toString("base64url");
}

export async function sendPersonalEmail(username: string, to: string, subject: string, text: string): Promise<{ messageId: string }> {
  const result = await gmailRequest(username, "/users/me/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw: buildRawMessage(to, subject, text) }),
  });
  observation.logTelemetry("info", "Integrations", `Personal Gmail sent for "${username}": "${subject}" (${result.id})`);
  return { messageId: result.id };
}

export async function fetchPersonalRecentMessages(username: string, limit = 10): Promise<any[]> {
  const list = await gmailRequest(username, `/users/me/messages?maxResults=${limit}`);
  return list.messages || [];
}
