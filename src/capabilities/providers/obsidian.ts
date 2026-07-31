import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { load as loadYaml, dump as dumpYaml } from "js-yaml";
import { ObservationPlatform } from "../../kernel/observation.js";
import * as vaultRepo from "../../kernel/state/vault-repo.js";

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
const MOC_FOLDERS = ["Adaptation", "Briefings", "Coding", "Reflections", "Research"] as const;
type MocFolder = typeof MOC_FOLDERS[number];

function mocNotePath(folder: MocFolder): string {
  return `${folder} MOC.md`;
}

// Every note Jarvis creates gets a Category/Date frontmatter pointing at
// its folder's MOC — without this, Obsidian's Graph View shows every note
// as a disconnected floating node, since nothing links them to anything.
// Merged with (and overridable by) each call site's own frontmatter object
// so e.g. writeResearchNote's existing {type, build_request_id, created}
// fields are preserved alongside these two new ones.
function withMocFrontmatter(folder: MocFolder, frontmatter: Record<string, any> = {}, dateStr?: string): Record<string, any> {
  const today = dateStr || new Date().toISOString().slice(0, 10);
  return { Category: `[[${folder} MOC]]`, Date: `[[${today}]]`, ...frontmatter };
}

// Ensures `${folder} MOC.md` exists and contains a bulleted wikilink to
// `linkTarget` (e.g. "Coding/my-objective-br42") — idempotent, since
// writeOrUpdateCodingNote rewrites the same note multiple times across a
// build request's life (direction confirmed, PR opened, QA complete) and
// must not accumulate duplicate links on repeated calls, and
// appendReflectionEntry/appendBriefingEntry call this once per entry
// against the same daily note.
const mocWriteQueues = new Map<MocFolder, Promise<unknown>>();

// Serializes read-check-write cycles per MOC file — without this, two
// concurrent calls for the same folder (e.g. two different users' build
// requests both finishing around the same moment) could both read the MOC
// before either writes, and the second write would silently clobber the
// first caller's freshly-added link (a lost-update race). Calls for
// DIFFERENT folders are unaffected and still run concurrently — this only
// serializes access to the same MOC file.
async function ensureLinkedInMoc(folder: MocFolder, linkTarget: string): Promise<void> {
  const previous = mocWriteQueues.get(folder) || Promise.resolve();
  const task = previous.then(async () => {
    const link = `[[${linkTarget}]]`;
    const moc = mocNotePath(folder);
    let current: string;
    try {
      current = await readNote(moc);
    } catch {
      current = `# ${folder} MOC\n\n## Linked Notes\n`;
    }
    if (current.includes(link)) return;
    const updated = current.endsWith("\n") ? `${current}* ${link}\n` : `${current}\n* ${link}\n`;
    await createNote(moc, updated);
  });
  // Swallow so a single failed call doesn't permanently wedge the queue for
  // every later call to the same folder — the failure still propagates to
  // THIS call's own awaiter via `await task` below.
  mocWriteQueues.set(folder, task.catch(() => {}));
  await task;
}

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

/**
 * Second-stage boundary check, on top of resolveScopedPath's purely lexical
 * one: resolves the REAL path (following any symlinks) of `target` and
 * confirms it's still inside the vault root. A symlink placed inside the
 * vault pointing outside it (e.g. `ln -s /etc ~/vault/escape`) passes
 * resolveScopedPath's string-based check untouched, since that check never
 * hits the filesystem — this is what actually stops the read/write from
 * following it out.
 *
 * Deliberately NOT folded into resolveScopedPath itself: that function also
 * computes a path for a note that doesn't exist YET (createNote writing a
 * brand-new file, or appendToNote's createIfMissing branch), and
 * fs.realpath throws ENOENT on a path that isn't there. So instead of
 * requiring `target` itself to exist, this walks up to the nearest existing
 * ancestor (the target itself for a read/append-to-existing, or the
 * containing directory — freshly mkdir'd by the caller — for a new note)
 * and realpath's that. Anything created below that point by this same call
 * is a plain new file/directory we're about to write, not an
 * already-existing symlink, so checking the nearest existing ancestor is
 * sufficient: fs.realpath fully resolves every symlink in the chain down to
 * that ancestor, so if the ancestor's real location is inside the root,
 * everything created under it lexically is too.
 *
 * Best-effort by design (per the caller contract): callers call this right
 * before the actual read/write, after `resolveScopedPath` + any directory
 * creation has already happened.
 */
