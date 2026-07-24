# Vault Dashboard Panel — Design Spec

## Context

The Obsidian vault integration (`feat/obsidian-vault-core`) gives Jarvis a real, parsed, linked
view of the user's vault, but deliberately shipped with no dashboard UI — the design explicitly
scoped that out, treating chat tools and the real Obsidian app as "the interface for now." The
user asked where the vault's view was, and after hearing that answer, asked for a real dashboard
panel after all — closely mirroring the existing "Projects" panel built for build requests, with
browse, search, and inline editing (not just read-only).

This is a small, tightly-scoped follow-up: almost everything it needs already exists
(`vault-repo.ts`'s read functions, `obsidian.ts`'s `createNote`/`readNote`, the existing
`vault.read`/`vault.write` capability grants). The only genuinely new backend logic is three admin
routes and a small refactor to keep the Postgres-backed index fresh immediately after a
dashboard-driven edit, instead of waiting for the next scheduled sync tick.

## Architecture

**New: `obsidian.ts`'s `syncNoteToIndex(relativePath)`** — extracts the read-parse-hash-upsert
sequence `startVaultSyncJob`'s loop body already does per file into its own exported function.
`startVaultSyncJob` calls this instead of duplicating the logic inline (a pure refactor, no
behavior change to the existing job). The new dashboard write route calls it right after writing a
note, so the dashboard's own list view reflects an edit immediately rather than waiting up to 15
minutes for the next sync tick.

**New admin routes in `server.ts`** (mirroring the existing `/api/system/build-requests`
convention):
- `GET /api/system/vault/notes?query=<optional>` — `vault.read`. Returns `{ notes: VaultNoteRow[] }`
  via `vaultRepo.searchNotes(query)` when a query is given, `vaultRepo.listNotes()` otherwise.
- `GET /api/system/vault/note?path=<vault-relative-path>` — `vault.read`. Returns
  `{ content, frontmatter, tags, backlinks }`, combining `obsidian.readNote`,
  `vaultRepo.getNoteByPath`, and `vaultRepo.getBacklinks`. A path passed as a query parameter
  (not a route segment) sidesteps the Express route-matching/encoding pitfall a slash-containing
  identifier would otherwise hit — the same class of issue this codebase already fixed once for
  GitHub file paths in `commitFile`.
- `POST /api/system/vault/note` (body: `{ path, content }`) — `vault.write`. Calls
  `obsidian.createNote(path, content)` (the same create-or-overwrite semantics `write_vault_note`
  already has), then `obsidian.syncNoteToIndex(path)` so the list reflects it immediately. Handles
  both editing an existing note and creating a brand-new one — no separate "create" endpoint
  needed, matching `createNote`'s existing behavior.

**New dashboard panel** in `src/interaction/static/index.html`, following the existing "Projects"
panel's structure and conventions exactly: a nav entry, a search box, a note list (title, tags,
last-synced time), and a detail/edit pane — a plain `<textarea>` bound to the selected note's
content plus a Save button, a backlinks list, and a "New Note" flow that clears the pane for a
fresh path+content entry. No new frontend dependencies — this codebase has no existing rich-text
or markdown-editor widget, and introducing one for a single admin panel isn't warranted; a plain
textarea is consistent with how every other editable field in this dashboard already works.

## Explicitly out of scope

- Any change to `write_vault_note`'s chat-tool semantics or permission model — this panel is a
  second caller of the same underlying `createNote`, not a new capability.
- Rendering Markdown/wikilinks as rich, clickable HTML in the detail pane — the textarea shows and
  edits raw Markdown text, matching the plain-text editing model already used everywhere else in
  this dashboard. A rendered preview is a reasonable future follow-up, not bundled here.
- Any change to the sync job's cadence or the vault_notes/vault_links schema.

## Testing

- `syncNoteToIndex`'s extraction is a pure refactor of existing, already-covered logic — no new
  unit test required for it specifically, but `npm test`/`tsc` must stay green throughout, and the
  refactored `startVaultSyncJob` must behave identically (verified manually, consistent with how
  this job's live behavior has always been checked, not unit-tested).
- The three new routes: verified manually at deploy time (real HTTP round-trips against a real
  vault), consistent with how every other admin route touching a live filesystem/LLM/network
  resource in this codebase has always been verified — not unit-tested individually.

## Decisions made during brainstorming

- **Browse + search + inline editing** chosen over read-only, per explicit user preference — the
  dashboard becomes a second, equally-capable place to edit notes, not just view them.
- **Query-parameter path identifiers, not route-segment paths** — avoids the exact class of
  path-encoding bug this codebase has already hit and fixed once before (GitHub file commits).
- **A shared `syncNoteToIndex` helper, not duplicated logic** — keeps the dashboard's list
  immediately fresh after an edit without waiting for the next scheduled sync tick, and avoids two
  copies of the same parse-and-upsert sequence drifting apart over time.
- **Plain textarea, no rich markdown editor** — matches this dashboard's existing, consistent
  plain-text-editing convention; avoids a new frontend dependency for one panel.
