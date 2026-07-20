# `display_content` Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jarvis can render images, code, simple charts, and web pages into a dedicated dashboard panel whenever a reply has something better shown than said — automatically, without the user having to ask.

**Architecture:** `display_content(type, title, content)` is a new tool, declared and executed exactly like every other tool in `src/execution/tools.ts` — but unlike `view_screen`, it has no client-round-trip problem: the server already has (or the model already generated) whatever it wants to show, so execution is synchronous. `executeTool` returns a `displayDirective` alongside its normal `ok`/`output`; `/api/chat` relays that as a new `display: {...}` SSE frame (parallel to the existing `detail: ` trace frame); the client renders it into a panel that's part of the existing dashboard, hidden until first used.

**Tech Stack:** TypeScript (existing `tools.ts`/`server.ts` patterns), vanilla JS + Canvas (no new frontend dependency for charts), CSP already allows `unpkg.com` (existing `cytoscape` allowance) if a later pass wants real syntax highlighting — not required for this plan's plain `<pre>` rendering.

## Global Constraints

- `display_content` is **not** gated by the capability-grant system, unlike every other tool — it has no real-world side effect or access to anything private beyond what the conversation already contains. `executeTool`'s permission check needs an explicit small carve-out for this (see Task 1) rather than adding a capability that's auto-granted to everyone, which would be a bigger, unrelated change to the grants system.
- No new frontend dependency for v1 — charts render via a small hand-written Canvas bar-chart function, code renders as plain (escaped) `<pre>`, not a full syntax highlighter.
- The `webpage` type will not work for every URL — many real sites block iframe embedding via their own headers, which no CSP change on Jarvis's side can work around. The panel must show a clear fallback, not a silently blank iframe.
- Unlike the other tools, `display_content` has no natural keyword trigger phrases (it's the model's own judgment about reply *format*, not something a user phrases a request around) — deliberately not added to `TOOL_TRIGGER_WORDS`.

---

### Task 1: `display_content` tool declaration, ungated execution, and SSE relay

**Files:**
- Modify: `src/execution/tools.ts` (`TOOL_DECLARATIONS`, `ToolCallResult`, `executeTool`)
- Modify: `src/server.ts:855-864` (Gemini function-calling loop)
- Test: `tests/index.test.ts`

**Interfaces:**
- Produces: `ToolCallResult.displayDirective?: { type: string; title: string; content: any }`, read by `/api/chat`'s loop and by later Task 2 (client) via the new `display: ` SSE frame.

- [ ] **Step 1: Add the tool declaration**

