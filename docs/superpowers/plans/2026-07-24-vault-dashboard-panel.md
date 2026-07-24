# Vault Dashboard Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Obsidian vault integration a real dashboard panel — browse, search, and inline-edit notes — instead of leaving chat tools and the real Obsidian app as the only interface.

**Architecture:** Extract a `syncNoteToIndex(relativePath)` helper from the existing vault sync job's per-file loop body (pure refactor), add three admin routes in `server.ts` that reuse `obsidian.ts`/`vault-repo.ts`'s existing functions plus the new helper, and add a "Vault" panel to `index.html` following the existing "Projects" panel's exact structure (nav entry, list, detail pane, plain-textarea editing).

**Tech Stack:** TypeScript/Express (`src/server.ts`), existing `obsidian.ts`/`vault-repo.ts` modules, vanilla JS + Tailwind classes in `src/interaction/static/index.html` (no new frontend dependencies).

## Global Constraints

- Path identifiers travel as a query parameter (`?path=`), never a route segment — avoids the exact path-encoding class of bug this codebase already hit once in `commitFile` (see spec's "Decisions").
- No new frontend dependency — the detail pane is a plain `<textarea>`, matching every other editable field in this dashboard. No rich-text/Markdown-preview widget.
- `write_vault_note`'s chat-tool semantics and permission model are untouched — the new `POST /api/system/vault/note` route is a second caller of `obsidian.createNote`, not a new capability or a new gate.
- The sync job's cadence and the `vault_notes`/`vault_links` schema are untouched.
- Routes gate on the existing `vault.read`/`vault.write` capability grants via `permissions.hasGrant(req.username, "vault.read" | "vault.write")`, the same pattern every other admin route in `server.ts` already uses (see `/api/system/build-requests`).
- `npm test` (`tsx tests/index.test.ts`) and `tsc --noEmit` must stay green after every task.

---

### Task 1: Extract `syncNoteToIndex` and use it from the sync job

**Files:**
- Modify: `src/capabilities/providers/obsidian.ts`
- Modify: `src/kernel/scheduler.ts:225-264` (`startVaultSyncJob`)
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `vaultRepo.getNoteByPath`, `vaultRepo.upsertNote`, `vaultRepo.replaceLinksForNote` (all already exist in `src/kernel/state/vault-repo.ts`), `obsidian.readNote`, `obsidian.parseNote` (already exist in `obsidian.ts`).
- Produces: `export async function syncNoteToIndex(relativePath: string): Promise<void>` in `obsidian.ts` — Task 2's write route calls this directly after a note is created/edited via the dashboard.

This is a pure refactor: the exact body of `startVaultSyncJob`'s per-file try block moves into a new exported function in `obsidian.ts`, and the job calls that function instead of inlining the logic. No behavior change.

- [ ] **Step 1: Add `syncNoteToIndex` to `obsidian.ts`**

Add this import near the top of `src/capabilities/providers/obsidian.ts` (it currently has no `crypto` or `vault-repo` imports):

```typescript
import crypto from "crypto";
import * as vaultRepo from "../../kernel/state/vault-repo.js";
```

Add this function after `listAllNotePaths` (before `buildRequestNoteBasename`):

```typescript
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
```

- [ ] **Step 2: Replace the inline logic in `scheduler.ts` with a call to `syncNoteToIndex`**

In `src/kernel/scheduler.ts`, `startVaultSyncJob`'s loop currently reads:

```typescript
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
```

Replace the `try` block's body with a single call:

```typescript
  return registerJob("vault-sync", intervalMs, async () => {
    const paths = await obsidian.listAllNotePaths();
    for (const notePath of paths) {
      try {
        await obsidian.syncNoteToIndex(notePath);
      } catch (err: any) {
        observation.logTelemetry("warn", "VaultSync", `Failed to sync "${notePath}": ${err.message}`);
      }
    }
```

The rest of `startVaultSyncJob` (the pruning pass below the loop) is unchanged. After this edit, `scheduler.ts`'s `crypto` import is no longer used by this function — check with `grep -n "crypto\." src/kernel/scheduler.ts` whether anything else in the file still uses it; if nothing does, remove the now-unused `import crypto from "crypto";` line (`tsc --noEmit` will flag an unused import as an error if `noUnusedLocals` is on — check `tsconfig.json`; if it's not enforced, still remove it for cleanliness since nothing else in this task touches that line).

- [ ] **Step 3: Run the full test suite to confirm no behavior change**

