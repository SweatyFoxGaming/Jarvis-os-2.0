# Obsidian MOC/Frontmatter, Approval-Routing, and Container-Ownership Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three confirmed production bugs: (1) Obsidian vault notes lack MOC-linking frontmatter and never appear in the Graph View as connected nodes; (2) a real user reply confirming a pending build request ("yes", "approved") can get answered in prose by a backend with no tool access instead of actually calling `confirm_build_direction`; (3) the main `api` container runs as root, so every file Jarvis writes into the bind-mounted Obsidian vault / jarvis-files directories lands root-owned on the host, later blocking the `ubuntu` user from modifying/deleting them (confirmed live: `Briefings/2026-07-31.md` in the real vault, and most of `/home/ubuntu/jarvis-notes`, are root-owned right now).

**Architecture:** Two independent, testable code changes (Tasks 1-2, executed via subagent-driven development) plus one infra change with a live-host remediation step (Task 3, executed directly — it touches production container config and pre-existing root-owned host state, which needs first-hand judgment rather than a fresh subagent's).

**Tech Stack:** Node/TypeScript (Express backend), Docker/Alpine.

**Investigated and deliberately NOT fixing:** the originally-reported "stale `activeGoal` hijacking new directives" bug does not reproduce — Groq/Gemini turns send only the system prompt + current message (no replayed history), and `AutonomousExecutive` already resets goal/dialogue state at the top of each objective. The only place `activeGoal` leaks into output is the offline "Simulated" fallback engine, cosmetically. No task below touches this.

## Global Constraints

- `npx tsc --noEmit` and `npm test` must both pass after every task below, before that task's commit.
- No new capability/tool is introduced by Tasks 1-2 — both are internal behavior fixes to existing code paths.
- Task 3's Dockerfile change must not alter what packages get installed or how the image builds — it only changes which user the final running process executes as.
- The real Obsidian vault, `jarvis-notes`, and the two workspace directories described in Task 3 contain live production data — Task 3's host-side remediation (`chown`) must never delete or overwrite content, only change ownership.

---

## File Structure

| File | Change |
|---|---|
| `src/capabilities/providers/obsidian.ts` | Modify — MOC frontmatter injection, idempotent MOC wikilink append, explicit file/dir modes |
| `src/server.ts` | Modify — extend the existing tool-shaped backend-promotion and Groq fast-path guards to also fire when a build request is genuinely awaiting this user's confirmation |
| `tests/index.test.ts` | Modify — new tests for both of the above |
| `Dockerfile` | Modify — drop root privileges for the running process (Task 3, done directly, not via SDD) |

---

### Task 1: Obsidian provider — MOC frontmatter + auto-linking + explicit file modes

**Files:**
- Modify: `src/capabilities/providers/obsidian.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no new exported functions — `writeResearchNote`, `writeOrUpdateCodingNote`, `appendReflectionEntry`, `appendBriefingEntry` keep their existing signatures; their behavior widens (frontmatter + MOC linking + file modes), all internal.

- [ ] **Step 1: Write the failing tests**

Add to `tests/index.test.ts`, in the existing `"Obsidian"` test group (search for `registerTest("Obsidian"` — there is exactly one existing test there, `"scoped create/read/list stay within the vault, and traversal + symlink escapes are rejected"`; place these three new ones directly after it, in its own file). That existing test does NOT use static top-level imports for `fs`/`path`/`os`/the obsidian provider module — it dynamically imports all of them INSIDE the test body (`const os = await import("os"); const path = await import("path"); const fsSync = await import("fs"); ... const obsidian = await import("../src/capabilities/providers/obsidian.js");`), because `getRoot()` reads `process.env.OBSIDIAN_VAULT_DIR_MOUNT` fresh on every call, so the module doesn't need re-importing, just the env var set before calling it. Match that exact pattern — do NOT add a static top-level import of the obsidian module or of `fs`/`path`/`os`:

```ts
registerTest("Obsidian", "writeResearchNote injects Category/Date frontmatter and links the note into Research MOC.md", async () => {
  const os = await import("os");
  const path = await import("path");
  const fsSync = await import("fs");
  const tmpVault = fsSync.mkdtempSync(path.join(os.tmpdir(), "obsidian-moc-test-"));
  const obsidian = await import("../src/capabilities/providers/obsidian.js");
  process.env.OBSIDIAN_VAULT_DIR_MOUNT = tmpVault;
  try {
    await obsidian.writeResearchNote(555001, "Test MOC objective", "A research summary.");
    const notes = await obsidian.listAllNotePaths();
    const notePath = notes.find(p => p.startsWith("Research/") && p.includes("br555001"));
    if (!notePath) throw new Error(`Obsidian: expected a Research/*br555001* note, got: ${JSON.stringify(notes)}`);
    const raw = await obsidian.readNote(notePath);
    if (!/Category:\s*\[\[Research MOC\]\]/.test(raw)) {
      throw new Error(`Obsidian: expected a Category: [[Research MOC]] frontmatter line, got:\n${raw}`);
    }
    if (!/Date:/.test(raw)) {
      throw new Error(`Obsidian: expected a Date: frontmatter line, got:\n${raw}`);
    }
    const mocRaw = await obsidian.readNote("Research MOC.md");
    const noteBasename = notePath.replace(/^Research\//, "").replace(/\.md$/, "");
    if (!mocRaw.includes(`[[Research/${noteBasename}]]`)) {
      throw new Error(`Obsidian: expected Research MOC.md to link [[Research/${noteBasename}]], got:\n${mocRaw}`);
    }
  } finally {
    delete process.env.OBSIDIAN_VAULT_DIR_MOUNT;
    fsSync.rmSync(tmpVault, { recursive: true, force: true });
  }
});

registerTest("Obsidian", "writeOrUpdateCodingNote does not duplicate its MOC link when called twice for the same build request", async () => {
  const os = await import("os");
  const path = await import("path");
  const fsSync = await import("fs");
  const tmpVault = fsSync.mkdtempSync(path.join(os.tmpdir(), "obsidian-moc-test-"));
  const obsidian = await import("../src/capabilities/providers/obsidian.js");
  process.env.OBSIDIAN_VAULT_DIR_MOUNT = tmpVault;
  try {
    await obsidian.writeOrUpdateCodingNote(555002, "Test dup-link objective", { status: "coding" });
    await obsidian.writeOrUpdateCodingNote(555002, "Test dup-link objective", { status: "qa_complete", codeSummary: "Did the thing." });
    const mocRaw = await obsidian.readNote("Coding MOC.md");
    const notes = await obsidian.listAllNotePaths();
    const notePath = notes.find(p => p.startsWith("Coding/") && p.includes("br555002"));
    if (!notePath) throw new Error("Obsidian: expected a Coding/*br555002* note to exist");
    const noteBasename = notePath.replace(/^Coding\//, "").replace(/\.md$/, "");
    const link = `[[Coding/${noteBasename}]]`;
    const occurrences = mocRaw.split(link).length - 1;
    if (occurrences !== 1) {
      throw new Error(`Obsidian: expected exactly one ${link} in Coding MOC.md after 2 writes, found ${occurrences}. Content:\n${mocRaw}`);
    }
  } finally {
    delete process.env.OBSIDIAN_VAULT_DIR_MOUNT;
    fsSync.rmSync(tmpVault, { recursive: true, force: true });
  }
});

registerTest("Obsidian", "appendReflectionEntry creates its daily note with MOC frontmatter and links it into Reflections MOC.md exactly once per day", async () => {
  const os = await import("os");
  const path = await import("path");
  const fsSync = await import("fs");
  const tmpVault = fsSync.mkdtempSync(path.join(os.tmpdir(), "obsidian-moc-test-"));
  const obsidian = await import("../src/capabilities/providers/obsidian.js");
  process.env.OBSIDIAN_VAULT_DIR_MOUNT = tmpVault;
  try {
    await obsidian.appendReflectionEntry("test-category", "First entry.");
    await obsidian.appendReflectionEntry("test-category", "Second entry, same day.");
    const today = new Date().toISOString().slice(0, 10);
    const raw = await obsidian.readNote(`Reflections/${today}`);
    if (!/Category:\s*\[\[Reflections MOC\]\]/.test(raw)) {
      throw new Error(`Obsidian: expected a Category: [[Reflections MOC]] frontmatter line on the daily note, got:\n${raw}`);
    }
    if (!raw.includes("First entry.") || !raw.includes("Second entry, same day.")) {
      throw new Error(`Obsidian: expected both appended entries in the same daily note, got:\n${raw}`);
    }
    const mocRaw = await obsidian.readNote("Reflections MOC.md");
    const link = `[[Reflections/${today}]]`;
    const occurrences = mocRaw.split(link).length - 1;
    if (occurrences !== 1) {
      throw new Error(`Obsidian: expected exactly one ${link} in Reflections MOC.md after 2 appends same day, found ${occurrences}`);
    }
  } finally {
    delete process.env.OBSIDIAN_VAULT_DIR_MOUNT;
    fsSync.rmSync(tmpVault, { recursive: true, force: true });
  }
});
```

Note: unlike the existing symlink-escape test (which sets `OBSIDIAN_VAULT_DIR_MOUNT` BEFORE the dynamic `import(...)` call), the order in the code above sets it AFTER — that's fine either way per the existing test's own comment ("`getRoot()` reads `process.env.OBSIDIAN_VAULT_DIR_MOUNT` fresh on every call, so setting it above is enough — no need to re-import the module"), but for consistency with the existing test's exact ordering, set `process.env.OBSIDIAN_VAULT_DIR_MOUNT = tmpVault;` BEFORE the `const obsidian = await import(...)` line in all three new tests (harmless either way, but match the established convention).

- [ ] **Step 2: Run to verify they fail**

Run: `npm test 2>&1 | grep -E "Obsidian|FAILED"`
Expected: FAIL — no `Category: [[...]]` frontmatter is written yet, and no `*.MOC.md` files are ever created.

- [ ] **Step 3: Write the implementation**

In `src/capabilities/providers/obsidian.ts`, add near the top (after the existing imports, before `getRoot`):

```ts
const MOC_FOLDERS = ["Briefings", "Coding", "Reflections", "Research"] as const;
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
function withMocFrontmatter(folder: MocFolder, frontmatter: Record<string, any> = {}): Record<string, any> {
  const today = new Date().toISOString().slice(0, 10);
  return { Category: `[[${folder} MOC]]`, Date: `[[${today}]]`, ...frontmatter };
}

// Ensures `${folder} MOC.md` exists and contains a bulleted wikilink to
// `linkTarget` (e.g. "Coding/my-objective-br42") — idempotent, since
// writeOrUpdateCodingNote rewrites the same note multiple times across a
// build request's life (direction confirmed, PR opened, QA complete) and
// must not accumulate duplicate links on repeated calls, and
// appendReflectionEntry/appendBriefingEntry call this once per entry
// against the same daily note.
async function ensureLinkedInMoc(folder: MocFolder, linkTarget: string): Promise<void> {
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
}
```

Change `createNote`'s and `appendToNote`'s file-write calls to set explicit modes — in `createNote`, change:
```ts
  await fs.mkdir(path.dirname(target), { recursive: true });
  const full = frontmatter && Object.keys(frontmatter).length > 0
    ? `---\n${dumpYaml(frontmatter)}---\n\n${content}`
    : content;
  await fs.writeFile(target, full, "utf-8");
```
to:
```ts
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o775 });
  const full = frontmatter && Object.keys(frontmatter).length > 0
    ? `---\n${dumpYaml(frontmatter)}---\n\n${content}`
    : content;
  await fs.writeFile(target, full, { encoding: "utf-8", mode: 0o664 });
```

Widen `appendToNote`'s options to accept frontmatter for the create-if-missing path (needed by `appendReflectionEntry`/`appendBriefingEntry` below, which create a fresh daily note the first time each day and must give IT frontmatter too, but only on that first creation — later same-day appends must not re-wrap the whole file). Change:
```ts
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
    // Same ordering fix as createNote: check the pre-existing filesystem
    // state before mkdir -p can create anything through a symlink.
    await assertRealPathWithinRoot(target);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf-8");
  } else {
    await assertRealPathWithinRoot(target);
    await fs.appendFile(target, content, "utf-8");
  }
  observation.logTelemetry("info", "Interaction", `Appended to vault note "${relativePath}"`);
  return { path: relativePath, bytesWritten: Buffer.byteLength(content) };
}
```
to:
```ts
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
  } else {
    await assertRealPathWithinRoot(target);
    await fs.appendFile(target, content, "utf-8");
  }
  observation.logTelemetry("info", "Interaction", `Appended to vault note "${relativePath}"`);
  return { path: relativePath, bytesWritten: Buffer.byteLength(content) };
}
```

Finally, wire MOC frontmatter + linking into all four higher-level writers. In `writeResearchNote`, change the `createNote` call from:
```ts
  await createNote(
    `Research/${basename}`,
    `# ${objective}\n\n${summary}\n`,
    { type: "research", build_request_id: buildRequestId, created: new Date().toISOString() }
  );
