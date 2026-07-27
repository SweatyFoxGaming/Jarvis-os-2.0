// A plain keyword classifier, not an LLM call — deliberately: this needs
// to run before coding starts (to shape the system prompt) and after (to
// tag the resulting reward events) with the exact same answer both times,
// and adding a network call/cost/latency to classify a handful of words
// isn't worth it. See the design spec's "Data model" section for why these
// four categories specifically, and why "general" is a real category (not
// an error case) rather than null.
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  database: ["migration", "schema", "database", "postgres", "sql", "table"],
  frontend: ["ui", "dashboard", "frontend", "css", "html", "panel", "button"],
  security: ["auth", "security", "permission", "capability", "credential", "token"],
};

export function classifyTaskCategory(objective: string): string {
  const lower = objective.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return category;
    }
  }
  return "general";
}
