# Per-User Rapport & Tone Modeling

## Goal

Give Jarvis a genuine, learned sense of how it's currently landing with each specific user — extending the personality dials shipped earlier this session (global, explicit, user-set) with a per-user, ambient, LLM-grounded signal that adapts tone within those dials based on real observed communication patterns, not configuration. This closes the "Samantha" gap identified in this session's sci-fi-AI capability audit: a relationship that evolves per person, not a single fixed persona applied identically to everyone.

## Why

The personality dials (formality/humor/verbosity, `identity.buildPersonalityPromptFragment`, wired into `baseSystemInstruction` at `server.ts:516`) are real and wired into every LLM call, but they're a single, system-wide setting — every user of this Jarvis instance gets the identical tone, and it never moves unless someone manually changes the slider. Nothing currently notices that a given user has been terse and all-business for the last several messages, or playful and exploratory, and adjusts accordingly. This is exactly the gap between "configurable" and "relationship-aware."

## Architecture

Mirrors `src/self/identity.ts`'s existing self-reflection pattern exactly, applied to the user's side of the conversation instead of Jarvis's own:

1. **Extraction** (`src/self/rapport.ts`, `extractRapportSignal(username, groq, userMessage)`) — a fire-and-forget post-turn call (same trigger point as `reflectAndLearn`/`identity.extractSelfReflection`, which already run after every real chat reply at `server.ts:986/992`), using the same raw `Groq` client this file's siblings already use (`groq.chat.completions.create` with `response_format`), reading the user's actual message and producing a short, grounded tone/mood descriptor (e.g. "terse, businesslike, slightly impatient" — real language, not a numeric score) plus a coarse formality estimate. Never fabricated: if the call fails or `groq` is null, this is a silent no-op (matching `extractSelfReflection`'s existing fire-and-forget error handling), not a guessed value.
2. **Storage** (`src/kernel/state/rapport-repo.ts`, backed by a new `rapport_signals` table) — `recordRapportSignal(username, {toneDescriptor, formalityObserved, createdAt})`, `getRecentRapportSignals(username, limit = 8)`. Postgres-backed, degrades cleanly (returns `[]`/no-ops) when Postgres is unreachable, matching every other repo in this codebase.
3. **Synthesis** (`src/self/rapport.ts`, `buildRapportContext(username)`) — reads the recent signals and synthesizes a short natural-language fragment describing the observed pattern (e.g. "Over your last several messages you've been fairly terse and focused — I'll keep replies tight unless you ask for more.") — genuinely derived from what was actually observed, with an explicit boundary rule: this fragment adjusts tone *within* the user's own personality-dial settings, never against them (e.g. it can make a high-formality user's replies feel a touch warmer within formal register, but it never overrides "formality: 90" into casual). Returns an empty string when there's no signal history yet — no fabricated "first impression."
4. **Query surface** — a new tool, `get_rapport_summary`, lets a user directly ask "how have I been coming across lately" and get the same real synthesis back conversationally — this is never a silent, hidden tracking feature; it's inspectable exactly like `reflect_on_self`/`list_constraints` already are.

## Components

| File | Responsibility |
|---|---|
| `src/kernel/state/migrations/008_rapport_signals.ts` | Create — new table, following the exact convention of `007_personality_settings.ts` |
| `src/kernel/state/rapport-repo.ts` | Create — `recordRapportSignal`, `getRecentRapportSignals`, degrade-cleanly repo pattern |
| `src/self/rapport.ts` | Create — `extractRapportSignal(username, groq, userMessage)`, `buildRapportContext(username)` |
| `src/server.ts` | Modify — wire `extractRapportSignal` into the same post-turn fire-and-forget point `reflectAndLearn`/`identity.extractSelfReflection` already fire from (lines ~986/992); append `buildRapportContext`'s output alongside `personalityContext` in `baseSystemInstruction` (line ~516) |
| `src/capabilities/tools.ts` | Modify — add `get_rapport_summary` tool, added to `UNGATED_TOOLS` alongside `display_content`/`list_constraints` (a user should always be able to ask this about themselves) |

## Data Flow

User sends a message → `/api/chat` gets a real reply → fire-and-forget: `extractRapportSignal(username, groq, message)` → Groq extracts a real tone descriptor → `recordRapportSignal` persists it. On the NEXT turn: `buildRapportContext(username)` reads recent signals → synthesizes a short fragment → appended into `baseSystemInstruction` alongside `personalityContext`/`identityContext` → every real LLM branch sees it, exactly like the personality dials already do.

## Error Handling

- Extraction failure (no `groq` client, LLM error) is a silent no-op — never blocks or delays the actual chat reply, matches `extractSelfReflection`'s existing fire-and-forget convention exactly.
- `rapport-repo.ts` degrading when Postgres is unreachable returns empty results, never throws — `buildRapportContext` treats that identically to "no signals yet" (empty string, no adaptation, not an error state).
- The dial-precedence rule (rapport adjusts within dials, never against them) is enforced by prompt construction, not a hard runtime check — this is consistent with how `personalityContext` itself already works (natural-language guidance, not an enforced constraint), and is documented plainly in the synthesis function so it doesn't drift silently in a future edit.

## Testing

- `rapport-repo.ts`: unit tests matching the established repo-test convention — record/read round-trip, degrade-cleanly-when-Postgres-down.
- `rapport.ts`: `extractRapportSignal` tested with an injected fake `Groq`-shaped client (same DI pattern as `shadow-verifier.ts`'s `execFn`) — asserts a real signal gets recorded on success, and asserts it's a true no-op (no throw, no partial record) when the call fails. `buildRapportContext` tested against a few recorded signals to confirm real synthesis (not templated text) and against zero signals to confirm it returns an empty string, not a fabricated "first time meeting you" line.
- `get_rapport_summary` tool: tested that it returns the same synthesis `buildRapportContext` produces, matching the existing tool-test convention.

## Out of Scope

- Any UI visualization of rapport/mood (a chart, a sentiment history graph) — this phase is purely the backend signal + prompt integration.
- Cross-session mood *prediction* or proactive interruption based on rapport signals (e.g. "you seem stressed, want to talk") — that's closer to the separately-identified, not-yet-built wellbeing-awareness gap from this session's audit, a distinct feature, not part of this one.
- Any change to the personality dials themselves (`system_settings`) — this phase only adds a new, separate signal that reads alongside them; the dials' own storage/API is untouched.
