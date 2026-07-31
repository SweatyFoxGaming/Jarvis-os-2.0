import { Router } from "express";
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
import { aiLimiter } from "../../kernel/rate-limiters.js";

const observation = ObservationPlatform.getInstance();

export const integrationsRouter = Router();

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

// ---------- Google Calendar (OAuth, one-time setup) ----------
// GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI required — see README for how to
// create these in Google Cloud. Deployment-wide, single-tenant, same as
// GITHUB_TOKEN/EMAIL_* — not a per-registered-user OAuth flow.

integrationsRouter.get("/api/integrations/calendar/auth-url", validateApiKey, requireCapability("calendar.write"), (req: any, res: any) => {
  try {
    res.json({ url: calendar.getAuthUrl() });
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

// No validateApiKey: Google's redirect is the user's own browser navigating
// here after consent, which can't attach an x-api-key header. The
// authorization code itself (short-lived, tied to the registered redirect
// URI and client secret) is what's actually being trusted here, same as any
// standard OAuth callback.
integrationsRouter.get("/api/integrations/calendar/callback", async (req: any, res: any) => {
  const { code, error } = req.query;
  if (error) {
    // error/err.message below come from the query string or an upstream API and
    // must never be interpolated into this HTML response (reflected-XSS risk) —
    // log them server-side and show the browser a fixed, static message instead.
    observation.logTelemetry("warn", "Integrations", `Calendar OAuth authorization denied: ${error}`);
    return res.status(400).send("<html><body>Google Calendar authorization was denied.</body></html>");
  }
  if (!code) {
    return res.status(400).send("<html><body>Missing authorization code.</body></html>");
  }
  try {
    await calendar.exchangeCodeForTokens(code);
    res.send("<html><body>Google Calendar connected — you can close this tab.</body></html>");
  } catch (err: any) {
    observation.logTelemetry("error", "Integrations", `Calendar OAuth callback failed: ${err.message}`);
    res.status(err.status || 500).send("<html><body>Failed to connect Google Calendar. Check server logs for details.</body></html>");
  }
});

integrationsRouter.get("/api/integrations/calendar/events", validateApiKey, requireCapability("calendar.read"), async (req: any, res: any) => {
  try {
    res.json(await calendar.listEvents(req.query.timeMinISO, req.query.timeMaxISO));
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
    res.json(await calendar.createEvent(summary, startISO, endISO, description));
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

// ---------- News ----------
integrationsRouter.get("/api/integrations/news/headlines", validateApiKey, requireCapability("news.read"), async (req: any, res: any) => {
  try {
    const articles = await news.getTopHeadlines({
      country: req.query.country as string | undefined,
      category: req.query.category as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.json({ articles });
  } catch (err) {
    handleIntegrationError(res, err);
  }
});

// aiLimiter reused here: both routes below hit paid third-party APIs
// (NewsAPI/Brave) with no cap otherwise.
integrationsRouter.get("/api/integrations/news/search", validateApiKey, requireCapability("news.read"), aiLimiter, async (req: any, res: any) => {
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
integrationsRouter.get("/api/integrations/websearch", validateApiKey, requireCapability("web.search"), aiLimiter, async (req: any, res: any) => {
  const q = req.query.q as string | undefined;
  if (!q) return res.status(400).json({ error: "q is required" });
  try {
    const results = await webSearch.webSearch(q, req.query.limit ? Number(req.query.limit) : undefined);
    res.json({ results });
  } catch (err) {
    handleIntegrationError(res, err);
  }
});
