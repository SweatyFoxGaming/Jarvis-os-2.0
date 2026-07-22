import { ObservationPlatform } from "../kernel/observation.js";

const observation = ObservationPlatform.getInstance();
const BRAVE_API = "https://api.search.brave.com/res/v1/web/search";

export class WebSearchIntegrationError extends Error {
  constructor(message: string, public status = 500) {
    super(message);
  }
}

export interface WebSearchResult {
  title: string;
  url: string;
  description: string | null;
}

function getKey(): string {
  const key = process.env.BRAVE_API_KEY;
  if (!key) {
    throw new WebSearchIntegrationError(
      "BRAVE_API_KEY is not set — web search is unavailable. Get a free key at https://brave.com/search/api/ and set it in .env.",
      503
    );
  }
  return key;
}

export async function webSearch(query: string, limit = 8): Promise<WebSearchResult[]> {
  const key = getKey();
  const url = `${BRAVE_API}?q=${encodeURIComponent(query)}&count=${limit}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": key,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    observation.logTelemetry("warn", "Integrations", `Brave Search request failed: ${res.status} ${body}`);
    throw new WebSearchIntegrationError(`Brave Search API error (${res.status}): ${body}`, res.status);
  }

  const data = await res.json();
  const results = (data.web?.results || []) as any[];
  return results.map((r) => ({
    title: r.title,
    url: r.url,
    description: r.description || null,
  }));
}
