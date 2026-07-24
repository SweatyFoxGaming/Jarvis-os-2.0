# Obsidian Vault Integration — Design Spec

## Context

Jarvis currently keeps all of its structured state in Postgres, surfaced through the dashboard
(build requests, self-reflections, briefings) or only in chat replies. None of it is visible as
plain files the user can browse, cross-link, or edit directly. The user wants their real, existing
Obsidian vault to become the visible surface for what Jarvis does — Research, Coding, Self-
reflection, and Briefings each get their own section, cross-linked together, backed by real
understanding of the vault's own `[[wikilink]]`/`#tag` graph (not just flat file storage).

A second, harder requirement surfaced directly from a concrete example the user gave: today's
research (`departments.ts`'s `runResearch`) is a single few-second pass — fine for "does this
library exist" as part of a build request, but dishonest if presented as equivalent to hours of
real research. If the user asks "how long would it take to research quantum physics," Jarvis must
give a genuine, reasoned time estimate — never claim something substantial is instantaneous — and
if the user approves a duration (e.g. "take 10 hours"), Jarvis must actually spend real, paced time
producing real, sourced research, checkpointed visibly into the vault as it happens, not one
instant fake pass dressed up as hours of work.

## Architecture

**New capability provider — `src/capabilities/providers/obsidian.ts`**: the vault-aware file layer.
Parses each note's YAML frontmatter, `[[wikilinks]]` (including `[[Note|Alias]]` and
`[[Note#Heading]]` forms), and `#tags`. Exposes `createNote(path, content, frontmatter)`,
`appendToNote(path, content, { createIfMissing })`, `readNote(path)`, `listNotes()`,
`searchNotes(query)`, `getBacklinks(path)`. `.obsidian/`'s own config folder is never parsed or
exposed. Scoped to one mounted root exactly like `files.ts`'s existing `resolveScopedPath`
pattern (`path.resolve` + prefix check, rejects absolute paths/`..`/null bytes) — same proven
security boundary, new root.

**New Kernel state — `src/kernel/state/vault-repo.ts`**: two new tables (schema below),
`vault_notes` and `vault_links`, added to `db.ts` the same way `createVectorSchema()` is a
separate, non-critical-path init.

**New Kernel state — `src/kernel/state/research-jobs-repo.ts`**: one new table, `research_jobs`,
backing the honestly-timed deep-research mechanism.

**New Executive module — `src/executive/deep-research.ts`**: a genuinely separate mode from
`departments.ts`'s `runResearch` (which stays exactly as-is, still used for build-request
research) — open-ended, topic-general, multi-round, real-time-paced. Kept in its own file rather
than folded into `departments.ts` since the two are structurally different processes (one
completes in seconds as part of a larger flow; the other runs for hours as its own standing job).

**New Kernel scheduled jobs — `src/kernel/scheduler.ts`**:
- `startVaultSyncJob` — periodically re-parses the vault's own files (including notes the user
  edited directly in Obsidian, which Jarvis has no other way to observe) into `vault_notes`/
  `vault_links`. Uses a per-file content hash to skip unchanged files cheaply.
- `startDeepResearchJob` — periodically (every ~10-15 minutes) advances every `research_jobs` row
  with `status = 'running'` by exactly one round, until the committed duration is reached.

**New tool declarations — `src/capabilities/tools.ts`**: see "New tools" below.

**New mount** — `OBSIDIAN_VAULT_DIR` env var (mirrors the existing `JARVIS_FILES_DIR` pattern),
bind-mounted read-write into the container.

## Vault structure

```
<vault root>/
  Research/
    create-a-seamstress-agent-br1.md      ← one note per build request's research (Executive)
    quantum-physics.md                     ← one note per deep-research job, grown over its rounds
  Coding/
    create-a-seamstress-agent-br1.md      ← one note per build request that reaches coding
  Reflections/
    2026-07-24.md                          ← daily rolling note, new entries appended
  Briefings/
    2026-07-24.md                          ← daily rolling note, new entries appended
```

Every generated note carries YAML frontmatter with machine-readable fields (`type`,
`build_request_id` or `research_job_id`, `created`) so Jarvis's own queries don't depend on parsing
prose. A Coding note links back to its Research note via `[[Research/create-a-seamstress-agent-br1]]`
— same objective, same id, always resolvable.

## Write timing

Two different directions, two different models, matching what each is reacting to:

- **Jarvis's own output → vault: event-driven, immediate.** Research, code drafts, reflections,
  and briefings write to the vault right at the same moment they're already persisted to Postgres
  (alongside `recordResearch`, `recordCodeDraft`/`recordPrOpened`/`recordQaReview`,
  `saveProactiveThought`/`addSelfReflection`, `saveBriefing`). Postgres remains the source of truth
  exactly as today — the dashboard, existing tools, and everything else keep working unchanged;
  the vault note is a second, linked, human-readable representation written alongside it. These
  are low-frequency, meaningful events, worth the small extra code at each call site.
