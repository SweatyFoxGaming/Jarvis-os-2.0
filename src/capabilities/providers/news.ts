import { ObservationPlatform } from "../../kernel/observation.js";

const observation = ObservationPlatform.getInstance();
const NEWS_API = "https://newsapi.org/v2";

export class NewsIntegrationError extends Error {
  constructor(message: string, public status = 500) {
    super(message);
  }
}

export interface NewsArticle {
  title: string;
  description: string | null;
  url: string;
  source: string;
  publishedAt: string;
}

function getKey(): string {
  const key = process.env.NEWS_API_KEY;
  if (!key) {
    throw new NewsIntegrationError("NEWS_API_KEY is not set — news capability is unavailable.", 503);
  }
  return key;
}

async function newsRequest(path: string, params: Record<string, string>): Promise<any> {
  const key = getKey();
  const query = new URLSearchParams({ ...params, apiKey: key }).toString();
  const res = await fetch(`${NEWS_API}${path}?${query}`);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    observation.logTelemetry("warn", "Integrations", `News API request failed: ${path} -> ${res.status} ${body}`);
    throw new NewsIntegrationError(`News API error (${res.status}): ${body}`, res.status);
  }

  return res.json();
}

function toArticles(raw: any): NewsArticle[] {
  return (raw.articles || []).map((a: any) => ({
    title: a.title,
    description: a.description || null,
    url: a.url,
    source: a.source?.name || "unknown",
    publishedAt: a.publishedAt,
  }));
}

export async function getTopHeadlines(opts: { country?: string; category?: string; limit?: number } = {}): Promise<NewsArticle[]> {
  const raw = await newsRequest("/top-headlines", {
    country: opts.country || "us",
    ...(opts.category ? { category: opts.category } : {}),
    pageSize: String(opts.limit || 8),
  });
  return toArticles(raw);
}

export async function searchNews(query: string, limit = 8): Promise<NewsArticle[]> {
  const raw = await newsRequest("/everything", {
    q: query,
    sortBy: "publishedAt",
    pageSize: String(limit),
  });
  return toArticles(raw);
}
