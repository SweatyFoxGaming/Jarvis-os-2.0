import { Router } from "express";
import crypto from "crypto";
import { ObservationPlatform } from "../../kernel/observation.js";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import { requireCapability } from "../../kernel/security.js";
import * as github from "../../capabilities/providers/github.js";
import * as emailIntegration from "../../capabilities/providers/email.js";
import * as tts from "../tts.js";
import * as jarvisFiles from "../../capabilities/providers/files.js";
import * as calendar from "../../capabilities/providers/calendar.js";
import * as news from "../../capabilities/providers/news.js";
import * as webSearch from "../../capabilities/providers/websearch.js";
import { issueOAuthStateTicket, consumeOAuthStateTicket } from "../../kernel/oauth-state-tickets.js";
import * as oauthRepo from "../../kernel/state/oauth-repo.js";

const observation = ObservationPlatform.getInstance();

export const integrationsRouter: Router = Router();

// ---------- OAuth account-linking CSRF binding ----------
//
// Google's callback is the user's own browser navigating back after
// consent, so identity crosses that boundary via the `state` query param
// (see oauth-state-tickets.ts) rather than an X-API-Key header. But `state`
// alone only proves "someone who called /auth-url initiated a flow bound to
// THIS username" — it says nothing about which browser is completing it.
// Attack this closes: an attacker (any authenticated Jarvis user) calls
// GET /auth-url with their OWN api key, gets back a real Google consent URL
// whose state is bound to their OWN username, sends that URL to a victim
// (who need not even be a Jarvis user), the victim completes Google's real
// consent screen with their own real Google account, and Google redirects
// back with that same state — without this binding, the callback would
// attach the VICTIM's real Calendar+Gmail tokens to the ATTACKER's account.
//
// Fix: /auth-url also sets an HttpOnly, SameSite=Lax cookie scoped to this
// same browser, carrying an HMAC of the state value (keyed on
// OAUTH_TOKEN_ENCRYPTION_KEY, which every OAuth-token-shaped secret in this
// codebase is already required to have — see kernel/token-crypto.ts). A
// cookie is what makes this browser-bound: it's issued only in the
// /auth-url response and never appears in the URL the attacker forwards, so
// the victim's browser — which never called /auth-url itself — never holds
// it. The callback recomputes the same HMAC from the state it received and
// requires the cookie to match before it will even attempt to consume the
// state ticket. The cookie value is deliberately not just a copy of
// `state` itself: `state` is visible in the forwarded URL an attacker
// controls, so it can never double as its own proof of browser origin —
// only a value the attacker can't derive (the HMAC, which requires the
// server-side key) can.
const OAUTH_CSRF_COOKIE = "oauth_csrf_binding";
// Matches oauth-state-tickets.ts's own OAUTH_STATE_TICKET_TTL_MS — no
// reason for this binding to outlive the state ticket it's protecting.
const OAUTH_CSRF_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;
// Scoped to exactly the two routes that issue/consume it, not the whole
// app — an OAuth CSRF-binding cookie has no reason to be sent on every
// other request to this origin.
const OAUTH_CSRF_COOKIE_PATH = "/api/integrations/google";

function oauthCsrfBindingValue(state: string): string {
  const key = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
  if (!key) {
    // Fails closed: with no real key there is no way to bind this cookie
    // securely (an unkeyed or hardcoded-key "HMAC" would just be a copy of
    // `state` under another name, which is exactly the guessable/replayable
    // value this fix exists to avoid) — refuse to issue the OAuth flow at
    // all rather than silently degrading to a forgeable binding.
    throw new Error("OAUTH_TOKEN_ENCRYPTION_KEY is not set — cannot start a Google OAuth flow without it.");
  }
  return crypto.createHmac("sha256", key).update(state).digest("hex");
}

function oauthCsrfBindingMatches(cookieValue: unknown, state: string): boolean {
  if (typeof cookieValue !== "string" || !cookieValue) return false;
  let expected: string;
  try {
    expected = oauthCsrfBindingValue(state);
  } catch {
    return false;
  }
  const actual = Buffer.from(cookieValue);
  const wanted = Buffer.from(expected);
  // crypto.timingSafeEqual throws on a length mismatch rather than
  // returning false — an attacker-supplied cookie is exactly the kind of
  // untrusted-length input that would trigger that, so length must be
  // checked first, not caught after the fact.
  if (actual.length !== wanted.length) return false;
  return crypto.timingSafeEqual(actual, wanted);
}

