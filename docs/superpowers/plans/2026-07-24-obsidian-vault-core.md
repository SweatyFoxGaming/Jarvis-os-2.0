# Obsidian Vault Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Jarvis a real, parsed, linked view of the user's own Obsidian vault, and make Research
(build-request), Coding, Reflections, and Briefings write into it as first-class, cross-linked
sections — the vault becomes a visible, real surface for what Jarvis does, not just Postgres rows
shown in a dashboard.

**Architecture:** A new capability provider (`src/capabilities/providers/obsidian.ts`) owns scoped
file I/O and note parsing (frontmatter/wikilinks/tags). A new Kernel state layer
(`src/kernel/state/vault-repo.ts` + two new tables) holds the parsed link graph, kept up to date by
a new periodic sync job. Four new chat tools expose read/write access. Research, Coding,
Reflections, and Briefings each get a dedicated writer function in `obsidian.ts`, called
immediately — event-driven, not batched — at the exact point each is already persisted to
Postgres today.

**Tech Stack:** TypeScript, `js-yaml` (new dependency, for parsing the YAML frontmatter block —
verified against its real, current `.d.ts`, not assumed), the existing `tests/index.test.ts`
harness.

**This is Plan 1 of 2.** Plan 2 (honest, time-boxed deep research) builds on this plan's
`obsidian.ts` writer functions and is executed as its own, separate cycle afterward — see
`docs/superpowers/specs/2026-07-24-obsidian-vault-integration-design.md`.

## Global Constraints

- **No delete tool.** `write_vault_note` can create or overwrite; there is no `delete_vault_note`
  chat tool, matching the existing precedent that even the lower-stakes `jarvis-notes` folder
  (`files.ts`) doesn't expose delete via chat, even though the underlying capability could exist.
- **`.obsidian/`'s own config folder, and any other dotfile/dotdir, is never parsed or exposed** —
  it's Obsidian's own app configuration, not user content.
- **Read functions degrade cleanly (empty result), write functions are allowed to reject** on a
  genuine Postgres outage — same split already used elsewhere in this codebase (see
  `objectives-repo.ts`'s `listActiveObjectives` vs. `createObjective` for the existing precedent).
- **Scoped-folder security must match `files.ts`'s exact proven pattern**: `path.resolve` +
  `path.sep`-boundary prefix check (not a naive `startsWith`), rejecting absolute paths, `..`
  segments, and null bytes.
- **Wikilink backlink matching is by basename, not full path equality** — Obsidian itself resolves
  `[[Note Name]]` by basename across the whole vault by default, so a correct backlink lookup has
  to match the same way.
- **Before running `npm install`, re-check that `js-yaml@^5.2.2` is still the current stable
  release** (`npm view js-yaml version`) — this plan was written against that exact version,
  verified directly against its shipped `.d.ts` (it bundles its own types; no separate
  `@types/js-yaml` needed for v5). If a newer version is out, use it, matching this codebase's
  existing dependency-verification discipline.

---

### Task 1: Kernel state — `vault_notes`/`vault_links` tables + `vault-repo.ts`

**Files:**
- Modify: `src/kernel/state/db.ts`
- Create: `src/kernel/state/vault-repo.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Produces: `VaultNoteRow`, `VaultLinkRow` interfaces; `upsertNote`, `deleteNote`,
  `replaceLinksForNote`, `getNoteByPath`, `listNotes`, `searchNotes`, `getBacklinks`, all exported
  from `src/kernel/state/vault-repo.ts`. Task 2's sync job and Task 4's chat tools import these by
  name.

- [ ] **Step 1: Add the two tables to `createSchema()`**

In `src/kernel/state/db.ts`, find the end of `createSchema()`:

```ts
  await db.query(`CREATE INDEX IF NOT EXISTS push_subscriptions_username_idx ON push_subscriptions(username);`);
}
```

Replace with:

```ts
  await db.query(`CREATE INDEX IF NOT EXISTS push_subscriptions_username_idx ON push_subscriptions(username);`);

  // The parsed, linked view of the user's real Obsidian vault — kept up to
  // date by scheduler.ts's startVaultSyncJob. path is the vault-relative
  // path (e.g. "Research/quantum-physics.md"), the natural primary key
  // since it's exactly what Obsidian itself uses to identify a note.
  await db.query(`
    CREATE TABLE IF NOT EXISTS vault_notes (
      path TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      frontmatter JSONB NOT NULL DEFAULT '{}',
      tags TEXT[] NOT NULL DEFAULT '{}',
      content_hash TEXT NOT NULL,
      last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // to_path_raw is kept as the literal wikilink target text (e.g. "Note
  // Name" or "Note Name#Heading") — it may not resolve to a real note yet,
  // since Obsidian itself allows linking to a note that doesn't exist yet.
  // Resolution against vault_notes happens at query time (getBacklinks),
  // not parse time.
  await db.query(`
    CREATE TABLE IF NOT EXISTS vault_links (
      id SERIAL PRIMARY KEY,
      from_path TEXT NOT NULL REFERENCES vault_notes(path) ON DELETE CASCADE,
      to_path_raw TEXT NOT NULL,
      link_type TEXT NOT NULL DEFAULT 'wikilink',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS vault_links_from_idx ON vault_links(from_path);`);
  await db.query(`CREATE INDEX IF NOT EXISTS vault_links_to_idx ON vault_links(to_path_raw);`);
}
```

- [ ] **Step 2: Create `vault-repo.ts`**

Create `src/kernel/state/vault-repo.ts`:

```ts
import { getPool } from "./db.js";

export interface VaultNoteRow {
  path: string;
  title: string;
  frontmatter: Record<string, any>;
  tags: string[];
  content_hash: string;
  last_synced_at: Date;
}

export interface VaultLinkRow {
  id: number;
  from_path: string;
  to_path_raw: string;
  link_type: string;
  created_at: Date;
}

// Write side — used only by the vault sync job, which already wraps each
// file's processing in its own try/catch so one bad note can't abort the
// whole scan. These are allowed to reject on a genuine DB outage rather
// than silently pretending the upsert succeeded — same "no sensible
// fallback value for a write" reasoning objectives-repo.ts's
// createObjective already uses.
export async function upsertNote(
  path: string,
  title: string,
  frontmatter: Record<string, any>,
  tags: string[],
  contentHash: string
): Promise<VaultNoteRow> {
  const db = getPool();
  const { rows } = await db.query(
    `INSERT INTO vault_notes (path, title, frontmatter, tags, content_hash, last_synced_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (path) DO UPDATE SET
       title = EXCLUDED.title,
       frontmatter = EXCLUDED.frontmatter,
       tags = EXCLUDED.tags,
       content_hash = EXCLUDED.content_hash,
       last_synced_at = now()
     RETURNING *`,
    [path, title, JSON.stringify(frontmatter), tags, contentHash]
  );
  return rows[0];
}

export async function deleteNote(path: string): Promise<void> {
  const db = getPool();
  await db.query(`DELETE FROM vault_notes WHERE path = $1`, [path]);
}

export async function replaceLinksForNote(fromPath: string, targets: string[]): Promise<void> {
  const db = getPool();
  await db.query(`DELETE FROM vault_links WHERE from_path = $1`, [fromPath]);
  for (const target of targets) {
    await db.query(
      `INSERT INTO vault_links (from_path, to_path_raw, link_type) VALUES ($1, $2, 'wikilink')`,
      [fromPath, target]
    );
  }
}

// Read side — degrade cleanly (empty result, not a throw): these back chat
// tools where "nothing found" is a normal, sensible answer. Same
// read-vs-write degrade-safety split objectives-repo.ts's
// listActiveObjectives already establishes.
export async function getNoteByPath(path: string): Promise<VaultNoteRow | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(`SELECT * FROM vault_notes WHERE path = $1`, [path]);
    return rows[0] || null;
  } catch {
    return null;
  }
}

export async function listNotes(): Promise<VaultNoteRow[]> {
  try {
    const db = getPool();
    const { rows } = await db.query(`SELECT * FROM vault_notes ORDER BY last_synced_at DESC`);
    return rows;
  } catch {
    return [];
  }
}

export async function searchNotes(query: string, limit = 10): Promise<VaultNoteRow[]> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT * FROM vault_notes
       WHERE title ILIKE $1 OR $2 = ANY(tags)
       ORDER BY last_synced_at DESC LIMIT $3`,
      [`%${query}%`, query, limit]
    );
    return rows;
  } catch {
    return [];
  }
}