In `src/execution/tools.ts`, add to `TOOL_DECLARATIONS` (after the `view_screen` entry from the companion plan, or anywhere in the array if that plan hasn't landed yet):

```ts
  {
    name: "display_content",
    description: "Show something in the dashboard's display panel — use this whenever a reply has something genuinely better shown than said: an image, a code/text snippet, a simple chart, or a web page. Don't call this for plain conversational replies with nothing visual to show.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        type: { type: Type.STRING, description: "One of: image, code, chart, webpage" },
        title: { type: Type.STRING, description: "Short title shown at the top of the panel" },
        content: {
          type: Type.OBJECT,
          description: "Shape depends on type. image: {url} or {base64}. code: {code, language}. chart: {labels: string[], values: number[]}. webpage: {url}.",
          properties: {
            url: { type: Type.STRING },
            base64: { type: Type.STRING },
            code: { type: Type.STRING },
            language: { type: Type.STRING },
            labels: { type: Type.ARRAY, items: { type: Type.STRING } },
            values: { type: Type.ARRAY, items: { type: Type.NUMBER } },
          },
        },
      },
      required: ["type", "title", "content"],
    },
  },
];
```

- [ ] **Step 2: Extend `ToolCallResult`**

```ts
export interface ToolCallResult {
  name: string;
  ok: boolean;
  output?: any;
  error?: string;
  needsClientAction?: "capture_screen";
  // Set by display_content — relayed to the client as a "display: " SSE
  // frame by /api/chat. See Task 1 in
  // docs/superpowers/plans/2026-07-20-display-content-panel.md.
  displayDirective?: { type: string; title: string; content: any };
}
```

- [ ] **Step 3: Make `display_content` ungated in `executeTool`**

Current top of `executeTool`:
```ts
  const requiredGrant = PERMISSION_BY_TOOL[name];
  if (!requiredGrant) {
    return { name, ok: false, error: `Unknown tool "${name}"` };
  }
  if (!hasGrant(username, requiredGrant)) {
    observation.logAuditEvent(username, "tool_call_denied", "failed", `Missing grant "${requiredGrant}" for tool "${name}"`);
    return { name, ok: false, error: `Missing capability grant "${requiredGrant}"` };
  }
```

Replace with:
```ts
  // display_content has no real-world side effect or access to anything
  // private beyond what the conversation already contains, so it's the one
  // tool deliberately left out of PERMISSION_BY_TOOL/ALL_CAPABILITIES rather
  // than gated behind a grant every user would need to be given anyway.
  const UNGATED_TOOLS = new Set(["display_content"]);
  const requiredGrant = PERMISSION_BY_TOOL[name];
  if (!requiredGrant && !UNGATED_TOOLS.has(name)) {
    return { name, ok: false, error: `Unknown tool "${name}"` };
  }
  if (requiredGrant && !hasGrant(username, requiredGrant)) {
    observation.logAuditEvent(username, "tool_call_denied", "failed", `Missing grant "${requiredGrant}" for tool "${name}"`);
    return { name, ok: false, error: `Missing capability grant "${requiredGrant}"` };
  }
```

- [ ] **Step 4: Add the case and thread `displayDirective` through the shared return**

Current declaration right before the switch:
```ts
  try {
    let output: any;
    switch (name) {
```

Replace with:
```ts
  try {
    let output: any;
    let displayDirective: ToolCallResult["displayDirective"];
    switch (name) {
```

Add the case (anywhere among the others, e.g. right after `propose_command`'s case):
```ts
      case "display_content": {
        displayDirective = { type: args.type, title: args.title, content: args.content };
        output = `Displayed ${args.type} "${args.title}" in the display panel.`;
        break;
      }
```

Current shared success return, right after the switch:
```ts
    observation.logAuditEvent(username, "tool_call", "success", `${name}(${JSON.stringify(args)})`);
    return { name, ok: true, output };
```

Replace with:
```ts
    observation.logAuditEvent(username, "tool_call", "success", `${name}(${JSON.stringify(args)})`);
    return { name, ok: true, output, displayDirective };
```

(`displayDirective` stays `undefined` for every tool except `display_content` — harmless on the `ToolCallResult` shape since the field is optional.)

- [ ] **Step 5: Relay the directive as an SSE frame in `/api/chat`**

Current loop body in `src/server.ts` (inside `for (const call of calls) { ... }`):
```ts
                const result = await executeTool(call.name || "", call.args || {}, req.username, ai, kernel.localLlmEndpoint);
                toolCallsExecuted.push({ name: result.name, ok: result.ok });
                responseParts.push({
```

Insert a check right after computing `result` (before the existing `toolCallsExecuted.push(...)` line):
```ts
                const result = await executeTool(call.name || "", call.args || {}, req.username, ai, kernel.localLlmEndpoint, { alreadyAttached: !!image, supportsRoundTrip: true });
                if (result.displayDirective) {
                  res.write(`data: display: ${JSON.stringify(result.displayDirective)}\n\n`);
                }
                toolCallsExecuted.push({ name: result.name, ok: result.ok });
                responseParts.push({
```

(The `screenContext` argument here is shared with the companion `view_screen` plan's Task 2 — if that plan hasn't landed yet, pass `undefined` instead and let `executeTool`'s default apply.)

- [ ] **Step 6: Write the failing tests**

Add to `tests/index.test.ts`, in the `"Tools"` category section:

```ts
registerTest("Tools", "display_content executes without any capability grant", async () => {
  const result = await executeTool("display_content", { type: "image", title: "Test", content: { url: "https://example.com/x.png" } }, "ungranted_test_user");
  if (result.ok !== true) {
    throw new Error("Tools: display_content should succeed with no grant required");
  }
  if (!result.displayDirective || result.displayDirective.type !== "image") {
    throw new Error("Tools: display_content should return a displayDirective matching the call's type");
  }
});

registerTest("Tools", "unrelated tools never carry a displayDirective", async () => {
  const result = await executeTool("not_a_real_tool", {}, "admin");
  if ((result as any).displayDirective) {
    throw new Error("Tools: displayDirective should only ever be set by display_content");
  }
});
```

- [ ] **Step 7: Run the tests and verify they pass**

Run: `npm test 2>&1 | grep -A2 "display_content\|displayDirective"`
Expected: both new lines show `✅ [PASSED]`.

- [ ] **Step 8: Run the full typecheck**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 9: Commit**

```bash
git add src/execution/tools.ts src/server.ts tests/index.test.ts
git commit -m "feat: add ungated display_content tool with SSE relay"
```

---

### Task 2: Dashboard display panel (HTML + render dispatcher)

**Files:**
- Modify: `src/static/index.html` — new panel markup (after the conversation grid's closing tag, currently the sequence ending `</div>\n</div>` right before the `<!-- SUB-PANEL 3 -->` comment), new `renderDisplayContent`/`hideDisplayPanel`/`drawSimpleBarChart` functions, and one new branch in the SSE read loop's frame-type checks (alongside the existing `detail: ` check).

**Interfaces:**
- Consumes: the `display: {...}` SSE frame (Task 1).
- Produces: `renderDisplayContent(type, title, content)`, `hideDisplayPanel()` — global functions, callable directly from a browser console for manual/Playwright verification.

- [ ] **Step 1: Add the panel markup**

Insert this immediately after the conversation grid's closing `</div>` (the one that closes `<div class="grid grid-cols-1 lg:grid-cols-4 gap-4">`), still inside the outer `<div class="w-full max-w-3xl mx-auto mt-8 ...">` conversation wrapper:

```html
                    <!-- Display panel — Jarvis renders here (images, code,
                         charts, embedded pages) whenever a reply has
                         something better shown than said. Hidden until the
                         first "display: " SSE frame arrives. -->
                    <div id="display-panel" class="hidden holo-panel rounded-2xl mt-4 flex flex-col max-h-[520px]">
                        <div class="flex items-center justify-between px-4 py-3 border-b border-white/5">
                            <span id="display-panel-title" class="text-xs font-semibold uppercase tracking-wider text-secondary">Display</span>
                            <button onclick="hideDisplayPanel()" class="text-secondary hover:text-white transition-all text-lg leading-none" title="Close">&times;</button>
                        </div>
                        <div id="display-panel-body" class="flex-1 overflow-auto p-4"></div>
                    </div>
```

- [ ] **Step 2: Add the render dispatcher and helpers**

Add these functions near `toggleTraceSidebar()` (same general area of the file — the two are conceptually similar, a small "panel visibility" helper):

```js
    function renderDisplayContent(type, title, content) {
        const panel = document.getElementById('display-panel');
        const body = document.getElementById('display-panel-body');
        const titleEl = document.getElementById('display-panel-title');
        if (!panel || !body || !titleEl) return;

        titleEl.textContent = title || 'Display';
        body.innerHTML = '';

        if (type === 'image') {
            const img = document.createElement('img');
            img.src = content?.url || (content?.base64 ? `data:image/png;base64,${content.base64}` : '');
            img.className = 'max-w-full rounded-xl mx-auto';
            body.appendChild(img);
        } else if (type === 'code') {
            const pre = document.createElement('pre');
            pre.className = 'text-xs font-mono whitespace-pre-wrap text-white bg-black/30 rounded-xl p-4';
            pre.textContent = content?.code || '';
            body.appendChild(pre);
        } else if (type === 'chart') {
            const canvas = document.createElement('canvas');
            canvas.width = 480;
            canvas.height = 280;
            body.appendChild(canvas);
            drawSimpleBarChart(canvas, content?.labels || [], content?.values || []);
        } else if (type === 'webpage') {
            const iframe = document.createElement('iframe');
            iframe.src = content?.url || '';
            iframe.className = 'w-full h-[420px] rounded-xl border border-white/10';
            const fallback = document.createElement('div');
            fallback.className = 'text-secondary text-xs text-center py-8 hidden';
            fallback.innerHTML = `This site doesn't allow embedding — <a href="${escapeHtml(content?.url || '')}" target="_blank" class="text-primary underline">open in new tab</a> instead.`;
            let loaded = false;
            iframe.onload = () => { loaded = true; };
            body.appendChild(iframe);
            body.appendChild(fallback);
            setTimeout(() => {
                if (!loaded) {
                    iframe.classList.add('hidden');
                    fallback.classList.remove('hidden');
                }
            }, 4000);
        } else {
            const err = document.createElement('div');
            err.className = 'text-danger text-xs text-center py-8';
            err.textContent = `Unsupported display type: "${String(type)}"`;
            body.appendChild(err);
        }

        panel.classList.remove('hidden');
    }

    function hideDisplayPanel() {
        document.getElementById('display-panel')?.classList.add('hidden');
    }

    // Minimal, dependency-free bar chart — no charting library needed for
    // the simple {labels, values} shape display_content sends.
    function drawSimpleBarChart(canvas, labels, values) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!values.length) return;
        const max = Math.max(...values, 1);
        const barWidth = canvas.width / values.length;
        ctx.fillStyle = '#8FB8E8';
        values.forEach((v, i) => {
            const barHeight = (v / max) * (canvas.height - 30);
            ctx.fillRect(i * barWidth + 8, canvas.height - barHeight - 20, barWidth - 16, barHeight);
        });
        ctx.fillStyle = '#767C8C';
        ctx.font = '10px monospace';
        labels.forEach((label, i) => {
            ctx.fillText(String(label).slice(0, 10), i * barWidth + 8, canvas.height - 6);
        });
    }