- **The vault's own link/tag graph → Postgres: periodic background sync** (`startVaultSyncJob`),
  since this is reacting to edits Jarvis has no other way to observe (the user editing a note
  directly in Obsidian).

## Data model

```sql
CREATE TABLE IF NOT EXISTS vault_notes (
  path TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  frontmatter JSONB NOT NULL DEFAULT '{}',
  tags TEXT[] NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vault_links (
  id SERIAL PRIMARY KEY,
  from_path TEXT NOT NULL REFERENCES vault_notes(path) ON DELETE CASCADE,
  to_path_raw TEXT NOT NULL, -- the literal wikilink target text; may not resolve to a real
                              -- note yet (Obsidian itself allows linking to a note that doesn't
                              -- exist yet) — resolved against vault_notes at query time, not parse time
  link_type TEXT NOT NULL DEFAULT 'wikilink',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vault_links_from_idx ON vault_links(from_path);
CREATE INDEX IF NOT EXISTS vault_links_to_idx ON vault_links(to_path_raw);

CREATE TABLE IF NOT EXISTS research_jobs (
  id SERIAL PRIMARY KEY,
  topic TEXT NOT NULL,
  target_duration_hours DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'running', -- 'running' | 'completed' | 'stopped' | 'error'
  vault_note_path TEXT NOT NULL,
  rounds_completed INTEGER NOT NULL DEFAULT 0,
  requested_by TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_round_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS research_jobs_status_idx ON research_jobs(status);
```

## Honest, time-bounded deep research

**Time estimation — `estimate_research_time(topic)`.** The LLM reasons about the topic's actual
breadth (a deep field like quantum physics vs. a narrow specific question) and gives a genuine
estimate grounded in a stated, real unit of work: roughly how many research rounds a topic of this
breadth needs to cover meaningfully, at roughly one round per 10-15 minutes of real search-and-read
time. The estimate is presented as an approximate range with the reasoning visible, never as an
exact promise. This tool makes no commitment by itself — it only informs the conversation, exactly
like `runResearch`'s existing "propose a plan, wait for approval" pattern elsewhere in this
codebase.

**Committing to a duration — `start_deep_research(topic, targetDurationHours)`.** Only called once
the user has explicitly approved a duration — never inferred, never auto-started. Creates a
`research_jobs` row (`status: 'running'`), creates the vault note at
`Research/<topic-slug>.md` with initial frontmatter (`type: deep-research`, `research_job_id`,
`target_duration_hours`, `created`), and returns immediately — the actual research happens over
the following hours via `startDeepResearchJob`, not inside this tool call.