// Resolves by basename, not full path equality — Obsidian itself resolves
// [[Note Name]] wikilinks by basename across the whole vault by default, so
// a real backlink lookup has to match the same way, not require the
// linking note to have spelled out the target's full relative path. A
// broad SQL substring prefilter narrows the row count before the precise
// basename comparison happens in application code.
export async function getBacklinks(notePath: string): Promise<VaultLinkRow[]> {
  try {
    const db = getPool();
    const basename = (notePath.split("/").pop() || notePath).replace(/\.md$/, "");
    const { rows } = await db.query(
      `SELECT * FROM vault_links WHERE to_path_raw ILIKE $1`,
      [`%${basename}%`]
    );
    return rows.filter((r: VaultLinkRow) => {
      const target = r.to_path_raw.replace(/#.*$/, "").trim();
      const targetBasename = (target.split("/").pop() || target).replace(/\.md$/, "");
      return targetBasename.toLowerCase() === basename.toLowerCase();
    });
  } catch {
    return [];
  }
}
```

- [ ] **Step 3: Write the degrade-safety tests**

In `tests/index.test.ts`, find:

```ts
import { toGroqSchema, toGroqTools } from "../src/runtime/groq-client.js";
```

Replace with:

```ts
import { toGroqSchema, toGroqTools } from "../src/runtime/groq-client.js";
import { upsertNote, listNotes, searchNotes, getBacklinks } from "../src/kernel/state/vault-repo.js";
```

Then add a new test category near the end of the file, right before the
`// ---------- Execution Main Block ----------` comment:

```ts
// ---------- Vault Repo Tests ----------

registerTest("Vault", "upsertNote degrades cleanly when Postgres isn't reachable", async () => {
  try {
    await upsertNote("Research/test.md", "Test", {}, [], "abc123");
    throw new Error("Vault: expected upsertNote to reject without a live Postgres connection");
  } catch (err: any) {
    if (err.message?.includes("expected upsertNote to reject")) throw err;
    // Any other thrown error (connection refused/DNS failure) is expected —
    // upsertNote is a genuine write with no sensible fallback value.
  }
});

registerTest("Vault", "listNotes degrades cleanly when Postgres isn't reachable", async () => {
  const result = await listNotes();
  if (!Array.isArray(result) || result.length !== 0) {
    throw new Error(`Vault: expected an empty array with no DB, got: ${JSON.stringify(result)}`);
  }
});

registerTest("Vault", "searchNotes degrades cleanly when Postgres isn't reachable", async () => {
  const result = await searchNotes("quantum");
  if (!Array.isArray(result) || result.length !== 0) {
    throw new Error(`Vault: expected an empty array with no DB, got: ${JSON.stringify(result)}`);
  }
});

registerTest("Vault", "getBacklinks degrades cleanly when Postgres isn't reachable", async () => {
  const result = await getBacklinks("Research/quantum-physics.md");
  if (!Array.isArray(result) || result.length !== 0) {
    throw new Error(`Vault: expected an empty array with no DB, got: ${JSON.stringify(result)}`);
  }
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: `99 / 99 Tests Passed` (95 existing + 4 new `Vault` tests).

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/kernel/state/db.ts src/kernel/state/vault-repo.ts tests/index.test.ts
git commit -m "feat: add vault_notes/vault_links tables and vault-repo.ts"
```

---

### Task 2: Capabilities provider — `obsidian.ts` (scoped I/O + parsing)

**Files:**
- Create: `src/capabilities/providers/obsidian.ts`
- Modify: `package.json` (new dependency)
- Test: `tests/index.test.ts`

**Interfaces:**
- Produces: `ObsidianIntegrationError`, `ParsedNote` interface, `parseNote(raw: string): ParsedNote`,
  `slugify(text: string): string`, `createNote(path, content, frontmatter?)`,
  `appendToNote(path, content, options?)`, `readNote(path)`, all exported from
  `src/capabilities/providers/obsidian.ts`. Task 3's sync job consumes `parseNote`; Task 4's chat
  tools and Task 5/6's writer functions consume the rest.

- [ ] **Step 1: Add the `js-yaml` dependency**

In `package.json`'s `"dependencies"` block, add (alphabetically, between `"helmet"` and
`"imapflow"` — adjust to wherever it falls alphabetically among the existing entries):

```json
    "js-yaml": "^5.2.2",
```

Run: `npm install`
Expected: `js-yaml` appears in `package-lock.json`, install succeeds with no peer-dependency
errors.