```

- [ ] **Step 3: Recognize the SSE frame**

In the same SSE read loop that already checks `dataStr.startsWith("detail: ")`, add a new check right before it:

```js
                        if (dataStr.startsWith("display: ")) {
                            try {
                                const directive = JSON.parse(dataStr.slice(9));
                                renderDisplayContent(directive.type, directive.title, directive.content);
                            } catch {}
                            continue;
                        }

                        if (dataStr.startsWith("detail: ")) {
```

- [ ] **Step 4: Verify each content type renders correctly (Playwright, fully automatable — no Gemini/live model call needed)**

Using `mcp__plugin_playwright_playwright__browser_navigate` to the dashboard (logged in with a disposable test key per this project's established Playwright testing pattern), then `mcp__plugin_playwright_playwright__browser_evaluate` to call the dispatcher directly — this tests the rendering logic in complete isolation from whether Gemini ever actually decides to call the tool:

```js
() => {
  renderDisplayContent('image', 'Test Image', { url: 'https://picsum.photos/200' });
  const panelHidden = document.getElementById('display-panel').classList.contains('hidden');
  return { panelHidden, hasImg: !!document.querySelector('#display-panel-body img') };
}
```
Expected: `{ panelHidden: false, hasImg: true }`.

Repeat for each type:
```js
() => { renderDisplayContent('code', 'Snippet', { code: 'console.log("hi")' }); return document.querySelector('#display-panel-body pre')?.textContent; }
```
Expected: `'console.log("hi")'`.

```js
() => { renderDisplayContent('chart', 'Chart', { labels: ['a','b'], values: [3,7] }); return !!document.querySelector('#display-panel-body canvas'); }
```
Expected: `true`.

```js
() => { renderDisplayContent('webpage', 'Blocked Site', { url: 'https://www.google.com' }); return true; }
```
Wait 5 seconds (past the 4-second fallback timeout), then:
```js
() => document.querySelector('#display-panel-body iframe')?.classList.contains('hidden')
```
Expected: `true` — `google.com` blocks framing, confirming the fallback triggers correctly for a real known-blocking site.

```js
() => { renderDisplayContent('bogus_type', 'Bad', {}); return document.querySelector('#display-panel-body')?.textContent; }
```
Expected: contains `'Unsupported display type: "bogus_type"'`.

Finally, verify dismiss:
```js
() => { hideDisplayPanel(); return document.getElementById('display-panel').classList.contains('hidden'); }
```
Expected: `true`.

- [ ] **Step 5: Commit**

```bash
git add src/static/index.html
git commit -m "feat: add dashboard display panel driven by display_content SSE frames"
```

---

## Self-Review

**Spec coverage:** Task 1 covers "declared in TOOL_DECLARATIONS," "not gated by the capability-grant system," and "rides the existing SSE stream as a new display: {...} frame." Task 2 covers the per-type renderer (image/code/chart/webpage), the webpage fallback for sites that block framing, the malformed-type error state, and the dismiss control. All design-doc requirements for this subsystem are covered.

**Placeholder scan:** No TBD/TODO; every step has exact code or an exact command with expected output.

**Type consistency:** `displayDirective`'s shape (`{ type, title, content }`, Task 1) matches exactly what Task 2's `renderDisplayContent(type, title, content)` destructures from the parsed SSE frame. `UNGATED_TOOLS`/permission-check change (Task 1) only affects `display_content` by name — every other tool's existing gating behavior is unchanged (verified by the second Task 1 test, which confirms an unrelated unknown tool still gets rejected).
