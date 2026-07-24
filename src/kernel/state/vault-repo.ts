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

// Wrapped in a transaction so a failure partway through never leaves a note
// with its old links deleted but new links only partially inserted — the
// sync job runs this on every tick for every changed note, so a transient
// mid-loop failure without this would otherwise show a real, if
// self-healing-next-tick, inconsistent link state in the meantime.
export async function replaceLinksForNote(fromPath: string, targets: string[]): Promise<void> {
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM vault_links WHERE from_path = $1`, [fromPath]);
    for (const target of targets) {
      await client.query(
        `INSERT INTO vault_links (from_path, to_path_raw, link_type) VALUES ($1, $2, 'wikilink')`,
        [fromPath, target]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
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
    // Title and tag matching are both case-insensitive (ILIKE / EXISTS+ILIKE
    // over unnest(tags)) — a search for "Physics" should find a #physics tag
    // the same way it'd find a "Physics Notes" title, not silently miss it
    // over a case mismatch.
    const { rows } = await db.query(
      `SELECT * FROM vault_notes
       WHERE title ILIKE $1 OR EXISTS (SELECT 1 FROM unnest(tags) t WHERE t ILIKE $1)
       ORDER BY last_synced_at DESC LIMIT $2`,
      [`%${query}%`, limit]
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