**Before running `npm install`, re-check that `^5.2.2` is still the current stable release**
(`npm view js-yaml version`) — matching this codebase's existing dependency-verification
discipline for every other SDK addition.

- [ ] **Step 2: Create the scoped-folder mechanics and parser**

Create `src/capabilities/providers/obsidian.ts`:

```ts
import fs from "fs/promises";
import path from "path";
import { load as loadYaml, dump as dumpYaml } from "js-yaml";
import { ObservationPlatform } from "../../kernel/observation.js";

const observation = ObservationPlatform.getInstance();

export class ObsidianIntegrationError extends Error {
  constructor(message: string, public status = 500) {
    super(message);
  }
}

/**
 * Everything here is hard-scoped to one dedicated folder (OBSIDIAN_VAULT_DIR,
 * mounted at /obsidian-vault inside the container by default) — never the
 * wider filesystem. Same proven security boundary as
 * providers/files.ts's own resolveScopedPath, applied to a new root.
 */
function getRoot(): string {
  const root = process.env.OBSIDIAN_VAULT_DIR_MOUNT || "/obsidian-vault";
  return path.resolve(root);
}

function resolveScopedPath(relativePath: string): string {
  if (typeof relativePath !== "string" || relativePath.includes("\0")) {
    throw new ObsidianIntegrationError("Invalid path.", 400);
  }
  const root = getRoot();
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new ObsidianIntegrationError(`Path "${relativePath}" escapes the vault — not allowed.`, 403);
  }
  return resolved;
}

async function ensureRootExists(): Promise<void> {
  await fs.mkdir(getRoot(), { recursive: true });
}

function ensureMdExtension(relativePath: string): string {
  return relativePath.endsWith(".md") ? relativePath : `${relativePath}.md`;
}

/**
 * Turns free text (an objective, a topic) into a filesystem- and
 * Obsidian-safe note name: lowercase, non-alphanumeric runs collapsed to a
 * single hyphen, leading/trailing hyphens trimmed, capped to a sane length
 * so a very long objective doesn't produce an unwieldy filename.
 */
export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled"
  );
}

export interface ParsedNote {
  title: string;
  frontmatter: Record<string, any>;
  tags: string[];
  links: string[];
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
// Group 1: note name (no `]`, `|`, or `#`). Group 2 (optional): a
// "#Heading" suffix, kept as part of the raw link target. The optional
// "|Alias" part is matched but discarded — display text isn't part of a
// link's identity.
const WIKILINK_RE = /\[\[([^\]|#]+)(#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
// Known, disclosed simplification: this does not exclude tags inside
// fenced code blocks or inline code spans — a real but narrow gap, not a
// silent one.
const TAG_RE = /#([a-zA-Z0-9_/-]+)/g;

/**
 * Parses one note's raw text into its frontmatter, tags, and wikilink
 * targets. Pure function, no I/O — the sync job (scheduler.ts) is what
 * reads the file and calls this.
 */
export function parseNote(raw: string, fallbackTitle: string): ParsedNote {
  let content = raw;
  let frontmatter: Record<string, any> = {};
  const fmMatch = content.match(FRONTMATTER_RE);
  if (fmMatch) {
    try {
      const loaded = loadYaml(fmMatch[1]);
      if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) {
        frontmatter = loaded as Record<string, any>;
      }
    } catch {
      // Malformed frontmatter — treat the note as having none, rather than
      // failing the whole parse over one bad YAML block.
    }
    content = content.slice(fmMatch[0].length);
  }

  const links: string[] = [];
  WIKILINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKILINK_RE.exec(content)) !== null) {
    links.push(match[1].trim() + (match[2] || ""));
  }

  const tags = new Set<string>();
  if (Array.isArray(frontmatter.tags)) {
    for (const t of frontmatter.tags) {
      if (typeof t === "string") tags.add(t);
    }
  }
  TAG_RE.lastIndex = 0;
  while ((match = TAG_RE.exec(content)) !== null) {
    tags.add(match[1]);
  }

  const title = typeof frontmatter.title === "string" && frontmatter.title.trim()
    ? frontmatter.title.trim()
    : fallbackTitle;

  return { title, frontmatter, tags: [...tags], links };
}
```

- [ ] **Step 3: Add the file I/O functions**

In the same file, append:

```ts

export async function createNote(
  relativePath: string,
  content: string,
  frontmatter?: Record<string, any>
): Promise<{ path: string; bytesWritten: number }> {
  await ensureRootExists();
  const target = resolveScopedPath(ensureMdExtension(relativePath));
  await fs.mkdir(path.dirname(target), { recursive: true });
  const full = frontmatter && Object.keys(frontmatter).length > 0
    ? `---\n${dumpYaml(frontmatter)}---\n\n${content}`
    : content;
  await fs.writeFile(target, full, "utf-8");
  observation.logTelemetry("info", "Interaction", `Wrote vault note "${relativePath}"`);
  return { path: relativePath, bytesWritten: Buffer.byteLength(full) };
}

export async function appendToNote(
  relativePath: string,
  content: string,
  options: { createIfMissing?: boolean } = {}
): Promise<{ path: string; bytesWritten: number }> {
  await ensureRootExists();
  const target = resolveScopedPath(ensureMdExtension(relativePath));
  let exists = true;
  try {
    await fs.access(target);
  } catch {
    exists = false;
  }
  if (!exists) {
    if (!options.createIfMissing) {
      throw new ObsidianIntegrationError(`Note "${relativePath}" does not exist.`, 404);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf-8");
  } else {
    await fs.appendFile(target, content, "utf-8");
  }
  observation.logTelemetry("info", "Interaction", `Appended to vault note "${relativePath}"`);
  return { path: relativePath, bytesWritten: Buffer.byteLength(content) };
}

const MAX_READ_BYTES = 2_000_000; // notes are text; this is a generous cap, not a real limit

export async function readNote(relativePath: string): Promise<string> {
  await ensureRootExists();
  const target = resolveScopedPath(ensureMdExtension(relativePath));
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    throw new ObsidianIntegrationError(`Note "${relativePath}" does not exist.`, 404);
  }
  if (!stat.isFile()) throw new ObsidianIntegrationError(`"${relativePath}" is not a file.`, 400);
  if (stat.size > MAX_READ_BYTES) {
    throw new ObsidianIntegrationError(`"${relativePath}" is larger than ${MAX_READ_BYTES} bytes.`, 413);
  }
  return fs.readFile(target, "utf-8");
}

