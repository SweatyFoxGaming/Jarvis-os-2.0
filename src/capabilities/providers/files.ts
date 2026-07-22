import fs from "fs/promises";
import path from "path";
import { ObservationPlatform } from "../../kernel/observation.js";

const observation = ObservationPlatform.getInstance();

export class FilesIntegrationError extends Error {
  constructor(message: string, public status = 500) {
    super(message);
  }
}

/**
 * Everything here is hard-scoped to one dedicated folder (JARVIS_FILES_DIR,
 * mounted at /jarvis-files inside the container) — never the wider
 * filesystem. This is the permission boundary the user chose over broader,
 * self-nominated directory access: safer to reason about, at the cost of
 * only covering files actually placed in that one folder.
 */
function getRoot(): string {
  const root = process.env.JARVIS_FILES_DIR_MOUNT || "/jarvis-files";
  return path.resolve(root);
}

/**
 * Resolves a user-supplied relative path against the root and refuses
 * anything that would escape it — the actual security boundary, not just
 * documentation of one. Rejects absolute paths, `..` segments that climb out
 * (via path.resolve + a prefix check, not a naive string match, so tricks
 * like symlink-looking segments or encoded traversal still land inside the
 * resolved check), and null bytes.
 */
function resolveScopedPath(relativePath: string): string {
  if (typeof relativePath !== "string" || relativePath.includes("\0")) {
    throw new FilesIntegrationError("Invalid path.", 400);
  }
  const root = getRoot();
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new FilesIntegrationError(`Path "${relativePath}" escapes the Jarvis files folder — not allowed.`, 403);
  }
  return resolved;
}

async function ensureRootExists(): Promise<void> {
  const root = getRoot();
  await fs.mkdir(root, { recursive: true });
}

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modifiedAt?: string;
}

export async function listFiles(relativePath = "."): Promise<FileEntry[]> {
  await ensureRootExists();
  const dir = resolveScopedPath(relativePath);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err: any) {
    if (err.code === "ENOENT") throw new FilesIntegrationError(`"${relativePath}" does not exist.`, 404);
    if (err.code === "ENOTDIR") throw new FilesIntegrationError(`"${relativePath}" is not a directory.`, 400);
    throw new FilesIntegrationError(err.message, 500);
  }
  const root = getRoot();
  const results: FileEntry[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    if (entry.isDirectory()) {
      results.push({ name: entry.name, path: rel, type: "directory" });
    } else if (entry.isFile()) {
      const stat = await fs.stat(full);
      results.push({ name: entry.name, path: rel, type: "file", size: stat.size, modifiedAt: stat.mtime.toISOString() });
    }
  }
  return results;
}

const MAX_READ_BYTES = 1_000_000; // 1MB — this is for notes, not arbitrary binary files

export async function readFile(relativePath: string): Promise<string> {
  await ensureRootExists();
  const target = resolveScopedPath(relativePath);
  let stat;
  try {
    stat = await fs.stat(target);
  } catch (err: any) {
    if (err.code === "ENOENT") throw new FilesIntegrationError(`"${relativePath}" does not exist.`, 404);
    throw new FilesIntegrationError(err.message, 500);
  }
  if (!stat.isFile()) throw new FilesIntegrationError(`"${relativePath}" is not a file.`, 400);
  if (stat.size > MAX_READ_BYTES) {
    throw new FilesIntegrationError(`"${relativePath}" is larger than ${MAX_READ_BYTES} bytes — too large to read as a note.`, 413);
  }
  return fs.readFile(target, "utf-8");
}

export async function writeFile(relativePath: string, content: string): Promise<{ path: string; bytesWritten: number }> {
  await ensureRootExists();
  const target = resolveScopedPath(relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf-8");
  observation.logTelemetry("info", "Integrations", `Wrote ${Buffer.byteLength(content)} byte(s) to Jarvis file "${relativePath}"`);
  return { path: relativePath, bytesWritten: Buffer.byteLength(content) };
}

export async function deleteFile(relativePath: string): Promise<void> {
  const target = resolveScopedPath(relativePath);
  if (target === getRoot()) {
    throw new FilesIntegrationError("Refusing to delete the Jarvis files root itself.", 400);
  }
  try {
    await fs.unlink(target);
  } catch (err: any) {
    if (err.code === "ENOENT") throw new FilesIntegrationError(`"${relativePath}" does not exist.`, 404);
    throw new FilesIntegrationError(err.message, 500);
  }
  observation.logTelemetry("info", "Integrations", `Deleted Jarvis file "${relativePath}"`);
}