```
to:
```ts
  await createNote(
    `Research/${basename}`,
    `# ${objective}\n\n${summary}\n`,
    withMocFrontmatter("Research", { type: "research", build_request_id: buildRequestId, created: new Date().toISOString() })
  );
  await ensureLinkedInMoc("Research", `Research/${basename}`);
```

In `writeOrUpdateCodingNote`, change the `createNote` call from:
```ts
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
```
to:
```ts
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
```

In `appendReflectionEntry`, change the `appendToNote` call from:
```ts
  await appendToNote(
    todayNotePath("Reflections"),
    `\n## ${timestamp} — ${category}\n\n${content}\n`,
    { createIfMissing: true }
  );
```
to:
```ts
  await appendToNote(
    todayNotePath("Reflections"),
    `\n## ${timestamp} — ${category}\n\n${content}\n`,
    { createIfMissing: true, frontmatterOnCreate: withMocFrontmatter("Reflections") }
  );
  await ensureLinkedInMoc("Reflections", todayNotePath("Reflections"));
```

In `appendBriefingEntry`, change the `appendToNote` call from:
```ts
  await appendToNote(
    todayNotePath("Briefings"),
    `\n## ${timestamp} (${itemCount} item(s))\n\n${text}\n`,
    { createIfMissing: true }
  );