/**
 * Recursively lists every .md file's vault-relative path. Skips
 * `.obsidian/` and any other dotfile/dotdir — Obsidian's own app config
 * and metadata, never user content. Used by the sync job, not by any
 * chat-facing tool (search_vault reads the Postgres-backed index instead).
 */
export async function listAllNotePaths(): Promise<string[]> {
  await ensureRootExists();
  const root = getRoot();

  async function walk(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const results: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await walk(full)));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(path.relative(root, full));
      }
    }
    return results;
  }

  return walk(root);
}
```

- [ ] **Step 4: Write the parser unit tests**

In `tests/index.test.ts`, find:

```ts
import { upsertNote, listNotes, searchNotes, getBacklinks } from "../src/kernel/state/vault-repo.js";
```

Replace with:

```ts
import { upsertNote, listNotes, searchNotes, getBacklinks } from "../src/kernel/state/vault-repo.js";
import { parseNote, slugify } from "../src/capabilities/providers/obsidian.js";
```

Then add a new test category right after the `Vault` tests added in Task 1:

```ts
// ---------- Obsidian Parser Tests (pure functions, no I/O) ----------

registerTest("ObsidianParser", "parseNote extracts a plain wikilink", () => {
  const result = parseNote("See [[Bell's Theorem]] for details.", "fallback");
  if (!result.links.includes("Bell's Theorem")) {
    throw new Error(`ObsidianParser: expected to find the plain wikilink, got: ${JSON.stringify(result.links)}`);
  }
});

registerTest("ObsidianParser", "parseNote extracts a wikilink with an alias, discarding the alias", () => {
  const result = parseNote("See [[Bell's Theorem|the theorem]] for details.", "fallback");
  if (!result.links.includes("Bell's Theorem") || result.links.some(l => l.includes("the theorem"))) {
    throw new Error(`ObsidianParser: expected the alias to be discarded, got: ${JSON.stringify(result.links)}`);
  }
});

registerTest("ObsidianParser", "parseNote keeps a #Heading suffix as part of the link target", () => {
  const result = parseNote("See [[Quantum Physics#Entanglement]] for details.", "fallback");
  if (!result.links.includes("Quantum Physics#Entanglement")) {
    throw new Error(`ObsidianParser: expected the heading suffix to survive, got: ${JSON.stringify(result.links)}`);
  }
});

registerTest("ObsidianParser", "parseNote extracts inline #tags", () => {
  const result = parseNote("This is about #physics and #quantum-mechanics.", "fallback");
  if (!result.tags.includes("physics") || !result.tags.includes("quantum-mechanics")) {
    throw new Error(`ObsidianParser: expected both tags, got: ${JSON.stringify(result.tags)}`);
  }
});

registerTest("ObsidianParser", "parseNote reads a title and tags array from YAML frontmatter", () => {
  const raw = "---\ntitle: Quantum Physics Notes\ntags:\n  - physics\n  - research\n---\n\nBody text here.";
  const result = parseNote(raw, "fallback");
  if (result.title !== "Quantum Physics Notes") {
    throw new Error(`ObsidianParser: expected the frontmatter title, got: "${result.title}"`);
  }
  if (!result.tags.includes("physics") || !result.tags.includes("research")) {
    throw new Error(`ObsidianParser: expected both frontmatter tags, got: ${JSON.stringify(result.tags)}`);
  }
});

registerTest("ObsidianParser", "parseNote falls back to the provided title when there's no frontmatter", () => {
  const result = parseNote("Just plain body text, no frontmatter at all.", "My Fallback Title");
  if (result.title !== "My Fallback Title") {
    throw new Error(`ObsidianParser: expected the fallback title, got: "${result.title}"`);
  }
  if (result.links.length !== 0 || result.tags.length !== 0) {
    throw new Error("ObsidianParser: expected no links/tags in plain text with none present");
  }
});

registerTest("ObsidianParser", "slugify produces a filesystem-safe, lowercase, hyphenated name", () => {
  const result = slugify("Create a Seamstress Agent!");
  if (result !== "create-a-seamstress-agent") {
    throw new Error(`ObsidianParser: expected "create-a-seamstress-agent", got: "${result}"`);
  }
});

