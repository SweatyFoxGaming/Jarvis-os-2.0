import { ObservationPlatform } from "../../kernel/observation.js";

const observation = ObservationPlatform.getInstance();
const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";

export class WikipediaIntegrationError extends Error {
  constructor(message: string, public status = 500) {
    super(message);
  }
}

export interface WikipediaResult {
  title: string;
  url: string;
  description: string | null;
}

// No API key needed — Wikipedia's search API is public, unlike webSearch.ts's
// Brave-backed search. Snippets come back as HTML with a <span> highlighting
// the matched terms; stripped here since every other findings source in this
// codebase (web search, GitHub) returns plain text that callers just join
// into a text summary.
export async function wikipediaSearch(query: string, limit = 3): Promise<WikipediaResult[]> {
  const url = `${WIKIPEDIA_API}?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json&origin=*`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    observation.logTelemetry("warn", "Integrations", `Wikipedia search request failed: ${res.status} ${body}`);
    throw new WikipediaIntegrationError(`Wikipedia API error (${res.status}): ${body}`, res.status);
  }

  const data = await res.json();
  const results = (data.query?.search || []) as any[];
  return results.map((r) => ({
    title: r.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`,
    description: r.snippet ? r.snippet.replace(/<[^>]+>/g, "") : null,
  }));
}