Run: `npm test`
Expected: same pass count as before this task (107/107 as of the last recorded run — confirm the actual current count from the test runner's own summary line rather than assuming 107, since other work may have added tests since). No new failures.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/capabilities/providers/obsidian.ts src/kernel/scheduler.ts
git commit -m "refactor: extract syncNoteToIndex from the vault sync job's loop body"
```

---

### Task 2: Add the three vault admin routes to `server.ts`

**Files:**
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `obsidian.readNote`, `obsidian.createNote`, `obsidian.syncNoteToIndex` (from Task 1), `vaultRepo.listNotes`, `vaultRepo.searchNotes`, `vaultRepo.getNoteByPath`, `vaultRepo.getBacklinks` — all already exist. `permissions.hasGrant(username, capability)` — already used throughout `server.ts` for every other admin route (e.g. `/api/system/build-requests`).
- Produces: three routes Task 3's frontend calls directly:
  - `GET /api/system/vault/notes?query=<optional>` → `{ notes: VaultNoteRow[] }`
  - `GET /api/system/vault/note?path=<vault-relative-path>` → `{ content: string, frontmatter: object, tags: string[], backlinks: VaultLinkRow[] }` (404 `{ error }` if the note doesn't exist)
  - `POST /api/system/vault/note` body `{ path: string, content: string }` → `{ path: string, bytesWritten: number }`

`server.ts` already imports `obsidian` and `vaultRepo`? Check first — Task 6 of the vault-core plan added `obsidian` calls to `server.ts` for the identity/briefing routes, so the import should already be there. Confirm with `grep -n "from \"./capabilities/providers/obsidian.js\"\|from \"./kernel/state/vault-repo.js\"" src/server.ts`. If `vaultRepo` is not yet imported in `server.ts`, add `import * as vaultRepo from "./kernel/state/vault-repo.js";` next to the other `kernel/state/*-repo.js` imports.

- [ ] **Step 1: Add the three routes**

Add these routes in `src/server.ts` immediately after the existing `/api/system/build-requests/:id/reject-code` route (find it with `grep -n "reject-code" src/server.ts` — add the new routes right after that handler's closing `});`):

```typescript
app.get("/api/system/vault/notes", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "vault.read")) {
    return res.status(403).json({ error: 'Missing capability grant "vault.read"' });
  }
  const query = typeof req.query.query === "string" ? req.query.query.trim() : "";
  const notes = query ? await vaultRepo.searchNotes(query, 50) : await vaultRepo.listNotes();
  res.json({ notes });
});

app.get("/api/system/vault/note", validateApiKey, async (req: any, res: any) => {
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

app.post("/api/system/vault/note", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "vault.write")) {
    return res.status(403).json({ error: 'Missing capability grant "vault.write"' });
  }
  const { path: notePath, content } = req.body || {};
  if (typeof notePath !== "string" || !notePath.trim() || typeof content !== "string") {
    return res.status(400).json({ error: "Both 'path' (non-empty string) and 'content' (string) are required." });
  }
  try {
    const result = await obsidian.createNote(notePath, content);
    obsidian.syncNoteToIndex(result.path).catch((err: any) => {
      observation.logTelemetry("warn", "Interaction", `Failed to sync dashboard-written note "${result.path}" to index: ${err.message}`);
    });
    observation.logAuditEvent(req.username, "vault_note_written_via_dashboard", "success", result.path);
    res.json(result);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});
```

Note the write route's call to `syncNoteToIndex` is fire-and-forget (`.catch(...)`, not `await`ed) intentionally for the *response* — but Task 3's frontend re-fetches the notes list right after a successful save anyway, so in practice add a short delay is not needed; the existing pattern elsewhere in this codebase (e.g. `obsidian.writeOrUpdateCodingNote(...).catch(...)` in the build-request approve route) already treats vault writes as best-effort side effects that shouldn't block or fail the primary response. If the frontend's immediate re-fetch in Task 3 turns out to race the async sync in manual testing (the list not yet reflecting the edit), `await` it directly instead — it's a fast local Postgres write, not a slow external call, so awaiting it is cheap and removes the race entirely. Prefer awaiting it directly rather than the fire-and-forget pattern, since immediacy after a dashboard save is the entire point of this helper's existence (see spec's Architecture section) — use:

```typescript
    const result = await obsidian.createNote(notePath, content);
    try {
      await obsidian.syncNoteToIndex(result.path);
    } catch (err: any) {
      observation.logTelemetry("warn", "Interaction", `Failed to sync dashboard-written note "${result.path}" to index: ${err.message}`);
    }
    observation.logAuditEvent(req.username, "vault_note_written_via_dashboard", "success", result.path);
    res.json(result);
```

Use this awaited version, not the fire-and-forget one shown first — it's included above only to show why the awaited version is correct.

- [ ] **Step 2: Run the full test suite and typecheck**

Run: `npm test`
Expected: same pass count as after Task 1, no new failures (no new automated tests are added in this task — these routes are verified manually in Step 3, matching how every other admin route touching a live filesystem/DB resource in this codebase is verified, per the spec's Testing section).

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manually verify the three routes against a real running instance**

This requires `OBSIDIAN_VAULT_DIR` configured and the stack running (`docker compose up -d`). Using the `INTERNAL_API_KEY` from `.env`:

```bash
# List all notes
curl -s -H "x-api-key: $INTERNAL_API_KEY" "http://localhost:3000/api/system/vault/notes"

# Search
curl -s -H "x-api-key: $INTERNAL_API_KEY" "http://localhost:3000/api/system/vault/notes?query=test"

# Write a new note
curl -s -X POST -H "x-api-key: $INTERNAL_API_KEY" -H "Content-Type: application/json" \
  -d '{"path":"dashboard-test-note","content":"# Hello\n\nWritten from the dashboard route test."}' \
  "http://localhost:3000/api/system/vault/note"

# Read it back — confirm content matches and it now appears in the list/search above
curl -s -H "x-api-key: $INTERNAL_API_KEY" "http://localhost:3000/api/system/vault/note?path=dashboard-test-note.md"
curl -s -H "x-api-key: $INTERNAL_API_KEY" "http://localhost:3000/api/system/vault/notes" | grep dashboard-test-note
```

Expected: the write returns `{"path":"dashboard-test-note","bytesWritten":N}`; the read-back returns the same content; the note appears in the full list immediately (not after waiting for the next 15-minute sync tick) — this is what proves the awaited `syncNoteToIndex` call in Step 1 actually works.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat: add vault browse/search/write admin routes"
```

---

### Task 3: Add the "Vault" dashboard panel to `index.html`

**Files:**
- Modify: `src/interaction/static/index.html`

**Interfaces:**
- Consumes: the three routes from Task 2 (`GET /api/system/vault/notes`, `GET /api/system/vault/note`, `POST /api/system/vault/note`); existing frontend helpers `authFetch`, `escapeHtml`, `addNotification`, `CURRENT_API_KEY`, `switchTab`.
- Produces: a `view-vault` pane, a `nav-vault` nav button, and JS functions `loadVaultNotes(query)`, `openVaultNote(path)`, `saveVaultNote()`, `startNewVaultNote()` — no other task depends on these; this is the final task in this plan.

- [ ] **Step 1: Add the nav entry**

In `src/interaction/static/index.html`, add a new nav button right after the existing "Projects" button (find it via `grep -n "switchTab('projects')" src/interaction/static/index.html`):

```html
            <button onclick="switchTab('vault')" id="nav-vault" class="nav-btn group flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 text-secondary hover:text-white hover:bg-white/5 border border-transparent">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s4.332.477 5.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.746 0 3.332.477 4.5 1.253v13C19.832 18.477 18.246 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                </svg>
                <span class="text-sm font-medium">Vault</span>
            </button>
```

- [ ] **Step 2: Add the view pane**

Add this pane right after the existing `<div id="view-projects" ...>` pane closes (find its closing `</div>` via `grep -n "view-projects\"" src/interaction/static/index.html` and locate the matching close):

```html
            <!-- ================= VAULT: browse, search, and edit the real Obsidian vault ================= -->
            <div id="view-vault" class="view-pane hidden space-y-6">
                <div class="pb-2">
                    <h2 class="font-display font-semibold text-lg text-white">Vault</h2>
                    <p class="text-sm text-secondary mt-1 max-w-xl">Your real Obsidian vault — browse, search, and edit notes directly. Changes here write straight to disk, same as editing in Obsidian itself.</p>
                </div>
                <div class="grid grid-cols-1 lg:grid-cols-3 gap-5">
                    <div class="holo-panel rounded-2xl p-5 lg:col-span-1 flex flex-col h-[560px]">
                        <div class="flex items-center gap-2 mb-3">
                            <input type="text" id="vault-search-input" placeholder="Search notes or tags..." class="flex-1 bg-white/[0.03] border border-white/10 focus:border-primary/40 rounded-lg px-3 py-1.5 text-sm text-white placeholder-secondary/50 focus:outline-none transition-all" onkeypress="if(event.key === 'Enter') loadVaultNotes(this.value)">
                            <button onclick="startNewVaultNote()" class="px-2.5 py-1.5 rounded-lg border border-white/10 text-xs text-secondary hover:text-white hover:border-white/20 transition-all whitespace-nowrap">+ New</button>
                        </div>
                        <div id="vault-notes-list" class="flex-1 overflow-y-auto space-y-1.5 pr-1">
                            <div class="text-secondary text-center w-full py-6 text-xs uppercase tracking-widest font-mono opacity-50">Loading...</div>
                        </div>
                    </div>
                    <div class="holo-panel rounded-2xl p-5 lg:col-span-2 flex flex-col h-[560px]">
                        <div class="flex items-center justify-between mb-2">
                            <input type="text" id="vault-note-path-input" placeholder="path/within-vault (no .md needed)" class="flex-1 bg-white/[0.03] border border-white/10 focus:border-primary/40 rounded-lg px-3 py-1.5 text-sm text-white placeholder-secondary/50 focus:outline-none transition-all mr-2">
                            <button onclick="saveVaultNote()" class="px-3 py-1.5 rounded-lg border border-success/25 text-success bg-success/5 text-xs font-mono font-bold uppercase tracking-widest hover:bg-success/10 whitespace-nowrap">Save</button>
                        </div>
                        <div id="vault-note-tags" class="flex flex-wrap gap-1.5 mb-2"></div>
                        <textarea id="vault-note-content" placeholder="Select a note, or click + New to start one..." class="flex-1 w-full bg-white/[0.03] border border-white/10 focus:border-primary/40 rounded-lg px-3 py-2.5 text-sm text-white placeholder-secondary/50 focus:outline-none transition-all font-mono resize-none"></textarea>
                        <div id="vault-note-backlinks" class="mt-2.5 text-xs text-secondary"></div>
                    </div>
                </div>
            </div>
```

- [ ] **Step 3: Wire `switchTab` to load the list on entry**

In `switchTab` (found via `grep -n "if (tabId === 'calendar')" src/interaction/static/index.html`), add one line next to the other tab-entry loaders:

```javascript
        if (tabId === 'vault') loadVaultNotes();
```

- [ ] **Step 4: Add the JS functions**

Add these functions right after `rejectBuildRequest` (find it via `grep -n "async function rejectBuildRequest" src/interaction/static/index.html` — insert after that function's closing `}`):

```javascript
    let currentVaultNotePath = null;

    async function loadVaultNotes(query) {
        if (!CURRENT_API_KEY) return;
        const list = document.getElementById('vault-notes-list');
        try {
            const q = query ? `?query=${encodeURIComponent(query)}` : '';
            const res = await authFetch(`/api/system/vault/notes${q}`, { headers: { 'X-API-Key': CURRENT_API_KEY } });
            if (!res.ok) { list.innerHTML = `<div class="text-secondary text-center w-full py-6 text-xs opacity-60">Couldn't load the vault.</div>`; return; }
            const data = await res.json();
            const notes = data.notes || [];
            if (notes.length === 0) {
                list.innerHTML = `<div class="text-secondary text-center w-full py-6 text-xs uppercase tracking-widest font-mono opacity-50">No notes found.</div>`;
                return;
            }
            list.innerHTML = notes.map(n => `
                <button onclick="openVaultNote('${encodeURIComponent(n.path)}')" class="w-full text-left holo-chip border border-white/10 rounded-lg p-2.5 hover:border-white/20 transition-all block">
                    <div class="text-xs text-white font-medium truncate">${escapeHtml(n.title)}</div>
                    <div class="text-[10px] text-secondary/70 font-mono mt-0.5 truncate">${escapeHtml(n.path)}</div>
                    ${n.tags && n.tags.length > 0 ? `<div class="text-[9px] text-primary/80 mt-1">${n.tags.map(t => `#${escapeHtml(t)}`).join(' ')}</div>` : ''}
                </button>
            `).join('');
        } catch {
            list.innerHTML = `<div class="text-secondary text-center w-full py-6 text-xs opacity-60">Couldn't reach the vault.</div>`;
        }
    }

    async function openVaultNote(encodedPath) {
        if (!CURRENT_API_KEY) return;
        const path = decodeURIComponent(encodedPath);
        try {
            const res = await authFetch(`/api/system/vault/note?path=${encodeURIComponent(path)}`, { headers: { 'X-API-Key': CURRENT_API_KEY } });
            if (!res.ok) { addNotification("Couldn't open that note.", "danger"); return; }
            const data = await res.json();
            currentVaultNotePath = path;
            document.getElementById('vault-note-path-input').value = path;
            document.getElementById('vault-note-content').value = data.content || '';
            document.getElementById('vault-note-tags').innerHTML = (data.tags || []).map(t => `<span class="px-1.5 py-0.5 rounded border border-primary/25 text-primary bg-primary/5 text-[9px] font-mono">#${escapeHtml(t)}</span>`).join('');
            const backlinks = data.backlinks || [];
            document.getElementById('vault-note-backlinks').innerHTML = backlinks.length > 0
                ? `Linked from: ${backlinks.map(b => escapeHtml(b.from_path)).join(', ')}`
                : '';
        } catch {
            addNotification("Couldn't reach the vault.", "danger");
        }
    }

    function startNewVaultNote() {
        currentVaultNotePath = null;
        document.getElementById('vault-note-path-input').value = '';
        document.getElementById('vault-note-content').value = '';
        document.getElementById('vault-note-tags').innerHTML = '';
        document.getElementById('vault-note-backlinks').innerHTML = '';
        document.getElementById('vault-note-path-input').focus();
    }

    async function saveVaultNote() {
        if (!CURRENT_API_KEY) return;
        const path = document.getElementById('vault-note-path-input').value.trim();
        const content = document.getElementById('vault-note-content').value;
        if (!path) { addNotification("Enter a path for this note first.", "warning"); return; }
        try {
            const res = await authFetch('/api/system/vault/note', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-API-Key': CURRENT_API_KEY },
                body: JSON.stringify({ path, content })
            });
            if (res.ok) {
                addNotification("Note saved.", "success");
                currentVaultNotePath = path;
                loadVaultNotes(document.getElementById('vault-search-input').value.trim());
            } else {
                const data = await res.json().catch(() => ({}));
                addNotification(`Save failed: ${data.error || res.statusText}`, "danger");
            }
        } catch {
            addNotification("Save request failed.", "danger");
        }
    }
```

Note `openVaultNote` takes an already-`encodeURIComponent`-encoded path (the caller in `loadVaultNotes` encodes it before embedding it in the `onclick` attribute, since a raw path containing `'` or `"` would otherwise break the inline handler) and decodes it back before use — this is the standard pattern for passing arbitrary strings through an inline `onclick` in this file; if you find an existing helper elsewhere in `index.html` for this exact purpose (check with `grep -n "decodeURIComponent" src/interaction/static/index.html`), reuse it instead of introducing a second parallel pattern.

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npm test`
Expected: same pass count as after Task 2 (this task adds no automated tests — frontend HTML/JS in this codebase has no existing test harness; verified manually in Step 6, matching how the "Projects" panel this mirrors was itself verified).

Run: `npx tsc --noEmit`
Expected: no errors (this task touches no `.ts` file, but running it confirms Tasks 1-2 are still clean).

- [ ] **Step 6: Manually verify in a browser**

With the stack running and `OBSIDIAN_VAULT_DIR` configured against a real vault:
1. Load the dashboard, click "Vault" in the left nav — confirm the note list populates (or shows "No notes found" on an empty vault).
2. Type a search term and press Enter — confirm the list filters.
3. Click a note — confirm its content, tags, and backlinks (if any) appear in the detail pane.
4. Edit the content and click "Save" — confirm a success toast appears and the list (title/tags) updates to match, without needing to wait or manually refresh.
5. Click "+ New", enter a path and some content, click "Save" — confirm the new note appears in the list immediately and can be reopened.
6. Open the real vault directly in the Obsidian app (or `docker exec` and `cat` the file) — confirm the dashboard-authored note is a real file on disk with the exact content saved.

- [ ] **Step 7: Commit**

```bash
git add src/interaction/static/index.html
git commit -m "feat: add a Vault dashboard panel — browse, search, inline edit"
```

---

## Final Verification

- `npm test` — full suite green, no regressions from before this plan.
- `npx tsc --noEmit` — no errors.
- All of Task 2 Step 3 and Task 3 Step 6's manual checks pass against a real running stack with a real configured vault.