registerTest("ObsidianParser", "slugify never returns an empty string", () => {
  const result = slugify("!!!");
  if (!result || result.length === 0) {
    throw new Error(`ObsidianParser: expected a non-empty fallback slug, got: "${result}"`);
  }
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: `107 / 107 Tests Passed` (99 from Task 1 + 8 new `ObsidianParser` tests).

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/capabilities/providers/obsidian.ts tests/index.test.ts
git commit -m "feat: add the Obsidian vault provider (scoped I/O + frontmatter/wikilink/tag parsing)"
```

---

### Task 3: Vault sync job + mount configuration

**Files:**
- Modify: `src/kernel/scheduler.ts`
- Modify: `src/server.ts`
- Modify: `.env.example`
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: `listAllNotePaths`, `readNote`, `parseNote` from Task 2; `upsertNote`,
  `replaceLinksForNote` from Task 1.
- Produces: `startVaultSyncJob(intervalMs?)`, exported from `src/kernel/scheduler.ts`.

- [ ] **Step 1: Add the mount to `docker-compose.yml`**

Find:

```yaml
      - ${JARVIS_FILES_DIR}:/jarvis-files
```

Replace with:

```yaml
      - ${JARVIS_FILES_DIR}:/jarvis-files
      # The user's real, existing Obsidian vault — same scoped-mount
      # pattern as the jarvis-files folder above, new root (see
      # src/capabilities/providers/obsidian.ts).
      - ${OBSIDIAN_VAULT_DIR}:/obsidian-vault
```

- [ ] **Step 2: Add the env vars to `.env.example`**

Find:

```
JARVIS_FILES_DIR_MOUNT=
```

Replace with:

```
JARVIS_FILES_DIR_MOUNT=

# Used by src/capabilities/providers/obsidian.ts — bind-mounted read-write
# into the api container at /obsidian-vault. Point this at your real,
# existing Obsidian vault's folder on the host. This is the ONLY folder
# Jarvis's vault tools can ever read or write; nothing outside it is
# reachable, by construction, same boundary as JARVIS_FILES_DIR above.
OBSIDIAN_VAULT_DIR=
# Advanced/rarely needed: the container-internal mount point obsidian.ts
# reads from — defaults to "/obsidian-vault", matching the volume target
# above. Only set this if you've also changed that target in docker-compose.yml.
OBSIDIAN_VAULT_DIR_MOUNT=
```

- [ ] **Step 3: Add `startVaultSyncJob` to `scheduler.ts`**

Find:

```ts
import * as mcpServersRepo from "./state/mcp-servers-repo.js";
import * as mcpRegistry from "../capabilities/mcp-registry.js";
```

Replace with:

```ts
import * as mcpServersRepo from "./state/mcp-servers-repo.js";
import * as mcpRegistry from "../capabilities/mcp-registry.js";
import * as obsidian from "../capabilities/providers/obsidian.js";
import * as vaultRepo from "./state/vault-repo.js";
import crypto from "crypto";
```

Find the end of `startMcpHealthCheckJob` (the last job in the file):

```ts
export function startMcpHealthCheckJob(intervalMs = 30 * 60 * 1000): NodeJS.Timeout {
  return registerJob("mcp-health-check", intervalMs, async () => {
    const servers = await mcpServersRepo.listMcpServers("approved");
    for (const server of servers) {
      const reconnected = await mcpRegistry.refreshServerConnection(server.id);
      if (reconnected) {
        consecutiveFailures.delete(server.id);
        continue;
      }
      const failures = (consecutiveFailures.get(server.id) ?? 0) + 1;
      consecutiveFailures.set(server.id, failures);
      if (failures >= MCP_HEALTH_CHECK_FAILURE_THRESHOLD) {
        await mcpServersRepo.setMcpServerStatus(server.id, "error");
        observation.logTelemetry("warn", "McpHealthCheck", `Server "${server.name}" (#${server.id}) failed to reconnect ${failures} times in a row — marked 'error'.`);
        consecutiveFailures.delete(server.id);
      }
    }
  });
}
```

Add immediately after it:

```ts

/**
 * Keeps vault_notes/vault_links in sync with the real vault on disk —
 * reacting to edits the user makes directly in Obsidian, which Jarvis has
 * no other way to observe. Only re-parses a file whose content actually
 * changed (via a cheap content hash), so a large vault with mostly-static
 * notes stays fast on every tick. Only runs at all if OBSIDIAN_VAULT_DIR is
 * configured — same "absent env var means the feature quietly doesn't
 * start" pattern as startEmailWatchJob.
 */
export function startVaultSyncJob(intervalMs = 15 * 60 * 1000): NodeJS.Timeout | null {
  if (!process.env.OBSIDIAN_VAULT_DIR) {
    observation.logTelemetry("info", "Scheduler", "Vault sync job not started — OBSIDIAN_VAULT_DIR not configured.");
    return null;
  }
  return registerJob("vault-sync", intervalMs, async () => {
    const paths = await obsidian.listAllNotePaths();
    for (const notePath of paths) {
      try {
        const raw = await obsidian.readNote(notePath);
        const contentHash = crypto.createHash("sha256").update(raw).digest("hex");
        const existing = await vaultRepo.getNoteByPath(notePath);
        if (existing && existing.content_hash === contentHash) continue; // unchanged since last sync

        const fallbackTitle = (notePath.split("/").pop() || notePath).replace(/\.md$/, "");
        const parsed = obsidian.parseNote(raw, fallbackTitle);
        await vaultRepo.upsertNote(notePath, parsed.title, parsed.frontmatter, parsed.tags, contentHash);
        await vaultRepo.replaceLinksForNote(notePath, parsed.links);
      } catch (err: any) {
        observation.logTelemetry("warn", "VaultSync", `Failed to sync "${notePath}": ${err.message}`);
      }
    }
  });
}
```

- [ ] **Step 4: Register the job at server boot**

In `src/server.ts`, find the existing job-registration block (search for `scheduler.startMcpHealthCheckJob`):

```ts
  scheduler.startMcpHealthCheckJob();
```

Replace with:

```ts
  scheduler.startMcpHealthCheckJob();
  scheduler.startVaultSyncJob();
```

- [ ] **Step 5: Run tsc and the test suite**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test`
Expected: `107 / 107 Tests Passed` (unchanged — this task adds no new tests; the live filesystem
scan + real DB sync round-trip is verified manually at deploy time, consistent with how every
other recurring job's live behavior in this codebase has always been handled).

- [ ] **Step 6: Commit**

```bash
git add src/kernel/scheduler.ts src/server.ts .env.example docker-compose.yml
git commit -m "feat: add the vault sync job and OBSIDIAN_VAULT_DIR mount"
```

---

### Task 4: Read-side chat tools

**Files:**
- Modify: `src/kernel/security.ts`
- Modify: `src/capabilities/tools.ts`

**Interfaces:**
- Consumes: `searchNotes`, `getNoteByPath`, `getBacklinks` from `vault-repo.ts` (Task 1);
  `createNote` from `obsidian.ts` (Task 2).
- Produces: `search_vault`, `get_vault_note`, `get_vault_backlinks`, `write_vault_note` tool
  declarations, gated by two new capability grants.

- [ ] **Step 1: Add the two new capabilities**

In `src/kernel/security.ts`, find:

```ts
  "system.execute",
  "system.mcp_manage",
] as const;
```

Replace with:

```ts
  "system.execute",
  "system.mcp_manage",
  "vault.read",
  "vault.write",
] as const;
```

- [ ] **Step 2: Import the vault modules in `tools.ts`**

Find:

```ts
import * as mcpServersRepo from "../kernel/state/mcp-servers-repo.js";
import * as mcpRegistry from "./mcp-registry.js";
```

Replace with:

```ts
import * as mcpServersRepo from "../kernel/state/mcp-servers-repo.js";
import * as mcpRegistry from "./mcp-registry.js";
import * as vaultRepo from "../kernel/state/vault-repo.js";
import * as obsidian from "./providers/obsidian.js";
```

- [ ] **Step 3: Add the permission map entries**

Find:

```ts
  confirm_build_direction: "executive.plan",
};
```

Replace with:

```ts
  confirm_build_direction: "executive.plan",
  search_vault: "vault.read",
  get_vault_note: "vault.read",
  get_vault_backlinks: "vault.read",
  write_vault_note: "vault.write",
};
```

- [ ] **Step 4: Add the tool declarations**

Find the end of the `write_file` declaration:

```ts
  {
    name: "write_file",
    description: "Write (create or overwrite) a text file in the user's dedicated Jarvis notes folder.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: "Relative path to the file within the notes folder" },
        content: { type: Type.STRING, description: "The full text content to write" },
      },
      required: ["path", "content"],
    },
  },
```

Add immediately after it:

```ts
  {
    name: "search_vault",
    description: "Search the user's real Obsidian vault by note title or tag. Use this to find relevant existing notes before answering a question about something that might already be written down, or before creating a new note that might duplicate one.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "A title fragment or tag to search for" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_vault_note",
    description: "Read the full contents of one note in the user's Obsidian vault by its vault-relative path (e.g. \"Research/quantum-physics.md\").",
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: "The note's vault-relative path" },
      },
      required: ["path"],
    },
  },
  {
    name: "get_vault_backlinks",
    description: "Find every note in the vault that links to a given note — what points at this, not what this points to.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: "The target note's vault-relative path" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_vault_note",
    description: "Create or overwrite a note in the user's real Obsidian vault — same full read/write trust as the Jarvis notes folder tools above.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: "Vault-relative path for the note" },
        content: { type: Type.STRING, description: "The full note content (Markdown, may include [[wikilinks]] and #tags)" },
      },
      required: ["path", "content"],
    },
  },
```

- [ ] **Step 5: Add the `executeTool` cases**

Find:

```ts
      case "write_file":
        output = await files.writeFile(args.path, args.content);
        break;
```

Replace with:

```ts
      case "write_file":
        output = await files.writeFile(args.path, args.content);
        break;
      case "search_vault":
        output = { results: await vaultRepo.searchNotes(args.query) };
        break;
      case "get_vault_note": {
        const note = await vaultRepo.getNoteByPath(args.path);
        if (!note) {
          return { name, ok: false, error: `No indexed note at "${args.path}" — it may not exist, or the vault sync job hasn't run since it was created.` };
        }
        output = { content: await obsidian.readNote(args.path), frontmatter: note.frontmatter, tags: note.tags };
        break;
      }
      case "get_vault_backlinks":
        output = { backlinks: await vaultRepo.getBacklinks(args.path) };
        break;
      case "write_vault_note":
        output = await obsidian.createNote(args.path, args.content);
        break;
```

- [ ] **Step 6: Add keyword-routing entries**

Find:

```ts
  list_objectives: ["what am i tracking", "my goals", "my objectives", "what are my goals"],
};
```

Replace with:

```ts
  list_objectives: ["what am i tracking", "my goals", "my objectives", "what are my goals"],
  search_vault: ["in my vault", "in my notes", "search my vault", "find in my vault"],
  get_vault_note: ["read my note", "open my note", "what does my note say"],
  get_vault_backlinks: ["what links to", "backlinks for", "what references"],
  write_vault_note: ["add this to my vault", "save this to my vault", "create a vault note"],
};
```

- [ ] **Step 7: Run tsc and the test suite**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test`
Expected: `107 / 107 Tests Passed` (unchanged — no new tests in this task; `executeTool`'s dispatch
for these four cases is exercised the same way every other tool case in this file already is,
live at deploy time, not unit-tested individually).

