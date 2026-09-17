import { Router } from 'express';
import { ObservationPlatform } from "../../kernel/observation.js";
import { validateApiKey } from "../../kernel/auth-middleware.js";
import * as permissions from "../../kernel/security.js";
import * as vaultRepo from "../../kernel/state/vault-repo.js";
import * as obsidian from "../../capabilities/providers/obsidian.js";

const observation = ObservationPlatform.getInstance();

export const vaultRouter: Router = Router();

vaultRouter.get("/api/system/vault/notes", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "vault.read")) {
    return res.status(403).json({ error: 'Missing capability grant "vault.read"' });
  }
  const query = typeof req.query.query === "string" ? req.query.query.trim() : "";
  const notes = query ? await vaultRepo.searchNotes(query, 50) : await vaultRepo.listNotes();
  res.json({ notes });
});

vaultRouter.get("/api/system/vault/note", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "vault.read")) {
    return res.status(403).json({ error: 'Missing capability grant "vault.read"' });
  }
  const notePath = typeof req.query.path === "string" ? req.query.path : "";
  if (!notePath) {
    return res.status(400).json({ error: "Missing required 'path' query parameter." });
  }
  try {
    const [content, indexed, backlinks] = await Promise.all([
      obsidian.readNote(notePath),
      vaultRepo.getNoteByPath(notePath),
      vaultRepo.getBacklinks(notePath),
    ]);
    res.json({
      content,
      frontmatter: indexed?.frontmatter || {},
      tags: indexed?.tags || [],
      backlinks,
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

vaultRouter.post("/api/system/vault/note", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "vault.write")) {
    return res.status(403).json({ error: 'Missing capability grant "vault.write"' });
  }
  const { path: notePath, content } = req.body || {};
  if (typeof notePath !== "string" || !notePath.trim() || typeof content !== "string") {
    return res.status(400).json({ error: "Both 'path' (non-empty string) and 'content' (string) are required." });
  }
  try {
    const result = await obsidian.createNote(notePath, content);
    const indexPath = result.path.endsWith(".md") ? result.path : `${result.path}.md`;
    try {
      await obsidian.syncNoteToIndex(indexPath);
    } catch (err: any) {
      observation.logTelemetry("warn", "Interaction", `Failed to sync dashboard-written note "${result.path}" to index: ${err.message}`);
    }
    observation.logAuditEvent(req.username, "vault_note_written_via_dashboard", "success", result.path);
    res.json(result);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

vaultRouter.get("/api/system/vault/graph", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "vault.read")) {
    return res.status(403).json({ error: 'Missing capability grant "vault.read"' });
  }
  const GRAPH_NOTE_LIMIT = 150;
  const [notes, links] = await Promise.all([
    vaultRepo.listNotes(GRAPH_NOTE_LIMIT),
    vaultRepo.listAllLinks(GRAPH_NOTE_LIMIT),
  ]);
  res.json({ notes, links });
});