async function assertRealPathWithinRoot(target: string): Promise<void> {
  const root = getRoot();
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    // Root itself doesn't exist somehow (ensureRootExists should have just
    // created it) — nothing sensible to compare against, so let the
    // subsequent filesystem call fail on its own terms instead.
    return;
  }

  let candidate = target;
  for (;;) {
    try {
      const real = await fs.realpath(candidate);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
        throw new ObsidianIntegrationError(
          `Path "${target}" resolves outside the vault via a symlink — not allowed.`,
          403
        );
      }
      return;
    } catch (err) {
      if (err instanceof ObsidianIntegrationError) throw err;
      const parent = path.dirname(candidate);
      if (parent === candidate) return; // walked to the filesystem root without finding an existing ancestor — nothing left to check
      candidate = parent;
    }
  }
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

export async function createNote(
  relativePath: string,
  content: string,
  frontmatter?: Record<string, any>
): Promise<{ path: string; bytesWritten: number }> {
  await ensureRootExists();
  const target = resolveScopedPath(ensureMdExtension(relativePath));
  // Checked BEFORE mkdir, not after: assertRealPathWithinRoot walks up to
  // the nearest existing ancestor when target doesn't exist yet, so calling
  // it first means that ancestor is whatever's genuinely already on disk —
  // if mkdir ran first instead, a symlinked directory partway down this
  // path would let mkdir -p create real directories outside the vault
  // before the check ever had a pre-mkdir ancestor to catch it against.
  await assertRealPathWithinRoot(target);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o775 });
  const full = frontmatter && Object.keys(frontmatter).length > 0
    ? `---\n${dumpYaml(frontmatter)}---\n\n${content}`
    : content;
  await fs.writeFile(target, full, { encoding: "utf-8", mode: 0o664 });
  await fs.chmod(target, 0o664);
  observation.logTelemetry("info", "Interaction", `Wrote vault note "${relativePath}"`);
  return { path: relativePath, bytesWritten: Buffer.byteLength(full) };
}

export async function appendToNote(
  relativePath: string,
  content: string,
  options: { createIfMissing?: boolean; frontmatterOnCreate?: Record<string, any> } = {}
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
    // Same ordering fix as createNote: check the pre-existing filesystem
    // state before mkdir -p can create anything through a symlink.
    await assertRealPathWithinRoot(target);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o775 });
    const initial = options.frontmatterOnCreate && Object.keys(options.frontmatterOnCreate).length > 0
      ? `---\n${dumpYaml(options.frontmatterOnCreate)}---\n\n${content}`
      : content;
    await fs.writeFile(target, initial, { encoding: "utf-8", mode: 0o664 });
    await fs.chmod(target, 0o664);
  } else {
    await assertRealPathWithinRoot(target);
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
  await assertRealPathWithinRoot(target);
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
        // Defense-in-depth against a symlinked .md file pointing outside the
        // vault: skip (rather than throw, matching this walk's own
        // resilience — one bad entry shouldn't abort listing the rest of
        // the vault) and log it if the real path escapes the root.
        try {
          await assertRealPathWithinRoot(full);
          results.push(path.relative(root, full));
        } catch (err: any) {
          observation.logTelemetry("warn", "Interaction", `Skipped vault entry "${full}" during walk: ${err.message}`);
        }
      }
    }
    return results;
  }

  return walk(root);
}

/**
 * Re-parses one note from disk and upserts it into the Postgres-backed
 * index (vault_notes/vault_links) — the exact per-file body
 * startVaultSyncJob's loop already runs on every tick, extracted so a
 * dashboard-driven write can call it directly and see the change reflected
 * immediately, instead of waiting for the next scheduled sync tick.
 */