- [ ] **Step 8: Commit**

```bash
git add src/kernel/security.ts src/capabilities/tools.ts
git commit -m "feat: add search_vault/get_vault_note/get_vault_backlinks/write_vault_note tools"
```

---

### Task 5: Research + Coding write-through (build-request lifecycle)

**Files:**
- Modify: `src/capabilities/providers/obsidian.ts`
- Modify: `src/executive/autonomous_executive.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `createNote`, `slugify` from Task 2.
- Produces: `writeResearchNote(buildRequestId, objective, summary)`,
  `writeOrUpdateCodingNote(buildRequestId, objective, fields)`, exported from
  `src/capabilities/providers/obsidian.ts`.

- [ ] **Step 1: Add the two writer functions to `obsidian.ts`**

Append to `src/capabilities/providers/obsidian.ts`:

```ts

function buildRequestNoteBasename(buildRequestId: number, objective: string): string {
  return `${slugify(objective)}-br${buildRequestId}`;
}

/**
 * Called once, right when a build request's research is first recorded —
 * event-driven, not batched, matching this codebase's existing "write
 * immediately at the point of persistence" pattern for everything else
 * that isn't explicitly a background job.
 */
export async function writeResearchNote(
  buildRequestId: number,
  objective: string,
  summary: string
): Promise<void> {
  const basename = buildRequestNoteBasename(buildRequestId, objective);
  await createNote(
    `Research/${basename}`,
    `# ${objective}\n\n${summary}\n`,
    { type: "research", build_request_id: buildRequestId, created: new Date().toISOString() }
  );
}

export interface CodingNoteFields {
  directionNotes?: string;
  codeSummary?: string;
  files?: string[];
  prUrl?: string;
  qaSummary?: string;
  status?: string;
}

/**
 * Coding notes are written/updated at several points across a build
 * request's life (direction confirmed + code drafted, then again once the
 * PR opens, then again once QA finishes) — always a full overwrite of the
 * note (not an append), since each call already has the complete current
 * state of the build request and the note should reflect that current
 * state, not a log of every intermediate edit.
 */
export async function writeOrUpdateCodingNote(
  buildRequestId: number,
  objective: string,
  fields: CodingNoteFields
): Promise<void> {
  const basename = buildRequestNoteBasename(buildRequestId, objective);
  const researchBasename = buildRequestNoteBasename(buildRequestId, objective);
  const lines: string[] = [`# ${objective}`, "", `[[Research/${researchBasename}]]`, ""];
  if (fields.directionNotes) lines.push("## Direction", "", fields.directionNotes, "");
  if (fields.codeSummary) lines.push("## Code", "", fields.codeSummary, "");
  if (fields.files && fields.files.length > 0) {
    lines.push("## Files", "", ...fields.files.map(f => `- \`${f}\``), "");
  }
  if (fields.prUrl) lines.push("## Pull Request", "", fields.prUrl, "");
  if (fields.qaSummary) lines.push("## QA", "", fields.qaSummary, "");

  await createNote(
    `Coding/${basename}`,
    lines.join("\n"),
    {
      type: "coding",
      build_request_id: buildRequestId,
      status: fields.status || "unknown",
      created: new Date().toISOString(),
    }
  );
}
```

- [ ] **Step 2: Call `writeResearchNote` after research is recorded**

In `src/executive/autonomous_executive.ts`, find:

```ts
import { ObservationPlatform } from "../kernel/observation.js";
```

Replace with:

```ts
import { ObservationPlatform } from "../kernel/observation.js";
import * as obsidian from "../capabilities/providers/obsidian.js";
```

Find:

```ts
      const buildRequest = await buildRequestsRepo.createBuildRequest(objective, username);
      const research = await departments.runResearch(objective, this.groq);
      const recorded = await buildRequestsRepo.recordResearch(buildRequest.id, research.summary);
