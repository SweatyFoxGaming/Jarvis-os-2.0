import rateLimit from "express-rate-limit";

// Shared limiter for any route that calls out to a real (billed) LLM
// provider or a paid third-party API with no cap otherwise — a leaked key,
// a runaway client-side retry loop, or a misconfigured monitoring probe
// could otherwise generate unbounded cost. Keyed per authenticated user
// (not IP) so this actually bounds a given key's usage rather than a
// shared NAT's. Originally local to server.ts (guarding /api/chat,
// /api/executive/run, /v1/chat/completions) — pulled out here so
// route-file-only endpoints that hit Groq/Gemini or paid search/news APIs
// (adaptation, evolution analysis, websearch, news) can reuse the exact
// same budget instead of going unlimited.
export const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.username || req.ip,
  message: { error: "Too many requests — please slow down." },
});
