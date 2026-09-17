# Retire `feature_requests`, Surface Build Requests in the Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the redundant `queue_feature_request` tool (which explicitly hands new-capability requests to "a real human developer"), and replace the dashboard's "Projects" panel with a real view of the `build_requests` pipeline that already drafts real code and opens PRs — including Approve/Reject actions wired to the existing, already-working admin routes.

**Architecture:** Task 1 removes the now-redundant tool (system prompt paragraph, tool declaration, permission map entry, `executeTool` case, the now-dead `featureRequestsRepo` import). Task 2 replaces the "Projects" panel's HTML and JS in `src/interaction/static/index.html` with a build-requests view backed by the existing `GET /api/system/build-requests` / `POST .../approve-code` / `POST .../reject-code` routes — no backend changes in Task 2 at all.

**Tech Stack:** TypeScript (Task 1), vanilla HTML/JS matching this dashboard's existing Tailwind-class conventions (Task 2, no build step — served directly).

## Global Constraints

- **No change to `AutonomousExecutive`, `departments.ts`, or any build-requests backend route.** Both admin routes this plan's UI calls already exist and are already correct — this plan only adds a caller.
- **`feature-requests-repo.ts`, the `feature_requests` table, and `GET /api/feature-requests` are left completely alone** — no migration, no deletion. They simply stop being written to once `queue_feature_request` is removed.
- **No dead imports** — when `featureRequestsRepo`'s only remaining use is removed in Task 1, its import must be removed too.

---

### Task 1: Remove `queue_feature_request`

**Files:**
- Modify: `src/server.ts` (system prompt paragraph)
- Modify: `src/capabilities/tools.ts` (tool declaration, permission map, `executeTool` case, import)
- Test: `tests/index.test.ts` (verification only — confirmed via grep that no existing test references this tool, so no test changes are expected)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new — this task only removes exports/behavior. No other file in the codebase references `queue_feature_request` or `featureRequestsRepo.addFeatureRequest` after this task (verify in Step 5).

- [ ] **Step 1: Update the system prompt**

In `src/server.ts`, find:

```ts
      + "\n\nIf the user asks for something you have no tool for, don't just decline or invent a fake result. Use search_web to research whether/how it could genuinely be built, then present a concrete, honest plan in conversation — what it would do, roughly how. Only after the user clearly approves building it, call queue_feature_request to hand it to a real human developer; you never write or execute code yourself. If they don't approve, or you're just discussing the idea, don't queue anything."
```

Replace with:

```ts
      + "\n\nIf the user asks for something you have no tool for, don't just decline or invent a fake result. Use search_web to research whether/how it could genuinely be built, then present a concrete, honest plan in conversation — what it would do, roughly how. If they clearly approve building it, that's enough — the executive planner will pick up the objective on its own, research it properly, and come back to consult on direction before anything gets built. Don't invent a special tool call for this; just proceed with the normal planning flow. If they don't approve, or you're just discussing the idea, don't start anything."
```

- [ ] **Step 2: Remove the tool declaration**

In `src/capabilities/tools.ts`, find the full `queue_feature_request` entry in `TOOL_DECLARATIONS`:

```ts
  {
    name: "queue_feature_request",
    description:
      "Queue a request for a genuinely new capability to be built by a human developer — use this ONLY after the user has explicitly approved building something you don't currently have a tool for (research it with search_web first, present a concrete plan, and wait for clear approval before calling this). You never write or execute code yourself; this hands the approved request to a real, reviewed development process.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: "Short title for the requested capability" },
        description: { type: Type.STRING, description: "What the user actually wants this to do, in their own words/intent" },
        plan: { type: Type.STRING, description: "The concrete plan you researched and the user approved — what would need to be built, roughly how" },
      },
      required: ["title", "description", "plan"],
    },
  },
```