export async function syncNoteToIndex(relativePath: string): Promise<void> {
  const raw = await readNote(relativePath);
  const contentHash = crypto.createHash("sha256").update(raw).digest("hex");
  const existing = await vaultRepo.getNoteByPath(relativePath);
  if (existing && existing.content_hash === contentHash) return; // unchanged

  const fallbackTitle = (relativePath.split("/").pop() || relativePath).replace(/\.md$/, "");
  const parsed = parseNote(raw, fallbackTitle);
  await vaultRepo.upsertNote(relativePath, parsed.title, parsed.frontmatter, parsed.tags, contentHash);
  await vaultRepo.replaceLinksForNote(relativePath, parsed.links);
}

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
  if (!process.env.OBSIDIAN_VAULT_DIR) {
    observation.logTelemetry("info", "Interaction", "Skipped writing research vault note — OBSIDIAN_VAULT_DIR not configured.");
    return;
  }
  const basename = buildRequestNoteBasename(buildRequestId, objective);
  await createNote(
    `Research/${basename}`,
    `# ${objective}\n\n${summary}\n`,
    withMocFrontmatter("Research", { type: "research", build_request_id: buildRequestId, created: new Date().toISOString() })
  );
  await ensureLinkedInMoc("Research", `Research/${basename}`);
}

export async function writeAdaptationReport(
  dateStr: string,
  reflectionText: string,
  capabilityGaps: string[],
  candidateObjective: string,
  analyzerSummary: string
): Promise<void> {
  if (!process.env.OBSIDIAN_VAULT_DIR) {
    observation.logTelemetry("info", "Interaction", "Skipped writing adaptation report — OBSIDIAN_VAULT_DIR not configured.");
    return;
  }
  const lines: string[] = [
    `# Daily Adaptation — ${dateStr}`,
    "",
    reflectionText,
    "",
    "## Analyzer Signals",
    "",
    analyzerSummary || "(no analyzer signals computed today)",
    "",
    "## Capability Gaps",
    "",
    ...(capabilityGaps.length > 0 ? capabilityGaps.map(g => `- ${g}`) : ["- None identified today."]),
    "",
    "## Candidate Next Objective",
    "",
    candidateObjective || "(none identified today)",
    "",
  ];
  await createNote(
    `Adaptation/${dateStr}`,
    lines.join("\n"),
    withMocFrontmatter("Adaptation", { type: "adaptation-report", created: new Date().toISOString() })
  );
  await ensureLinkedInMoc("Adaptation", `Adaptation/${dateStr}`);
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
  if (!process.env.OBSIDIAN_VAULT_DIR) {
    observation.logTelemetry("info", "Interaction", "Skipped writing coding vault note — OBSIDIAN_VAULT_DIR not configured.");
    return;
  }
  const basename = buildRequestNoteBasename(buildRequestId, objective);
  const lines: string[] = [`# ${objective}`, "", `[[Research/${basename}]]`, ""];
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
    withMocFrontmatter("Coding", {
      type: "coding",
      build_request_id: buildRequestId,
      status: fields.status || "unknown",
      created: new Date().toISOString(),
    })
  );
  await ensureLinkedInMoc("Coding", `Coding/${basename}`);
}

function todayNotePath(section: "Reflections" | "Briefings", dateStr?: string): string {
  const today = dateStr || new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `${section}/${today}`;
}

/**
 * Reflections and briefings are much higher-frequency than research/coding
 * (a self-reflection can fire after almost every reply; briefings run
 * hourly) — one note per day, appended to, keeps the vault browsable
 * instead of accumulating hundreds of tiny files.
 */
export async function appendReflectionEntry(category: string, content: string): Promise<void> {
  if (!process.env.OBSIDIAN_VAULT_DIR) {
    observation.logTelemetry("info", "Interaction", "Skipped appending reflection vault entry — OBSIDIAN_VAULT_DIR not configured.");
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const timestamp = new Date().toISOString();
  const notePath = todayNotePath("Reflections", today);
  await appendToNote(
    notePath,
    `\n## ${timestamp} — ${category}\n\n${content}\n`,
    { createIfMissing: true, frontmatterOnCreate: withMocFrontmatter("Reflections", {}, today) }
  );
  await ensureLinkedInMoc("Reflections", notePath);
}

export async function appendBriefingEntry(text: string, itemCount: number): Promise<void> {
  if (!process.env.OBSIDIAN_VAULT_DIR) {
    observation.logTelemetry("info", "Interaction", "Skipped appending briefing vault entry — OBSIDIAN_VAULT_DIR not configured.");
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const timestamp = new Date().toISOString();
  const notePath = todayNotePath("Briefings", today);
  await appendToNote(
    notePath,
    `\n## ${timestamp} (${itemCount} item(s))\n\n${text}\n`,
    { createIfMissing: true, frontmatterOnCreate: withMocFrontmatter("Briefings", {}, today) }
  );
  await ensureLinkedInMoc("Briefings", notePath);
}