```

Replace with:

```ts
      const buildRequest = await buildRequestsRepo.createBuildRequest(objective, username);
      const research = await departments.runResearch(objective, this.groq);
      const recorded = await buildRequestsRepo.recordResearch(buildRequest.id, research.summary);
      if (recorded) {
        obsidian.writeResearchNote(buildRequest.id, objective, research.summary).catch((err: any) => {
          this.observation.logTelemetry("warn", "Interaction", `Failed to write research vault note: ${err.message}`);
        });
      }
```

- [ ] **Step 3: Call `writeOrUpdateCodingNote` after a code draft is recorded**

In the same file, find:

```ts
    const recorded = await buildRequestsRepo.recordCodeDraft(confirmed.id, draft.summary, draft.files);
    if (!recorded) {
      await buildRequestsRepo.markCodeDraftError(confirmed.id, "Failed to persist the drafted code.");
      return { ok: false, message: "Direction confirmed and code drafted, but I couldn't save it — please try again." };
    }
```

Replace with:

```ts
    const recorded = await buildRequestsRepo.recordCodeDraft(confirmed.id, draft.summary, draft.files);
    if (!recorded) {
      await buildRequestsRepo.markCodeDraftError(confirmed.id, "Failed to persist the drafted code.");
      return { ok: false, message: "Direction confirmed and code drafted, but I couldn't save it — please try again." };
    }
    obsidian.writeOrUpdateCodingNote(confirmed.id, confirmed.objective, {
      directionNotes,
      codeSummary: draft.summary,
      files: draft.files.map(f => f.path),
      status: recorded.status,
    }).catch((err: any) => {
      this.observation.logTelemetry("warn", "Interaction", `Failed to write coding vault note: ${err.message}`);
    });
```

- [ ] **Step 4: Update the coding note once the PR opens and once QA finishes**

In `src/server.ts`, find:

```ts
import * as buildRequestsRepo from "./kernel/state/build-requests-repo.js";
```

Replace with:

```ts
import * as buildRequestsRepo from "./kernel/state/build-requests-repo.js";
import * as obsidian from "./capabilities/providers/obsidian.js";
```

This is `server.ts`'s first reference to `obsidian` — Tasks 1-4 never added an import of it to this
file (Task 3 only touched `scheduler.ts`'s imports and added a one-line `scheduler.startVaultSyncJob();`
call to `server.ts`'s existing boot sequence, no new import needed for that).

Find:

```ts
    const updated = await buildRequestsRepo.recordPrOpened(buildRequest.id, pr.html_url, pr.number);
    if (!updated) {
      return res.status(500).json({ error: "PR was opened but couldn't be recorded — check GitHub directly." });
    }

    observation.logAuditEvent(req.username, "build_request_pr_opened", "success", `#${updated.id} -> ${pr.html_url}`);

    // QA runs immediately, synchronously, right here — no CI polling (see
    // design spec's "Decisions"). CI's own result speaks for itself on
    // GitHub, same as any other PR.
    const qaSummary = await departments.reviewCodeDiff(updated.objective, files, groq);
    await buildRequestsRepo.recordQaReview(updated.id, qaSummary);
```

Replace with:

```ts
    const updated = await buildRequestsRepo.recordPrOpened(buildRequest.id, pr.html_url, pr.number);
    if (!updated) {
      return res.status(500).json({ error: "PR was opened but couldn't be recorded — check GitHub directly." });
    }

    observation.logAuditEvent(req.username, "build_request_pr_opened", "success", `#${updated.id} -> ${pr.html_url}`);

    obsidian.writeOrUpdateCodingNote(updated.id, updated.objective, {
      directionNotes: updated.direction_notes || undefined,
      codeSummary: updated.code_summary || undefined,
      files: files.map((f: any) => f.path),
      prUrl: updated.pr_url || undefined,
      status: updated.status,
    }).catch((err: any) => {
      observation.logTelemetry("warn", "Interaction", `Failed to write coding vault note: ${err.message}`);
    });

    // QA runs immediately, synchronously, right here — no CI polling (see
    // design spec's "Decisions"). CI's own result speaks for itself on
    // GitHub, same as any other PR.
    const qaSummary = await departments.reviewCodeDiff(updated.objective, files, groq);
    await buildRequestsRepo.recordQaReview(updated.id, qaSummary);

    obsidian.writeOrUpdateCodingNote(updated.id, updated.objective, {
      directionNotes: updated.direction_notes || undefined,
      codeSummary: updated.code_summary || undefined,
      files: files.map((f: any) => f.path),
      prUrl: updated.pr_url || undefined,
      qaSummary,
      status: "qa_complete",
    }).catch((err: any) => {
      observation.logTelemetry("warn", "Interaction", `Failed to write coding vault note: ${err.message}`);
    });
```

- [ ] **Step 5: Run tsc and the test suite**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test`
Expected: `107 / 107 Tests Passed` (unchanged — this task adds no new tests; the live filesystem
write is verified manually at deploy time).

- [ ] **Step 6: Commit**

```bash
git add src/capabilities/providers/obsidian.ts src/executive/autonomous_executive.ts src/server.ts
git commit -m "feat: write Research/Coding vault notes as build requests progress"
```

---

### Task 6: Reflections + Briefings write-through

**Files:**
- Modify: `src/capabilities/providers/obsidian.ts`
- Modify: `src/self/identity.ts`
- Modify: `src/kernel/scheduler.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `appendToNote` from Task 2.
- Produces: `appendReflectionEntry(category, content)`, `appendBriefingEntry(text, itemCount)`,
  exported from `src/capabilities/providers/obsidian.ts`.

- [ ] **Step 1: Add the two daily-rolling-note writer functions**

Append to `src/capabilities/providers/obsidian.ts`:

```ts

function todayNotePath(section: "Reflections" | "Briefings"): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `${section}/${today}`;
}

/**
 * Reflections and briefings are much higher-frequency than research/coding
 * (a self-reflection can fire after almost every reply; briefings run
 * hourly) — one note per day, appended to, keeps the vault browsable
 * instead of accumulating hundreds of tiny files.
 */
export async function appendReflectionEntry(category: string, content: string): Promise<void> {
  const timestamp = new Date().toISOString();
  await appendToNote(
    todayNotePath("Reflections"),
    `\n## ${timestamp} — ${category}\n\n${content}\n`,
    { createIfMissing: true }
  );
}