Delete this entire object from the `TOOL_DECLARATIONS` array (the `{` immediately before `get_security_status`'s entry follows directly after — leave that entry and everything else untouched).

- [ ] **Step 3: Remove the permission map entry**

Find:

```ts
  queue_feature_request: "feature.propose",
```

Delete this line from the tool-to-permission map.

- [ ] **Step 4: Remove the `executeTool` case and the now-dead import**

Find:

```ts
      case "queue_feature_request": {
        const queued = await featureRequestsRepo.addFeatureRequest(
          args.title, args.description, null, args.plan, username
        );
        observation.logAuditEvent(username, "feature_request_queued", "success", `"${args.title}" (id ${queued.id})`);
        output = { id: queued.id, status: queued.status };
        break;
      }
```

Delete this entire case block (leave the surrounding `case "get_security_status": {` and its neighbor untouched).

Then find:

```ts
import * as featureRequestsRepo from "../kernel/state/feature-requests-repo.js";
```

Delete this line — it's this file's only use of `featureRequestsRepo` (confirm with the grep in Step 5), so removing the case leaves it dead.

- [ ] **Step 5: Verify no other reference remains**

Run: `grep -rn "queue_feature_request\|feature\.propose\|featureRequestsRepo" src/ tests/`
Expected: zero results in `src/capabilities/tools.ts` and `src/server.ts` for these three strings. (`src/kernel/state/feature-requests-repo.ts` itself and any admin route still reading `GET /api/feature-requests` are untouched by this plan and may still legitimately reference `featureRequestsRepo` from `server.ts` if such a route exists — check `src/server.ts` for a surviving `app.get("/api/feature-requests"` route; if present, it's out of scope for this plan and must be left exactly as-is.)

- [ ] **Step 6: Run tsc and the test suite**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test`
Expected: all existing tests pass, same count as before this task (no test in this codebase currently exercises `queue_feature_request`, confirmed via `grep -n "queue_feature_request" tests/index.test.ts` returning nothing before this task began).

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/capabilities/tools.ts
git commit -m "refactor: remove queue_feature_request in favor of the build_requests pipeline"
```

---

### Task 2: Replace the "Projects" panel with a real build-requests view

**Files:**
- Modify: `src/interaction/static/index.html`

**Interfaces:**
- Consumes: `GET /api/system/build-requests` (returns `{ buildRequests: BuildRequestRow[] }`, each row has `id`, `objective`, `status` — one of `researching`/`awaiting_consult`/`direction_confirmed`/`coding`/`awaiting_code_approval`/`pr_opened`/`qa_complete`/`rejected_at_code`/`error` — `research_summary`, `direction_notes`, `code_summary`, `qa_summary`, `pr_url`, `created_at`, all already defined in `src/kernel/state/build-requests-repo.ts`); `POST /api/system/build-requests/:id/approve-code` and `POST /api/system/build-requests/:id/reject-code` (both take no request body, just the id in the URL, both already implemented and reviewed).
- Consumes existing page-level helpers: `authFetch`, `escapeHtml`, `addNotification`, `CURRENT_API_KEY` (all already defined elsewhere in this file, used the same way the panel being replaced already used them).
- Produces: no new exports — this is a single static HTML file with inline `<script>`, no module system.

- [ ] **Step 1: Replace the panel's HTML**

Find:

```html
            <!-- ================= SUB-PANEL 3: WORKING MEMORY CELLS ================= -->
            <!-- ================= PROJECTS: capability requests — the bridge from "asked Jarvis for it" to "actually built" ================= -->
            <div id="view-projects" class="view-pane hidden space-y-6">
                <div class="pb-2">
                    <h2 class="font-display font-semibold text-lg text-white">Projects</h2>
                    <p class="text-sm text-secondary mt-1 max-w-xl">When you ask Jarvis for something it can't yet do, it researches, proposes a plan, and — only with your approval — queues it here for a real developer to build. Jarvis never writes or runs code itself.</p>
                </div>
                <div class="holo-panel rounded-2xl p-5 w-full">
                    <div class="flex justify-between items-center mb-4">
                        <h3 class="font-display font-semibold text-sm text-white">Queued</h3>
                        <span id="feature-requests-count-badge" class="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[11px] text-secondary">0 queued</span>
                    </div>
                    <div id="feature-requests-list" class="space-y-2.5">
                        <div class="text-secondary text-center w-full py-6 text-sm opacity-60">Nothing queued yet — ask Jarvis for something new and approve its plan to see it here.</div>
                    </div>
                </div>
            </div>
```

Replace with:

```html
            <!-- ================= SUB-PANEL 3: WORKING MEMORY CELLS ================= -->
            <!-- ================= PROJECTS: build requests — the bridge from "asked Jarvis for it" to "actually built" ================= -->
            <div id="view-projects" class="view-pane hidden space-y-6">
                <div class="pb-2">
                    <h2 class="font-display font-semibold text-lg text-white">Projects</h2>
                    <p class="text-sm text-secondary mt-1 max-w-xl">When you ask Jarvis for something it can't yet do, it researches the idea, talks through direction with you, and — once you confirm — drafts real code and opens a pull request for your review.</p>
                </div>
                <div class="holo-panel rounded-2xl p-5 w-full">
                    <div class="flex justify-between items-center mb-4">
                        <h3 class="font-display font-semibold text-sm text-white">Build Requests</h3>
                        <span id="build-requests-count-badge" class="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[11px] text-secondary">0 active</span>
                    </div>
                    <div id="build-requests-list" class="space-y-2.5">
                        <div class="text-secondary text-center w-full py-6 text-sm opacity-60">Nothing yet — ask Jarvis to build something new to see it here.</div>
                    </div>
                </div>
            </div>
```

- [ ] **Step 2: Replace the JS status map and loader, add the two action functions**

Find:

```js
    const FEATURE_REQUEST_STATUS_STYLE = {
        queued: { label: 'QUEUED', classes: 'border-warning/25 text-warning bg-warning/5' },
        in_progress: { label: 'IN PROGRESS', classes: 'border-primary/25 text-primary bg-primary/5' },
        shipped: { label: 'SHIPPED', classes: 'border-success/25 text-success bg-success/5' },
        declined: { label: 'DECLINED', classes: 'border-secondary/25 text-secondary bg-secondary/5' },
    };

    async function loadFeatureRequests() {
        if (!CURRENT_API_KEY) return; // not logged in yet — nothing to poll for
        try {
            const headers = { 'X-API-Key': CURRENT_API_KEY };
            const res = await authFetch('/api/feature-requests', { headers });
            if (!res.ok) return;
            const data = await res.json();
            const requests = data.requests || [];

            const activeCount = requests.filter(r => r.status === 'queued' || r.status === 'in_progress').length;
            document.getElementById('feature-requests-count-badge').textContent = `${activeCount} QUEUED`;

            const list = document.getElementById('feature-requests-list');
            if (requests.length === 0) {
                list.innerHTML = `<div class="text-secondary text-center w-full py-6 text-xs uppercase tracking-widest font-mono opacity-50">Nothing queued yet — ask Jarvis for something new and approve its plan to see it here.</div>`;
                return;
            }
            list.innerHTML = requests.map(r => {
                const style = FEATURE_REQUEST_STATUS_STYLE[r.status] || FEATURE_REQUEST_STATUS_STYLE.queued;
                return `
                    <div class="holo-chip border ${style.classes.split(' ')[0]} rounded-xl p-3.5">
                        <div class="flex items-center justify-between mb-1.5">
                            <span class="font-display font-bold text-xs text-white">${escapeHtml(r.title)}</span>
                            <span class="px-1.5 py-0.5 rounded border text-[8px] font-mono font-bold tracking-widest uppercase whitespace-nowrap ${style.classes}">${style.label}</span>
                        </div>
                        <p class="text-[11px] text-text/80 leading-snug mb-1.5">${escapeHtml(r.description)}</p>
                        ${r.proposed_plan ? `<p class="text-[10px] text-secondary font-mono leading-snug border-t border-white/5 pt-1.5">${escapeHtml(r.proposed_plan)}</p>` : ''}
                        <span class="text-[8px] text-secondary font-mono mt-1.5 block">${new Date(r.created_at).toLocaleString()}</span>
                    </div>
                `;
            }).join('');
        } catch {}
    }
```

Replace with:

```js
    const BUILD_REQUEST_STATUS_STYLE = {
        researching: { label: 'RESEARCHING', classes: 'border-warning/25 text-warning bg-warning/5' },
        awaiting_consult: { label: 'AWAITING CONSULT', classes: 'border-warning/25 text-warning bg-warning/5' },
        direction_confirmed: { label: 'DIRECTION CONFIRMED', classes: 'border-primary/25 text-primary bg-primary/5' },
        coding: { label: 'CODING', classes: 'border-primary/25 text-primary bg-primary/5' },
        awaiting_code_approval: { label: 'AWAITING APPROVAL', classes: 'border-warning/25 text-warning bg-warning/5' },
        pr_opened: { label: 'PR OPENED', classes: 'border-success/25 text-success bg-success/5' },
        qa_complete: { label: 'QA COMPLETE', classes: 'border-success/25 text-success bg-success/5' },
        rejected_at_code: { label: 'REJECTED', classes: 'border-secondary/25 text-secondary bg-secondary/5' },
        error: { label: 'ERROR', classes: 'border-danger/25 text-danger bg-danger/5' },
    };
    const BUILD_REQUEST_TERMINAL_STATUSES = ['pr_opened', 'qa_complete', 'rejected_at_code', 'error'];

    async function loadBuildRequests() {
        if (!CURRENT_API_KEY) return; // not logged in yet — nothing to poll for
        try {
            const headers = { 'X-API-Key': CURRENT_API_KEY };
            const res = await authFetch('/api/system/build-requests', { headers });
            if (!res.ok) return;
            const data = await res.json();
            const requests = data.buildRequests || [];

            const activeCount = requests.filter(r => !BUILD_REQUEST_TERMINAL_STATUSES.includes(r.status)).length;
            document.getElementById('build-requests-count-badge').textContent = `${activeCount} ACTIVE`;

            const list = document.getElementById('build-requests-list');
            if (requests.length === 0) {
                list.innerHTML = `<div class="text-secondary text-center w-full py-6 text-xs uppercase tracking-widest font-mono opacity-50">Nothing yet — ask Jarvis to build something new to see it here.</div>`;
                return;
            }
            list.innerHTML = requests.map(r => {
                const style = BUILD_REQUEST_STATUS_STYLE[r.status] || BUILD_REQUEST_STATUS_STYLE.researching;
                const summary = r.qa_summary || r.code_summary || r.direction_notes || r.research_summary;
                const approveReject = r.status === 'awaiting_code_approval' ? `
                    <div class="flex gap-2 mt-2">
                        <button onclick="approveBuildRequest(${r.id})" class="flex-1 px-2 py-1 rounded border border-success/25 text-success bg-success/5 text-[10px] font-mono font-bold uppercase tracking-widest hover:bg-success/10">Approve</button>
                        <button onclick="rejectBuildRequest(${r.id})" class="flex-1 px-2 py-1 rounded border border-danger/25 text-danger bg-danger/5 text-[10px] font-mono font-bold uppercase tracking-widest hover:bg-danger/10">Reject</button>
                    </div>
                ` : '';
                const prLink = r.pr_url ? `<a href="${escapeHtml(r.pr_url)}" target="_blank" rel="noopener noreferrer" class="text-[10px] text-primary underline block mt-1.5">View pull request &rarr;</a>` : '';
                return `
                    <div class="holo-chip border ${style.classes.split(' ')[0]} rounded-xl p-3.5">
                        <div class="flex items-center justify-between mb-1.5">
                            <span class="font-display font-bold text-xs text-white">${escapeHtml(r.objective)}</span>
                            <span class="px-1.5 py-0.5 rounded border text-[8px] font-mono font-bold tracking-widest uppercase whitespace-nowrap ${style.classes}">${style.label}</span>
                        </div>
                        ${summary ? `<p class="text-[11px] text-text/80 leading-snug mb-1.5">${escapeHtml(summary.slice(0, 300))}</p>` : ''}
                        ${prLink}
                        ${approveReject}
                        <span class="text-[8px] text-secondary font-mono mt-1.5 block">${new Date(r.created_at).toLocaleString()}</span>
                    </div>
                `;
            }).join('');
        } catch {}
    }

    async function approveBuildRequest(id) {
        if (!CURRENT_API_KEY) return;
        try {
            const headers = { 'X-API-Key': CURRENT_API_KEY };
            const res = await authFetch(`/api/system/build-requests/${id}/approve-code`, { method: 'POST', headers });
            if (res.ok) {
                addNotification('Build request approved — opening pull request.', 'success');
            } else {
                const data = await res.json().catch(() => ({}));
                addNotification(`Approve failed: ${data.error || res.statusText}`, 'danger');
            }
        } catch {
            addNotification('Approve request failed.', 'danger');
        }
        loadBuildRequests();
    }

    async function rejectBuildRequest(id) {
        if (!CURRENT_API_KEY) return;
        try {
            const headers = { 'X-API-Key': CURRENT_API_KEY };
            const res = await authFetch(`/api/system/build-requests/${id}/reject-code`, { method: 'POST', headers });
            if (res.ok) {
                addNotification('Build request rejected.', 'info');
            } else {
                const data = await res.json().catch(() => ({}));
                addNotification(`Reject failed: ${data.error || res.statusText}`, 'danger');
            }
        } catch {
            addNotification('Reject request failed.', 'danger');
        }
        loadBuildRequests();
    }
```

- [ ] **Step 3: Update the three call sites that reference `loadFeatureRequests`**

Find (in the post-chat-reply refresh block):

```js
            setTimeout(loadFeatureRequests, 500);
```

Replace with:

```js
            setTimeout(loadBuildRequests, 500);
```

Find (in the initial page-load sequence):

```js
        loadFeatureRequests();
```

Replace with:

```js
        loadBuildRequests();
```

Find (in the polling-interval setup):

```js
        setInterval(loadFeatureRequests, 20000);
```

Replace with:

```js
        setInterval(loadBuildRequests, 20000);
```

- [ ] **Step 4: Verify no reference to the old names remains**

Run: `grep -n "loadFeatureRequests\|feature-requests-list\|feature-requests-count-badge\|FEATURE_REQUEST_STATUS_STYLE" src/interaction/static/index.html`
Expected: zero results.

- [ ] **Step 5: Manual verification**

Run: `npm run dev` (or restart the running dev process if already up), then in a browser, log in and open the "Projects" tab. Confirm:
- The panel renders without console errors.
- If any build requests exist (real ones from earlier chat sessions, or none — either is fine), the list either shows them with a correct status badge or shows the new empty-state message.
- If a build request is in `awaiting_code_approval` status, the Approve/Reject buttons appear and each one calls through to its route (check the Network tab for a 200 response) without needing to guess — if none happen to be in that state right now, this specific check can be deferred to real usage, since Task 1/2 add no new backend behavior to unit-test.

- [ ] **Step 6: Commit**

```bash
git add src/interaction/static/index.html
git commit -m "feat: replace the Projects panel with a real build-requests view"
```