// ---------- Integrations: GitHub / Email / TTS ----------

const handleIntegrationError = (res: any, err: any) => {
  const status = typeof err?.status === "number" ? err.status : 500;
  observation.logTelemetry("warn", "Integrations", `Request failed: ${err?.message || err}`);
  res.status(status).json({ error: err?.message || "Integration request failed" });
};

integrationsRouter.get("/api/integrations/github/repo", validateApiKey, requireCapability("github.read"), async (req: any, res: any) => {
  const { owner, repo, path: filePath, ref } = req.query;
  if (!owner || !repo) return res.status(400).json({ error: "owner and repo are required" });
  try {
    const data = filePath
      ? await github.getFileContent(owner, repo, filePath, ref)
      : await github.getRepo(owner, repo);
    res.json(data);
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

integrationsRouter.post("/api/integrations/github/issues", validateApiKey, requireCapability("github.issues.create"), async (req: any, res: any) => {
  const { owner, repo, title, body, labels } = req.body;
  if (!owner || !repo || !title) return res.status(400).json({ error: "owner, repo and title are required" });
  try {
    res.json(await github.createIssue(owner, repo, title, body, labels));
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

integrationsRouter.post("/api/integrations/github/issues/:number/comments", validateApiKey, requireCapability("github.issues.create"), async (req: any, res: any) => {
  const { owner, repo, body } = req.body;
  if (!owner || !repo || !body) return res.status(400).json({ error: "owner, repo and body are required" });
  try {
    res.json(await github.commentOnIssue(owner, repo, Number(req.params.number), body));
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

integrationsRouter.post("/api/integrations/github/pulls", validateApiKey, requireCapability("github.pulls.create"), async (req: any, res: any) => {
  const { owner, repo, title, head, base, body } = req.body;
  if (!owner || !repo || !title || !head || !base) {
    return res.status(400).json({ error: "owner, repo, title, head and base are required" });
  }
  try {
    res.json(await github.createPullRequest(owner, repo, title, head, base, body));
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

integrationsRouter.get("/api/integrations/github/pulls", validateApiKey, requireCapability("github.read"), async (req: any, res: any) => {
  const { owner, repo, number, state } = req.query;
  if (!owner || !repo) return res.status(400).json({ error: "owner and repo are required" });
  try {
    const data = number
      ? await github.getPullRequest(owner, repo, Number(number))
      : await github.listPullRequests(owner, repo, state);
    res.json(data);
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

integrationsRouter.post("/api/integrations/email/send", validateApiKey, requireCapability("email.send"), async (req: any, res: any) => {
  const { to, subject, text, html } = req.body;
  if (!to || !subject || !text) return res.status(400).json({ error: "to, subject and text are required" });
  try {
    res.json(await emailIntegration.sendEmail(to, subject, text, html));
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

integrationsRouter.get("/api/integrations/email/messages", validateApiKey, requireCapability("email.read"), async (req: any, res: any) => {
  const limit = req.query.limit ? Number(req.query.limit) : 10;
  try {
    res.json(await emailIntegration.fetchRecentMessages(limit));
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

integrationsRouter.post("/api/integrations/tts/speak", validateApiKey, requireCapability("tts.speak"), async (req: any, res: any) => {
  const { text, voice, model } = req.body;
  if (!text) return res.status(400).json({ error: "text is required" });
  try {
    const { audio, contentType } = await tts.synthesizeSpeech(text, { voice, model });
    res.setHeader("Content-Type", contentType);
    res.send(audio);
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

// ---------- Local Files/Notes (scoped to one dedicated folder) ----------
integrationsRouter.get("/api/integrations/files/list", validateApiKey, requireCapability("files.read"), async (req: any, res: any) => {
  try {
    res.json(await jarvisFiles.listFiles(req.query.path as string | undefined));
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

integrationsRouter.get("/api/integrations/files/read", validateApiKey, requireCapability("files.read"), async (req: any, res: any) => {
  const { path: relPath } = req.query;
  if (!relPath) return res.status(400).json({ error: "path is required" });
  try {
    res.json({ path: relPath, content: await jarvisFiles.readFile(relPath as string) });
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

integrationsRouter.post("/api/integrations/files/write", validateApiKey, requireCapability("files.write"), async (req: any, res: any) => {
  const { path: relPath, content } = req.body;
  if (!relPath || typeof content !== "string") {
    return res.status(400).json({ error: "path and content are required" });
  }
  try {
    res.json(await jarvisFiles.writeFile(relPath, content));
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

integrationsRouter.delete("/api/integrations/files", validateApiKey, requireCapability("files.write"), async (req: any, res: any) => {
  const { path: relPath } = req.query;
  if (!relPath) return res.status(400).json({ error: "path is required" });
  try {
    await jarvisFiles.deleteFile(relPath as string);
    res.json({ status: "success" });
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

// ---------- Google Calendar + Gmail (combined OAuth connect flow) ----------
// GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI required — see README for how to
// create these in Google Cloud. Per-registered-user OAuth: identity crosses
// the redirect via a single-use state ticket (kernel/oauth-state-tickets.ts),
// since Google's callback is the user's own browser and can't carry an
// X-API-Key header.

integrationsRouter.get("/api/integrations/google/auth-url", validateApiKey, (req: any, res: any) => {
  try {
    // Fail fast BEFORE minting a state ticket: calendar.getAuthUrl() below
    // already throws via its own internal requireOAuthConfig() if Google
    // isn't configured, but by then issueOAuthStateTicket() has already run
    // and wasted a ticket slot for a flow that could never succeed. Calling
    // the same check here first means an unconfigured deployment costs
    // nothing per hit.
    calendar.requireOAuthConfig();
    const state = issueOAuthStateTicket(req.username);
    // See the CSRF-binding block above: this cookie is what proves the
    // browser completing /callback is the same one that received this
    // response, not just whoever holds the URL.
    res.cookie(OAUTH_CSRF_COOKIE, oauthCsrfBindingValue(state), {
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      maxAge: OAUTH_CSRF_COOKIE_MAX_AGE_MS,
      path: OAUTH_CSRF_COOKIE_PATH,
    });
    res.json({ url: calendar.getAuthUrl(state) });
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

// No validateApiKey — same reasoning as the calendar-only callback this
// replaces: Google's redirect is the user's own browser, which can't carry
// an X-API-Key header. Identity crosses this boundary via the state
// parameter instead, validated below — and, as of the CSRF-binding fix
// above, the request must also carry the matching oauth_csrf_binding cookie
// set on /auth-url before that state is trusted at all.
integrationsRouter.get("/api/integrations/google/callback", async (req: any, res: any) => {
  const { code, error, state } = req.query;
  const clearCsrfCookie = () => res.clearCookie(OAUTH_CSRF_COOKIE, { path: OAUTH_CSRF_COOKIE_PATH });
  if (error) {
    // error/err.message below come from the query string or an upstream API and
    // must never be interpolated into this HTML response (reflected-XSS risk) —
    // log them server-side and show the browser a fixed, static message instead.
    observation.logTelemetry("warn", "Integrations", `Google OAuth authorization denied: ${error}`);
    clearCsrfCookie();
    return res.status(400).send("<html><body>Google account authorization was denied.</body></html>");
  }
  if (!code || !state) {
    clearCsrfCookie();
    return res.status(400).send("<html><body>Missing authorization code or state.</body></html>");
  }
  // Verify the CSRF-binding cookie BEFORE ever consuming the state ticket —
  // consumeOAuthStateTicket() is single-use, so calling it on a request that
  // fails this check would burn the real, valid ticket via a path that
  // still risks attaching tokens to the wrong account on a retry, or at
  // minimum locks the legitimate user out of their own in-flight flow. A
  // request whose cookie doesn't match (or is missing entirely, as it
  // always will be for a victim who never called /auth-url themselves) is
  // rejected outright, before identity is even resolved from the state.
  if (!oauthCsrfBindingMatches(req.cookies?.[OAUTH_CSRF_COOKIE], state as string)) {
    observation.logAuditEvent("unknown", "google_oauth_csrf_rejected", "failed", "Google OAuth callback rejected: missing or mismatched CSRF-binding cookie");
    clearCsrfCookie();
    return res.status(403).send("<html><body>This connection attempt could not be verified from your browser — please restart from the dashboard.</body></html>");
  }
  const username = consumeOAuthStateTicket(state as string);
  clearCsrfCookie();
  if (!username) {
    return res.status(403).send("<html><body>Invalid or expired connection attempt — please try again.</body></html>");
  }
  try {
    await calendar.exchangeCodeForTokens(code as string, username);
    res.send("<html><body>Google account connected — you can close this tab.</body></html>");
  } catch (err: any) {
    observation.logTelemetry("error", "Integrations", `Google OAuth callback failed for "${username}": ${err.message}`);
    res.status(err.status || 500).send("<html><body>Failed to connect your Google account. Try again from the dashboard.</body></html>");
  }
});

// No requireCapability — holding the calendar/gmail capability grant and
// having an actual live Google OAuth connection are conceptually different
// things (a user can be granted the capability without ever having
// connected), so this can't be answered by hasGrant() and needs its own
// read of whether a token row actually exists for this user.
integrationsRouter.get("/api/integrations/google/status", validateApiKey, async (req: any, res: any) => {
  try {
    const tokens = await oauthRepo.getTokens("google_calendar", req.username);
    res.json({ connected: !!tokens });
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

// Self-service disconnect — no requireCapability: any authenticated user may
// disconnect their OWN account (req.username is always the actor, never a
// body/query param for who to disconnect). Local deletion is what actually
// matters for Jarvis's own access; Google-side revocation is best-effort
// and must not block or fail this response if it errors.
integrationsRouter.delete("/api/integrations/google", validateApiKey, async (req: any, res: any) => {
  try {
    const stored = await oauthRepo.getTokens("google_calendar", req.username);
    const deleted = await oauthRepo.deleteTokens("google_calendar", req.username);
    if (stored) {
      // Best-effort, fire-and-forget: fires regardless of the local delete
      // outcome above and must not block or fail this response if Google's
      // revoke endpoint errors — revocation itself is genuinely best-effort
      // per the brief.
      fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(stored.refresh_token)}`, { method: "POST" })
        .catch((err) => observation.logTelemetry("warn", "Integrations", `Google-side revocation failed for "${req.username}": ${err.message}`));
    }
    // deleteTokens degrades to false both when there was nothing to delete
    // and when a genuine DB error occurred (it never throws). Only treat
    // `false` as a failure when `stored` confirms a row existed moments
    // ago — otherwise re-calling this route while already disconnected
    // would wrongly report an error on an idempotent no-op. When a row DID
    // exist and the delete still came back false, the local token row (with
    // its now Google-side-revoked tokens) may still be sitting there and
    // GET /status would keep reporting connected: true — that must not be
    // reported to the caller as a success.
    if (stored && !deleted) {
      observation.logAuditEvent(req.username, "google_account_disconnect_local_failure", "warning", "");
      return res.status(500).json({ error: "Failed to disconnect your Google account locally — please try again." });
    }
    observation.logAuditEvent(req.username, "google_account_disconnected", "success", "");
    res.json({ status: "success" });
  } catch (err: any) {
    handleIntegrationError(res, err);
  }
});

integrationsRouter.get("/api/integrations/calendar/events", validateApiKey, requireCapability("calendar.read"), async (req: any, res: any) => {
  try {
    res.json(await calendar.listEvents(req.username, req.query.timeMinISO, req.query.timeMaxISO));
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

integrationsRouter.post("/api/integrations/calendar/events", validateApiKey, requireCapability("calendar.write"), async (req: any, res: any) => {
  const { summary, startISO, endISO, description } = req.body;
  if (!summary || !startISO || !endISO) {
    return res.status(400).json({ error: "summary, startISO, and endISO are required" });
  }
  try {
    res.json(await calendar.createEvent(req.username, summary, startISO, endISO, description));
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

// ---------- News ----------
integrationsRouter.get("/api/integrations/news/headlines", validateApiKey, requireCapability("news.read"), async (req: any, res: any) => {
  try {
const params: Record<string, any> = {};
    if (req.query.country) params.country = req.query.country as string;
    if (req.query.category) params.category = req.query.category as string;
    if (req.query.limit) params.limit = Number(req.query.limit);

    const articles = await news.getTopHeadlines(params);
    res.json({ ok: true, articles });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message || "Failed to fetch headlines" });
  }
});

integrationsRouter.get("/api/integrations/news/search", validateApiKey, requireCapability("news.read"), async (req: any, res: any) => {
  const q = req.query.q as string | undefined;
  if (!q) return res.status(400).json({ error: "q is required" });
  try {
    const articles = await news.searchNews(q, req.query.limit ? Number(req.query.limit) : undefined);
    res.json({ articles });
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

// ---------- Web Search ----------
integrationsRouter.get("/api/integrations/websearch", validateApiKey, requireCapability("web.search"), async (req: any, res: any) => {
  const q = req.query.q as string | undefined;
  if (!q) return res.status(400).json({ error: "q is required" });
  try {
    const results = await webSearch.webSearch(q, req.query.limit ? Number(req.query.limit) : undefined);
    res.json({ results });
  } catch (err) {
    handleIntegrationError(res, err);
  }
});