export async function appendBriefingEntry(text: string, itemCount: number): Promise<void> {
  const timestamp = new Date().toISOString();
  await appendToNote(
    todayNotePath("Briefings"),
    `\n## ${timestamp} (${itemCount} item(s))\n\n${text}\n`,
    { createIfMissing: true }
  );
}
```

- [ ] **Step 2: Call `appendReflectionEntry` from `identity.ts`'s `extractSelfReflection`**

In `src/self/identity.ts`, find:

```ts
import { ObservationPlatform } from "../kernel/observation.js";
import * as identityRepo from "../kernel/state/identity-repo.js";
```

Replace with:

```ts
import { ObservationPlatform } from "../kernel/observation.js";
import * as identityRepo from "../kernel/state/identity-repo.js";
import * as obsidian from "../capabilities/providers/obsidian.js";
```

Find:

```ts
    if (VALID_CATEGORIES.includes(category) && content) {
      await identityRepo.addSelfReflection(category, content, replyText.slice(0, 300));
      observation.logTelemetry("info", "Identity", `Recorded self-reflection (${category}): "${content.slice(0, 80)}"`);
    }
```

Replace with:

```ts
    if (VALID_CATEGORIES.includes(category) && content) {
      await identityRepo.addSelfReflection(category, content, replyText.slice(0, 300));
      observation.logTelemetry("info", "Identity", `Recorded self-reflection (${category}): "${content.slice(0, 80)}"`);
      obsidian.appendReflectionEntry(category, content).catch((err: any) => {
        observation.logTelemetry("warn", "Interaction", `Failed to write reflection vault entry: ${err.message}`);
      });
    }
```

- [ ] **Step 3: Call `appendReflectionEntry` from the two `saveProactiveThought` call sites**

In `src/kernel/scheduler.ts`, find:

```ts
import * as obsidian from "../capabilities/providers/obsidian.js";
import * as vaultRepo from "./state/vault-repo.js";
import crypto from "crypto";
```

(This import already exists from Task 3 — confirm with `grep -n "providers/obsidian.js" src/kernel/scheduler.ts` before proceeding; if it's already there, skip re-adding it.)

Find:

```ts
    const result = await identity.generateProactiveThought(groq);
    if (!result) return;
    try {
      await identityRepo.saveProactiveThought(result.content, result.basedOnCount);
    } catch (err: any) {
      observation.logTelemetry("warn", "Identity", `Failed to persist proactive thought: ${err.message}`);
    }
    pushNotification("admin", result.content, "info");
```

Replace with:

```ts
    const result = await identity.generateProactiveThought(groq);
    if (!result) return;
    try {
      await identityRepo.saveProactiveThought(result.content, result.basedOnCount);
      obsidian.appendReflectionEntry("proactive-thought", result.content).catch((err: any) => {
        observation.logTelemetry("warn", "Interaction", `Failed to write reflection vault entry: ${err.message}`);
      });
    } catch (err: any) {
      observation.logTelemetry("warn", "Identity", `Failed to persist proactive thought: ${err.message}`);
    }
    pushNotification("admin", result.content, "info");
```

In `src/server.ts`, find:

```ts
    await identityRepo.saveProactiveThought(result.content, result.basedOnCount);
    res.json({ available: true, ...result });
```

Replace with:

```ts
    await identityRepo.saveProactiveThought(result.content, result.basedOnCount);
    obsidian.appendReflectionEntry("proactive-thought", result.content).catch((err: any) => {
      observation.logTelemetry("warn", "Interaction", `Failed to write reflection vault entry: ${err.message}`);
    });
    res.json({ available: true, ...result });
```

- [ ] **Step 4: Call `appendBriefingEntry` from the two `saveBriefing` call sites**

In `src/kernel/scheduler.ts`, find:

```ts
    const result = await briefing.generateBriefing(groq, "admin");
    try {
      await briefingRepo.saveBriefing(result.text, result.itemCount, result.items);
    } catch (err: any) {
      observation.logTelemetry("warn", "Briefing", `Failed to persist briefing: ${err.message}`);
    }
```

Replace with:

```ts
    const result = await briefing.generateBriefing(groq, "admin");
    try {
      await briefingRepo.saveBriefing(result.text, result.itemCount, result.items);
      obsidian.appendBriefingEntry(result.text, result.itemCount).catch((err: any) => {
        observation.logTelemetry("warn", "Interaction", `Failed to write briefing vault entry: ${err.message}`);
      });
    } catch (err: any) {
      observation.logTelemetry("warn", "Briefing", `Failed to persist briefing: ${err.message}`);
    }
```

In `src/server.ts`, find:

```ts
    const result = await briefing.generateBriefing(groq, req.username);
    try {
      await briefingRepo.saveBriefing(result.text, result.itemCount, result.items);
    } catch (err: any) {
      observation.logTelemetry("warn", "Briefing", `Failed to persist on-demand briefing: ${err.message}`);
    }
```

Replace with:

```ts
    const result = await briefing.generateBriefing(groq, req.username);
    try {
      await briefingRepo.saveBriefing(result.text, result.itemCount, result.items);
      obsidian.appendBriefingEntry(result.text, result.itemCount).catch((err: any) => {
        observation.logTelemetry("warn", "Interaction", `Failed to write briefing vault entry: ${err.message}`);
      });
    } catch (err: any) {
      observation.logTelemetry("warn", "Briefing", `Failed to persist on-demand briefing: ${err.message}`);
    }
```

- [ ] **Step 5: Search for any missed call site**

Run: `grep -rn "addSelfReflection(\|saveProactiveThought(\|saveBriefing(" src/ --include="*.ts"` and
confirm every call site listed (4 total: `identity.ts`'s `addSelfReflection`, `scheduler.ts`'s and
`server.ts`'s `saveProactiveThought`, `scheduler.ts`'s and `server.ts`'s `saveBriefing` — 5 total
call sites across 3 files) now has an adjacent `obsidian.append...` call, per Steps 2-4 above.

- [ ] **Step 6: Run tsc and the test suite**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test`
Expected: `107 / 107 Tests Passed` (unchanged — no new tests in this task; the live filesystem
append is verified manually at deploy time).

- [ ] **Step 7: Commit**

```bash
git add src/capabilities/providers/obsidian.ts src/self/identity.ts src/kernel/scheduler.ts src/server.ts
git commit -m "feat: append Reflections/Briefings vault entries as they're generated"
```
