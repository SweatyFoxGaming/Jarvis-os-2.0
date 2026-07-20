# `view_screen` Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gemini can look at what's on the user's screen when it's actually relevant to the conversation, gated behind the same capability-grant system as GitHub/email.

**Architecture:** `view_screen` is declared and gated exactly like every other tool in `src/execution/tools.ts`, but its "execution" can't complete server-side (only the Electron renderer/main process can see the screen — the Node backend runs in Docker with no display access). So `executeTool` returns a sentinel result (`needsClientAction: "capture_screen"`) instead of a normal output; `/api/chat` detects it, tells the connected client to capture and resubmit via a new SSE frame, and ends that turn. The client captures one still image via Electron's `desktopCapturer` and resubmits the same message with the screenshot attached through the **existing `image` field** camera frames already use — no new request shape for the "answer with vision" path, only for the "please go capture one" signal.

**Tech Stack:** TypeScript (existing `tools.ts`/`server.ts` patterns), Electron `desktopCapturer` (main process), `contextBridge` (existing `preload.js` pattern).

## Global Constraints

- `view_screen` requires the `screen.view` capability grant, default-deny like every other tool — added to `ALL_CAPABILITIES` in `src/execution/permissions.ts`, which already auto-grants admin and backfills existing installs (confirmed working for `executive.plan` previously — no separate migration needed here).
- This tool is scoped to **text chat only** for this pass — the Gemini Live voice bridge (`src/cognition/live-voice.ts`) shares `TOOL_DECLARATIONS` but has its own separate WebSocket protocol; the round-trip mechanism here is `/api/chat`-SSE-specific. `executeTool`'s new `screenContext` parameter defaults to `{ alreadyAttached: false, supportsRoundTrip: false }`, so `live-voice.ts`'s existing call site (which doesn't pass this new parameter) automatically gets the safe "not supported here" behavior with no code change required there.
- On-demand only — this tool captures exactly one still image per call, never a stream, matching the explicit design decision to not build continuous ambient screen capture.
- Outside the desktop app (a plain browser tab), `desktopCapturer` doesn't exist — the client must degrade to a clear message, not a silent failure.

---

### Task 1: `view_screen` tool declaration, permission, and `executeTool` case

**Files:**
- Modify: `src/execution/permissions.ts:18-38` (`ALL_CAPABILITIES`)
- Modify: `src/execution/tools.ts` (`PERMISSION_BY_TOOL`, `TOOL_DECLARATIONS`, `ToolCallResult`, `executeTool`, `TOOL_TRIGGER_WORDS`)
- Test: `tests/index.test.ts`

**Interfaces:**
- Produces: `ToolCallResult.needsClientAction?: "capture_screen"` — a new optional field later tasks (Task 2) read to detect the round-trip case. `executeTool`'s new 6th parameter, `screenContext: { alreadyAttached: boolean; supportsRoundTrip: boolean } = { alreadyAttached: false, supportsRoundTrip: false }`.

- [ ] **Step 1: Add the capability**

In `src/execution/permissions.ts`, add to `ALL_CAPABILITIES` (after `"security.manage",` and before `"system.execute",` — alphabetically near the other read-only grants is fine, exact position doesn't matter):

```ts
  "security.read",
  "security.manage",
  "screen.view",
  "system.execute",
] as const;
```

- [ ] **Step 2: Add the permission mapping and tool declaration**

In `src/execution/tools.ts`, add to `PERMISSION_BY_TOOL`:

```ts
  propose_command: "system.execute",
  view_screen: "screen.view",
};
```

Add to `TOOL_DECLARATIONS` (anywhere in the array — after the last entry, before the closing `];`):

```ts
  {
    name: "view_screen",
    description: "Look at what's currently on the user's screen. Only call this when screen content would genuinely help answer the question (e.g. \"what am I looking at\", \"help me with this error\", \"what does this say\") — not for every message.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
];
```

- [ ] **Step 3: Extend `ToolCallResult` and `executeTool`'s signature**

Change the interface:

```ts
export interface ToolCallResult {
  name: string;
  ok: boolean;
  output?: any;
  error?: string;
  // Set when a tool can't execute server-side and needs the connected
  // client to do something first (currently only view_screen) — see
  // Task 2 in docs/superpowers/plans/2026-07-20-view-screen-tool.md.
  needsClientAction?: "capture_screen";
}
```

Change the function signature:

```ts
export async function executeTool(
  name: string,
  args: Record<string, any>,
  username: string,
  ai: GoogleGenAI | null = null,
  localEndpoint: string | null = null,
  screenContext: { alreadyAttached: boolean; supportsRoundTrip: boolean } = { alreadyAttached: false, supportsRoundTrip: false }
): Promise<ToolCallResult> {
```

- [ ] **Step 4: Add the `view_screen` case**

Add this case to the `switch (name)` block (anywhere among the other cases, e.g. right after `propose_command`'s case, before the `default:`):

```ts
      case "view_screen": {
        if (screenContext.alreadyAttached) {
          output = "A screenshot is already attached to this message — describe what's visible in it directly, no need to look again.";
          break;
        }
        if (!screenContext.supportsRoundTrip) {
          return { name, ok: false, error: "Screen viewing isn't available in this mode yet — ask via text chat instead." };
        }
        return { name, ok: false, error: "Screen capture requested", needsClientAction: "capture_screen" };
      }
```

- [ ] **Step 5: Add routing trigger words**

In `TOOL_TRIGGER_WORDS`, add:

```ts
  get_security_status: ["network security", "unknown device", "unrecognized device", "vulnerabilit", "security findings", "is my network safe"],
  view_screen: ["what's on my screen", "whats on my screen", "look at my screen", "what am i looking at", "help me with this error", "what does this say"],
};
```

- [ ] **Step 6: Write the failing test**

Add to `tests/index.test.ts`, in the `"Tools"` category section (right after the existing `"executeTool rejects unknown tool names"` test):

```ts
registerTest("Tools", "view_screen returns a client-action sentinel when nothing is attached yet", async () => {
  const result = await executeTool("view_screen", {}, "admin");
  if (result.ok !== false || result.needsClientAction !== "capture_screen") {
    throw new Error("Tools: view_screen should return needsClientAction='capture_screen' with no screenContext passed");
  }
});

registerTest("Tools", "view_screen answers directly once a screenshot is already attached", async () => {
  const result = await executeTool("view_screen", {}, "admin", null, null, { alreadyAttached: true, supportsRoundTrip: true });
  if (result.ok !== true || result.needsClientAction) {
    throw new Error("Tools: view_screen should answer directly (ok:true, no needsClientAction) when alreadyAttached is true");
  }
});

registerTest("Tools", "view_screen declines cleanly where the round trip isn't supported (e.g. voice mode)", async () => {
  const result = await executeTool("view_screen", {}, "admin", null, null, { alreadyAttached: false, supportsRoundTrip: false });
  if (result.ok !== false || result.needsClientAction) {
    throw new Error("Tools: view_screen should fail cleanly with no needsClientAction when supportsRoundTrip is false");
  }
});
```

- [ ] **Step 7: Run the tests and verify they pass**

Run: `npm test 2>&1 | grep -A2 "view_screen"`
Expected: all three new lines show `✅ [PASSED] [Category: Tools] - view_screen ...`, and the final `TOTALS:` line shows all tests passing (28/28 — 25 existing + 3 new).

- [ ] **Step 8: Run the full typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 9: Commit**

```bash
git add src/execution/permissions.ts src/execution/tools.ts tests/index.test.ts
git commit -m "feat: add view_screen tool with client-round-trip sentinel"
```

---

### Task 2: Wire the round trip into `/api/chat`

**Files:**
- Modify: `src/server.ts:554` (`req.body` destructure), `src/server.ts:824-864` (Gemini function-calling loop)

**Interfaces:**
- Consumes: `ToolCallResult.needsClientAction` (Task 1), `executeTool`'s new `screenContext` parameter (Task 1).
- Produces: a new SSE frame `data: request_screen\n\n` on the existing `/api/chat` stream — Task 4 (client) reads this exact string.

- [ ] **Step 1: Pass `screenContext` into the existing `executeTool` call**

Current call (`src/server.ts:855`):
```ts
const result = await executeTool(call.name || "", call.args || {}, req.username, ai, kernel.localLlmEndpoint);
```

Replace with:
```ts
const result = await executeTool(
  call.name || "",
  call.args || {},
  req.username,
  ai,
  kernel.localLlmEndpoint,
  { alreadyAttached: !!image, supportsRoundTrip: true }
);

// view_screen can't execute server-side — it needs the connected client to
// capture a screenshot and resubmit (see Task 1's design note). End this
// turn here rather than feeding a fake function response back to Gemini.
if (result.needsClientAction === "capture_screen") {
  res.write("data: request_screen\n\n");
  res.write("data: [DONE]\n\n");
  res.end();
  success = true;
  succeededStep = "Gemini";
  return;
}
```

- [ ] **Step 2: Verify the SSE frame with a scriptable request (no browser needed)**

This can be tested directly over HTTP — `view_screen` only needs a message that routes to Gemini and gets the model to call it. Since actually getting Gemini to *choose* to call the tool depends on live model behavior (not deterministic enough for an assert), verify the mechanism itself by temporarily forcing the call in a scratch script instead of asserting on live model behavior:

Run:
```bash
INTERNAL_KEY=$(grep "^INTERNAL_API_KEY=" .env | cut -d= -f2-)
node -e '
const http = require("http");
const req = http.request({
  hostname: "localhost", port: 3000, path: "/api/chat", method: "POST",
  headers: { "Content-Type": "application/json", "X-API-Key": process.env.KEY }
}, res => {
  let body = "";
  res.on("data", d => body += d);
  res.on("end", () => console.log(body.includes("request_screen") ? "SAW request_screen FRAME" : "did not see it — check that Gemini actually called view_screen for this prompt"));
});
req.write(JSON.stringify({ message: "what is on my screen right now, use view_screen to check" }));
req.end();
' KEY="$INTERNAL_KEY"
```
Expected: `SAW request_screen FRAME` (assuming the admin account has been granted `screen.view` — grant it first via the existing admin capability-grant endpoint/UI if this is a fresh capability with no grant yet).

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat: emit a request_screen SSE frame when view_screen needs a client capture"
```

---

### Task 3: Electron screen capture (main process + preload bridge)

**Files:**
- Modify: `desktop-electron/main.js` (add `desktopCapturer` import and an `ipcMain.handle`)
- Modify: `desktop-electron/preload.js`

**Interfaces:**
- Produces: `window.jarvisDesktop.captureScreen(): Promise<string | null>` — resolves to a base64 JPEG string (no `data:` prefix, matching the existing camera-frame convention) or `null` if capture isn't possible.

- [ ] **Step 1: Add the main-process capture handler**

In `desktop-electron/main.js`, add `desktopCapturer` and `ipcMain` (already imported) to the top `require`:

```js
const { app, BrowserWindow, session, Tray, Menu, globalShortcut, Notification, ipcMain, nativeImage, desktopCapturer } = require('electron');
```

Add this handler near the existing `ipcMain.on('notify', ...)` block:

```js
// One still image, not a stream — matches the explicit on-demand-only
// design decision (see docs/superpowers/specs/2026-07-20-...design.md).
ipcMain.handle('capture-screen', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
    });
    if (!sources.length) return null;
    // toJPEG returns a Buffer; strip to base64 only, matching the
    // no-data-URL-prefix convention captureCameraFrame() already uses
    // client-side for camera frames.
    return sources[0].thumbnail.toJPEG(80).toString('base64');
  } catch (err) {
    console.error('[main] Screen capture failed:', err.message);
    return null;
  }
});
```

- [ ] **Step 2: Expose it through the preload bridge**

Current `desktop-electron/preload.js`:
```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvisDesktop', {
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
});
```

Replace with:
```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvisDesktop', {
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
});
```

- [ ] **Step 3: Verify live in the desktop app's devtools console**

Run: `cd desktop-electron && ./launch.sh`
Open devtools (View menu, or `Ctrl+Shift+I` if enabled) and in the console run:
```js
await window.jarvisDesktop.captureScreen()
```
Expected: a long base64 string (not `null`, not an exception). Paste the first ~50 characters into a `data:image/jpeg;base64,` URL in a new browser tab's address bar to visually confirm it's a real screenshot of the current desktop.

- [ ] **Step 4: Commit**

```bash
git add desktop-electron/main.js desktop-electron/preload.js
git commit -m "feat: expose one-shot screen capture through the Electron preload bridge"
```

---

### Task 4: Client-side SSE handling and auto-resubmit

**Files:**
- Modify: `src/static/index.html` (`triggerChatDialogue`, around the SSE read loop at `src/static/index.html:2851-2894` per the current file)

**Interfaces:**
- Consumes: `window.jarvisDesktop.captureScreen()` (Task 3), the `request_screen` SSE frame (Task 2).

- [ ] **Step 1: Recognize the new frame and resubmit**

In `triggerChatDialogue`'s SSE read loop, the current code checks each `data: ` line for `[DONE]` and `detail: ` prefixes before falling through to normal text handling:

```js
                        const dataStr = line.slice(6).replace(/\r$/, "");
                        if (dataStr === "[DONE]") break;

                        if (dataStr.startsWith("detail: ")) {
```

Add a new check for `request_screen` right before the `[DONE]` check:

```js
                        const dataStr = line.slice(6).replace(/\r$/, "");

                        if (dataStr === "request_screen") {
                            if (!window.jarvisDesktop?.captureScreen) {
                                appendChatMessage("Screen viewing is only available in the desktop app.", "assistant");
                                return;
                            }
                            const screenshot = await window.jarvisDesktop.captureScreen();
                            if (!screenshot) {
                                appendChatMessage("I couldn't capture your screen just now.", "assistant");
                                return;
                            }
                            addNotification("Looking at your screen...", "info");
                            return triggerChatDialogue(text, screenshot);
                        }

                        if (dataStr === "[DONE]") break;

                        if (dataStr.startsWith("detail: ")) {
```

- [ ] **Step 2: Accept an explicit screenshot override in `triggerChatDialogue`**

`triggerChatDialogue` currently only takes `presetMessage` and derives its image from `captureCameraFrame()`. Change its signature to accept an optional screenshot that takes priority over the camera frame for this one call:

Current:
```js
    async function triggerChatDialogue(presetMessage) {
        const isPreset = typeof presetMessage === "string";
        const text = (isPreset ? presetMessage : chatInput.value).trim();
        if (!text) return;
        if (!isPreset) chatInput.value = '';
```

Replace with:
```js
    async function triggerChatDialogue(presetMessage, screenshotOverride) {
        const isPreset = typeof presetMessage === "string";
        const text = (isPreset ? presetMessage : chatInput.value).trim();
        if (!text) return;
        if (!isPreset) chatInput.value = '';
```

Then further down, where `captureCameraFrame()` is called to build `frame`:

Current:
```js
        const frame = captureCameraFrame();
        if (frame) addNotification("Visual snapshot attached — Jarvis can see this turn.", "info");
```

Replace with:
```js
        const frame = screenshotOverride || captureCameraFrame();
        if (screenshotOverride) {
            // Already notified via "Looking at your screen..." above — no
            // second, redundant notification for the same resubmitted turn.
        } else if (frame) {
            addNotification("Visual snapshot attached — Jarvis can see this turn.", "info");
        }
```

- [ ] **Step 3: Verify the resubmit path without needing a real screenshot**

This can be exercised in a plain browser tab (no `window.jarvisDesktop`) to confirm the graceful-degradation branch, without needing Electron at all:

Using Playwright (`mcp__plugin_playwright_playwright__browser_navigate` to the dashboard, logged in with a disposable test key as established elsewhere in this project's testing pattern):
```js
// via browser_evaluate, simulating the server sending the frame without
// needing Gemini to actually decide to call view_screen live:
() => {
  // window.jarvisDesktop is undefined in a plain browser tab — confirms
  // the "only available in the desktop app" branch fires correctly.
  return typeof window.jarvisDesktop;
}
```
Expected: `"undefined"` — then manually trigger the same code path the SSE handler would (call `appendChatMessage("Screen viewing is only available in the desktop app.", "assistant")` directly via `browser_evaluate`) and confirm it renders as a normal assistant message.

Full end-to-end (real screenshot, real Gemini tool call, real resubmit) is Electron-only and must be verified live in the desktop app per Task 3 Step 3's setup — not automatable.

- [ ] **Step 4: Commit**

```bash
git add src/static/index.html
git commit -m "feat: auto-resubmit chat with a screenshot when Jarvis requests one"
```

---

## Self-Review

**Spec coverage:** Task 1 covers "declared in TOOL_DECLARATIONS and gated by the same capability-grant system." Task 2 covers "emits a new SSE frame... telling the client 'capture and resubmit.'" Task 3 covers "a single still image, not a video stream... exposed through preload.js." Task 4 covers "automatically resubmits the original message... via the same image field" and the plain-browser-tab fallback. All four design-doc requirements for this subsystem are covered.

**Placeholder scan:** No TBD/TODO; every step has exact code or an exact command with expected output.

**Type consistency:** `needsClientAction` (Task 1) is checked in Task 2 with the exact same string literal `"capture_screen"`. `executeTool`'s `screenContext` parameter shape (`{ alreadyAttached, supportsRoundTrip }`, Task 1) matches exactly how Task 2 constructs and passes it. `window.jarvisDesktop.captureScreen()` (Task 3's produced interface) matches exactly how Task 4 calls it.
