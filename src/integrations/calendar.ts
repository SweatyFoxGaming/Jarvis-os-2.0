import { ObservationPlatform } from "../observation/index.js";
import * as oauthRepo from "../data/oauth-repo.js";

const observation = ObservationPlatform.getInstance();
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const SCOPE = "https://www.googleapis.com/auth/calendar";
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
 * Step 1 of the one-time OAuth setup: the URL an operator opens in a
 * browser to grant Jarvis calendar access. Deployment-wide, single-tenant
 * (like GITHUB_TOKEN/EMAIL_*), not a per-registered-user OAuth flow.
 */
export function getAuthUrl(): string {
  const { clientId, redirectUri } = requireOAuthConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/**
 * Step 2: Google redirects back to GOOGLE_REDIRECT_URI with ?code=... —
 * exchanged here for an access + refresh token pair, persisted to Postgres.
 * The refresh token is long-lived; getValidAccessToken() below uses it to
 * mint new access tokens automatically after this one-time setup.
 */
export async function exchangeCodeForTokens(code: string): Promise<void> {
  const { clientId, clientSecret, redirectUri } = requireOAuthConfig();
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
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
  await oauthRepo.saveTokens(PROVIDER, data.access_token, data.refresh_token, expiry);
  observation.logTelemetry("info", "Integrations", "Google Calendar OAuth tokens stored.");
}

async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiry: Date }> {
  const { clientId, clientSecret } = requireOAuthConfig();
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new CalendarIntegrationError(`Google token refresh failed (${res.status}): ${body}`, res.status);
  }
  const data = await res.json() as { access_token: string; expires_in: number };
  return { accessToken: data.access_token, expiry: new Date(Date.now() + data.expires_in * 1000) };
}

async function getValidAccessToken(): Promise<string> {
  requireOAuthConfig(); // surface the root cause ("not configured") before the less specific "not authorized yet"
  const stored = await oauthRepo.getTokens(PROVIDER);
  if (!stored) {
    throw new CalendarIntegrationError(
      "Google Calendar isn't authorized yet — visit GET /api/integrations/calendar/auth-url to start the one-time setup.",
      401
    );
  }
  // Refresh a little before actual expiry to avoid a race against in-flight requests.
  if (new Date(stored.expiry).getTime() > Date.now() + 60_000) {
    return stored.access_token;
  }
  const { accessToken, expiry } = await refreshAccessToken(stored.refresh_token);
  await oauthRepo.saveTokens(PROVIDER, accessToken, stored.refresh_token, expiry);
  return accessToken;
}

async function calendarRequest(path: string, init: RequestInit = {}): Promise<any> {
  const accessToken = await getValidAccessToken();
  const res = await fetch(`${CALENDAR_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    observation.logTelemetry("warn", "Integrations", `Google Calendar API request failed: ${init.method || "GET"} ${path} -> ${res.status} ${body}`);
    throw new CalendarIntegrationError(`Google Calendar API error (${res.status}): ${body}`, res.status);
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function listEvents(timeMinISO?: string, timeMaxISO?: string, maxResults = 10): Promise<any[]> {
  const params = new URLSearchParams({
    timeMin: timeMinISO || new Date().toISOString(),
    maxResults: String(maxResults),
    singleEvents: "true",
    orderBy: "startTime",
  });
  if (timeMaxISO) params.set("timeMax", timeMaxISO);
  const result = await calendarRequest(`/calendars/primary/events?${params.toString()}`);
  return (result?.items || []).map((e: any) => ({
    id: e.id,
    summary: e.summary,
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    description: e.description,
  }));
}

export async function createEvent(summary: string, startISO: string, endISO: string, description?: string): Promise<any> {
  const created = await calendarRequest(`/calendars/primary/events`, {
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
