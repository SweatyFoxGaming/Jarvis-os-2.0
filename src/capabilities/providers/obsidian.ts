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
