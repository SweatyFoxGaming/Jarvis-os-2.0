import { ObservationPlatform } from "../../kernel/observation.js";
import * as oauthRepo from "../../kernel/state/oauth-repo.js";
import { fetchWithRetry } from "../../kernel/http-retry.js";
import * as scheduler from "../../kernel/scheduler.js";

const observation = ObservationPlatform.getInstance();
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const SCOPE = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
].join(" ");
const PROVIDER = "google_calendar";

export class CalendarIntegrationError extends Error {
  constructor(message: string, public status = 500) {
    super(message);
  }
}

function requireOAuthConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new CalendarIntegrationError(
      "Google Calendar isn't configured — set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI (see README).",
      503
    );
  }
  return { clientId, clientSecret, redirectUri };
}

/**
 * Step 1 of the OAuth connect flow: the URL a user's browser is sent to in
 * order to grant Jarvis Calendar + Gmail access. `state` carries a
 * single-use ticket (see kernel/oauth-state-tickets.ts) so the callback can
 * recover which user initiated the connection.
 */
export function getAuthUrl(state: string): string {
  const { clientId, redirectUri } = requireOAuthConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/**
 * Step 2: Google redirects back to GOOGLE_REDIRECT_URI with ?code=... —
 * exchanged here for an access + refresh token pair, persisted to Postgres.
 * The refresh token is long-lived; getValidAccessToken() below uses it to
 * mint new access tokens automatically after this one-time setup.
 */
export async function exchangeCodeForTokens(code: string, username: string): Promise<void> {
  const { clientId, clientSecret, redirectUri } = requireOAuthConfig();
  const res = await fetchWithRetry(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  }, { label: "Google OAuth token exchange" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new CalendarIntegrationError(`Google token exchange failed (${res.status}): ${body}`, res.status);
  }
  const data = await res.json() as { access_token: string; refresh_token?: string; expires_in: number };
  if (!data.refresh_token) {
    // Google only returns a refresh_token on the FIRST consent for a given
    // client/account pair unless prompt=consent forces re-issue (which the
    // auth URL above already sets) — surfacing this clearly beats silently
    // storing an access-only token that stops working in an hour.
    throw new CalendarIntegrationError(
      "Google did not return a refresh token. Revoke Jarvis's access at https://myaccount.google.com/permissions and try the auth flow again.",
      500
    );
  }
  const expiry = new Date(Date.now() + data.expires_in * 1000);
  await oauthRepo.saveTokens(PROVIDER, username, data.access_token, data.refresh_token, expiry);
  observation.logTelemetry("info", "Integrations", `Google account connected for "${username}".`);
}

async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiry: Date }> {
  const { clientId, clientSecret } = requireOAuthConfig();
  const res = await fetchWithRetry(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  }, { label: "Google OAuth token refresh" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new CalendarIntegrationError(`Google token refresh failed (${res.status}): ${body}`, res.status);
  }
  const data = await res.json() as { access_token: string; expires_in: number };
  return { accessToken: data.access_token, expiry: new Date(Date.now() + data.expires_in * 1000) };
}

async function getValidAccessToken(username: string): Promise<string> {
  requireOAuthConfig(); // surface the root cause ("not configured") before the less specific "not authorized yet"
  const stored = await oauthRepo.getTokens(PROVIDER, username);
  if (!stored) {
    throw new CalendarIntegrationError(
      "Google Calendar isn't authorized yet — visit GET /api/integrations/google/auth-url to start the connect flow.",
      401
    );
  }
  // Refresh a little before actual expiry to avoid a race against in-flight requests.
  if (new Date(stored.expiry).getTime() > Date.now() + 60_000) {
    return stored.access_token;
  }
  let refreshed: { accessToken: string; expiry: Date };
  try {
    refreshed = await refreshAccessToken(stored.refresh_token);
  } catch (err) {
    // A 400/401 from Google's token endpoint here means the refresh token
    // itself is invalid (invalid_grant class) — the user revoked access, or
    // it otherwise went stale, and no retry will fix it. That's the one
    // case that actually means "reconnect your Google account", so it gets
    // a durable push notification in addition to the thrown error below —
    // a transient 5xx (or anything else) does NOT get this notification,
    // since reconnecting wouldn't help there. Fire-and-forget: this must
    // not delay or block the throw that reports failure to the caller.
    if (err instanceof CalendarIntegrationError && (err.status === 400 || err.status === 401)) {
      scheduler.pushNotification(
        username,
        "Your Google connection needs renewing, sir — click Connect Google Account again in the dashboard.",
        "warning"
      );
    }
    throw err;
  }
  await oauthRepo.saveTokens(PROVIDER, username, refreshed.accessToken, stored.refresh_token, refreshed.expiry);
  return refreshed.accessToken;
}

async function calendarRequest(path: string, username: string, init: RequestInit = {}): Promise<any> {
  const accessToken = await getValidAccessToken(username);
  const res = await fetchWithRetry(`${CALENDAR_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  }, { label: `Google Calendar API ${init.method || "GET"} ${path}` });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    observation.logTelemetry("warn", "Integrations", `Google Calendar API request failed: ${init.method || "GET"} ${path} -> ${res.status} ${body}`);
    throw new CalendarIntegrationError(`Google Calendar API error (${res.status}): ${body}`, res.status);
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function listEvents(username: string, timeMinISO?: string, timeMaxISO?: string, maxResults = 10): Promise<any[]> {
  const params = new URLSearchParams({
    timeMin: timeMinISO || new Date().toISOString(),
    maxResults: String(maxResults),
    singleEvents: "true",
    orderBy: "startTime",
  });
  if (timeMaxISO) params.set("timeMax", timeMaxISO);
  const result = await calendarRequest(`/calendars/primary/events?${params.toString()}`, username);
  return (result?.items || []).map((e: any) => ({
    id: e.id,
    summary: e.summary,
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    description: e.description,
  }));
}

export async function createEvent(username: string, summary: string, startISO: string, endISO: string, description?: string): Promise<any> {
  const created = await calendarRequest(`/calendars/primary/events`, username, {
    method: "POST",
    body: JSON.stringify({
      summary,
      description,
      start: { dateTime: startISO },
      end: { dateTime: endISO },
    }),
  });
  observation.logTelemetry("info", "Integrations", `Google Calendar event created: "${summary}" (${created.id})`);
  return { id: created.id, htmlLink: created.htmlLink, summary: created.summary };
}

export function isConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
}