**Each round** (`deep-research.ts`'s `runDeepResearchRound(job, groq)`, invoked once per
`research_jobs` row per scheduler tick): asks the LLM what unexplored facet of the topic to cover
next (grounded in what earlier rounds already found, read back from the vault note itself — so
rounds don't repeat ground already covered), runs real web searches for it via the existing
`webSearch.webSearch()`, and appends a new timestamped section to the vault note:

```markdown
## Round 3 — 2026-07-24T14:32:00Z

**Focus:** Quantum entanglement and Bell's theorem

**Sources found:**
- [Bell's Theorem (Stanford Encyclopedia of Philosophy)](https://plato.stanford.edu/entries/bell-theorem/)
- [A survey of entanglement measures (arXiv)](https://arxiv.org/abs/...)

**Notes:** ...synthesis grounded only in what was actually retrieved above...
```

`rounds_completed`/`last_round_at` update after every round. Once wall-clock time since
`started_at` reaches `target_duration_hours`, the job does one final synthesis round (a
`## Synthesis` section drawing across every prior round's findings), sets `status: 'completed'`,
and notifies the user the same way other completed background work already does
(`scheduler.pushNotification`).

**Checking in and stopping — `check_research_progress(jobId)`, `stop_research_job(jobId)`.** A
multi-hour commitment must be inspectable and cancellable, not a trap. Checking progress reads the
job row + the vault note's current round count; stopping sets `status: 'stopped'` and leaves
whatever was found intact in the vault (never discarded).

**The honesty boundary, stated plainly so the design doesn't quietly overclaim it**: this
mechanism produces real, paced, cited research — genuine web sources found and read over genuine
time, with Jarvis's own synthesis of what it actually found. It does not produce the depth of
comprehension a physicist would have after 10 hours of focused study, and no part of this design
claims otherwise.

## New tools and permissions

| Tool | Permission | Purpose |
|---|---|---|
| `search_vault(query)` | `vault.read` | Search notes by title/content/tag |
| `get_vault_note(path)` | `vault.read` | Read a note's raw content |
| `get_vault_backlinks(path)` | `vault.read` | What links to this note |
| `write_vault_note(path, content)` | `vault.write` | Create or overwrite a note — same trust level as the existing `write_file`/jarvis-notes tool. No delete tool, matching the existing precedent that even the lower-stakes jarvis-notes folder doesn't expose delete via chat. |
| `estimate_research_time(topic)` | none (informational only, no state change) | Give an honest time estimate before any commitment |
| `start_deep_research(topic, targetDurationHours)` | `research.manage` | Begin a paced, multi-round research job — only after explicit user approval of a duration |
| `check_research_progress(jobId)` | `research.manage` | Inspect a running job's status and round count |
| `stop_research_job(jobId)` | `research.manage` | Cancel a running job early; findings so far are kept |

## Explicitly out of scope

- Merging vault-derived knowledge into the existing conversational knowledge graph
  (`kg_entities`/`kg_facts`/`kg_relationships`) — kept deliberately separate; a wikilink is a
  literal structural reference, not an LLM-judged conversational fact, and conflating the two would
  blur what each actually represents.
- Any mechanism that removes Jarvis's ability to decline or pause on a request. Every consequential
  action here (starting a multi-hour job, writing/overwriting a note) already requires an explicit,
  legible trigger from the user — that principle is unchanged and is not something this feature
  alters.
- Guaranteeing deep-research output reaches genuine expert-level comprehension — see "the honesty
  boundary" above.
- A UI panel for research jobs or the vault graph in this pass — chat tools and the vault itself
  (browsed directly in Obsidian) are the interface for now; a dashboard view is a reasonable
  future follow-up, not bundled here.

## Testing

- `obsidian.ts`'s wikilink/tag/frontmatter parser: unit tests against representative real-world
  note content (plain `[[Note]]`, aliased `[[Note|Alias]]`, heading-targeted `[[Note#Heading]]`,
  multiple `#tags` inline and in frontmatter, a note with no links/tags at all).
  Same convention as this codebase's other pure-function tests (`toGroqSchema`, `looksTrivial`).
- `vault-repo.ts`/`research-jobs-repo.ts`: existing no-DB degrade-safety convention (each function
  tested against an unreachable Postgres, confirming a clean failure mode, not a crash).
- The recurring jobs (`startVaultSyncJob`, `startDeepResearchJob`) and the live LLM/web-search
  round-trips inside `runDeepResearchRound`: verified manually at deploy time, consistent with how
  every other live-model/live-network round trip in this codebase has always been handled — never
  unit-tested against the real network, only its degrade paths are.

## Decisions made during brainstorming

- **Deep-linking/graph integration** chosen over a plain read-only or read+write-only vault
  connection — the user wants Jarvis to genuinely navigate the vault's own link structure, not
  just treat files as isolated text blobs.
- **The user's real, existing vault**, not a fresh Jarvis-only one — raises the bar on write
  safety, resolved by matching the existing `jarvis-notes` folder's trust level exactly (full
  read/write, no special append-only restriction) per the user's explicit choice, while still
  declining to add a delete tool, matching that folder's own existing restraint.
- **Kept separate from the existing knowledge graph** — same reasoning applied consistently: two
  structurally different kinds of knowledge (LLM-judged conversational facts vs. literal parsed
  file structure) shouldn't share one schema just because both are "graphs."
- **Event-driven writes, periodic reads** — resolves an apparent tension (the user asked for
  periodic background sync, but also wants to see Jarvis's own work "as it happens") by
  recognizing these are two different directions of data flow reacting to two different triggers,
  not one symmetric mechanism.
- **Daily rolling notes for high-frequency content** (reflections, briefings), **one note per
  event for low-frequency content** (research, coding) — chosen explicitly by the user to keep the
  vault browsable rather than flooded with hundreds of tiny files.
- **A dedicated, real, paced, multi-round research mechanism** — added after the user gave a
  concrete example (quantum physics, 10 hours) that exposed a real honesty gap in the original
  design: presenting an instant single-pass research result as equivalent to a committed multi-hour
  research duration would be exactly the kind of false claim the user was explicitly warning
  against. Resolved with a real background job, real paced wall-clock rounds, real cited sources,
  and an explicit statement of what this mechanism does *not* promise.
- **Declined, separately and explicitly, in the same conversation**: a request to hard-code that
  Jarvis can never refuse anything the user asks. This is not part of this design and was not
  folded into any tool or permission here — every gate this spec adds (explicit duration approval
  before starting a job, an inspectable/cancellable long-running commitment) is a deliberate
  instance of the same "pause before anything consequential" principle already used everywhere
  else in this codebase, not an exception to it.