```
to:
```ts
  await appendToNote(
    todayNotePath("Briefings"),
    `\n## ${timestamp} (${itemCount} item(s))\n\n${text}\n`,
    { createIfMissing: true, frontmatterOnCreate: withMocFrontmatter("Briefings") }
  );
  await ensureLinkedInMoc("Briefings", todayNotePath("Briefings"));
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx tsc --noEmit && npm test 2>&1 | grep -E "Obsidian|FAILED|TOTALS"`
Expected: all 3 new `Obsidian` tests PASS, and the existing Obsidian tests (create/read round-trip, path-traversal rejection, symlink-escape rejection) still pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/capabilities/providers/obsidian.ts tests/index.test.ts
git commit -m "feat: inject MOC frontmatter and auto-link vault notes into their folder's MOC"
```

---

### Task 2: Executive routing — don't let a tool-less backend answer a pending build-request confirmation

**Files:**
- Modify: `src/server.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `buildRequestsRepo.getLatestPendingRewardGate` (already exists, added by the reward-system branch).
- Produces: nothing new exported — this widens two existing internal conditions inside the chat route handler.

- [ ] **Step 1: Write the failing test**

The two conditions being fixed live inside a large route handler in `server.ts`, not in a separately-exported function, so this is tested at the level of the two pure helper predicates it composes with (`looksToolShaped`/`looksTrivial`, already unit-tested) plus a new degrade-cleanly check on the added repo call. Add to `tests/index.test.ts`, in the existing test group that covers `looksTrivial`/`looksToolShaped` (search for where those are tested — likely near line 2150-2200):

```ts
registerTest("BuildRequests", "getLatestPendingRewardGate still degrades cleanly when composed with looksTrivial/looksToolShaped-style routing logic", async () => {
  // This isn't testing new server.ts logic directly (that lives inside an
  // Express route handler, not a unit-testable export) — it's confirming
  // the one new signal server.ts's routing fix depends on (a pending
  // reward-gate row for this user) continues to degrade to null with no
  // live Postgres, so the routing fix's `if (... || pendingRewardGate)`
  // check never throws or hangs when the DB is unreachable, matching every
  // other per-turn context lookup in that same handler
  // (getLatestAwaitingConsult already covered elsewhere).
  const result = await buildRequestsRepo.getLatestPendingRewardGate("brand_new_test_user_for_routing_check");
  if (result !== null) {
    throw new Error(`BuildRequests: expected null with no DB, got: ${JSON.stringify(result)}`);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

This test should actually already PASS as written (it's exercising existing, already-correct repo behavior) — its purpose is to lock in the precondition the routing fix below depends on, not to fail first. Run it once to confirm it passes before touching `server.ts`: `npm test 2>&1 | grep -E "reward-gate|FAILED"`.

- [ ] **Step 3: Write the implementation**

In `src/server.ts`, find where `awaitingBuildRequest` is computed (search for `getLatestAwaitingConsult(req.username)` inside the chat route handler — NOT the one inside `autonomous_executive.ts`, the one in `server.ts` that builds `buildRequestContext`). Immediately after that line, add:

```ts
    // A build request can also be genuinely awaiting this user's decision
    // in a second way: paused at the reward-confirmation gate
    // (direction_confirmed status) rather than awaiting_consult. Both cases
    // mean the next tool-shaped thing this user says ("yes", "approved",
    // "proceed") is a real confirm_build_direction call waiting to happen —
    // see the routing fix below, which needs to know about either.
    const pendingRewardGate = await buildRequestsRepo.getLatestPendingRewardGate(req.username);
```

Then find the tool-shaped backend-promotion check (search for `if (kernel.llmMode !== "strictly-local" && looksToolShaped(message))`). Change it from:
```ts
    if (kernel.llmMode !== "strictly-local" && looksToolShaped(message)) {
```
to:
```ts
    // A pending confirmation (either flavor) means the user's very next
    // reply is likely a bare "yes"/"approved"/"proceed" that keyword-based
    // looksToolShaped would never recognize as tool-shaped on its own — but
    // it needs the same treatment: promote a tool-capable backend to the
    // front instead of letting LocalLLM (no tool support at all) answer it
    // in prose before Groq/Gemini ever get a turn.
    const hasPendingConfirmation = !!awaitingBuildRequest || !!pendingRewardGate;
    if (kernel.llmMode !== "strictly-local" && (looksToolShaped(message) || hasPendingConfirmation)) {
```

Then find the Groq fast-path check (search for `const isFastPath = !looksToolShaped(message) && looksTrivial(message);`). Change it from:
```ts
            const isFastPath = !looksToolShaped(message) && looksTrivial(message);
```
to:
```ts
            // Also gated on hasPendingConfirmation (computed above, same
            // scope): a bare "yes"/"ok" is exactly the message a pending
            // confirmation is waiting for, and is also exactly what
            // looksTrivial matches — without this, the fast path would
            // strip tools from the one Groq call that most needs
            // confirm_build_direction attached.
            const isFastPath = !looksToolShaped(message) && !hasPendingConfirmation && looksTrivial(message);
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsc --noEmit && npm test 2>&1 | grep -E "reward-gate|FAILED|TOTALS"`
Expected: clean typecheck, the new test passes, no regressions (this is additive — `hasPendingConfirmation` is `false` for every existing test scenario with no build request in play, so `isFastPath`/the promotion condition behave exactly as before in all previously-tested cases).

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/index.test.ts
git commit -m "fix: don't let a tool-less backend or the trivial fast-path answer a pending build-request confirmation"
```

---

### Task 3: Main `api` container — drop root privileges (done directly, not via subagent dispatch)

**Files:**
- Modify: `Dockerfile`

This task is executed directly by the controller (not dispatched to a fresh implementer) because it requires live-host judgment: confirming the host `ubuntu` user's UID matches the container's non-root user before switching (already confirmed: both are 1000:1000), and remediating pre-existing root-owned files/directories on the live host (`.jarvis-build-workspaces`, `.jarvis-chat-workspaces`, `data/`, `src/**/__pycache__`, and root-owned files already inside the live Obsidian vault and `jarvis-notes` directories) as part of the same deploy — a fresh subagent has no access to (and shouldn't blindly `chown`/`sudo` against) production host state it can't first-hand verify.

Add `USER node` to `Dockerfile` immediately before the final `CMD`, with a comment explaining why (uid/gid 1000 matches both the image's built-in `node` account and the host's `ubuntu` account, confirmed via `id ubuntu` and `docker run --rm node:20-alpine id node`).

Before rebuilding/redeploying: `sudo chown -R ubuntu:ubuntu` the repo working tree (fixes `.jarvis-build-workspaces`, `.jarvis-chat-workspaces`, `data/`, `__pycache__` dirs — all currently root-owned, confirmed via `find /mnt/jarvis_home/llm -user root`) and separately `sudo chown -R ubuntu:ubuntu` the real Obsidian vault and `jarvis-notes` directories (both have root-owned files inside them already, confirmed via `find ... -user root`).

Build and smoke-test the new image locally (confirm the container starts healthy, can still read `node_modules`/Python packages, and can write a real note into a scratch vault dir as uid 1000) before touching the live `jarvis-os-api` container. Then follow this session's established deploy sequence: `git pull --ff-only` on the live host + `docker compose up -d --build --force-recreate api`, then verify no new root-owned files appear after a fresh write.

---
