# Core Event Bus & IPC Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the central TypeScript pub/sub event bus, a `/ws/events` WebSocket endpoint that makes it reachable from host-level and browser-level processes, and a rewritten `eww-bridge.ts` that replaces `eww-adapter.ts`'s HTTP polling with real event-driven push.

**Architecture:** `src/core/event-bus.ts` is a pure in-process singleton with no I/O. `server.ts` exposes `/ws/events`, subscribing to the bus internally and forwarding every published event to connected WebSocket clients. A `chokidar`-based filesystem watcher becomes the bus's first real publisher (`filesystem:changed`). `eww-bridge.ts` (host-level, replacing `eww-adapter.ts`) connects to `/ws/events` as a Node WebSocket client and uses bus events as a trigger to refresh from the existing `/api/hud/status` snapshot endpoint, rather than polling blindly every 2 seconds — real push-driven refresh without requiring every HUD-relevant state mutation across the codebase to be individually re-plumbed to publish granular events (a much larger, separate undertaking, correctly out of scope here per the parent spec).

**Tech Stack:** TypeScript/Express, existing `ws` package (already used by `/ws/voice`), new `chokidar` dependency for filesystem watching.

**Full design context:** `docs/superpowers/specs/2026-08-07-event-bus-voice-engine-design.md` — this plan implements that spec's event-bus and IPC-bridge portions only; the voice daemon (Python, Faster-Whisper, Kokoro-82M) is a separate, later plan that builds on top of what's delivered here.

## Global Constraints

- `src/system/eww-adapter.ts` runs on the **bare host**, not inside Docker — EWW needs a real X11/Wayland connection the container doesn't have. `eww-bridge.ts` (its replacement) must be equally dependency-free (Node built-ins only: `ws` is the one exception, needed for a real WebSocket client — check whether it's already a viable zero-install option or whether this constraint needs revisiting; if `ws` requires `node_modules`, this is a deliberate, documented exception to the "no project node_modules required" property `eww-adapter.ts`'s own comment describes, not an oversight).
- The Electron app has no backend protocol of its own beyond loading `http://localhost:3000` (confirmed: `desktop-electron/main.js`) — no new Electron-specific IPC file is created in this plan.
- Browser-based WebSocket clients cannot set a custom `X-API-Key` header on the handshake (confirmed by the existing `/ws/voice` route's own comment) — any browser-originated `/ws/events` connection must use the same short-lived, single-use ticket pattern `/ws/voice` already uses, not the permanent API key.
- A Node.js WebSocket client (like `eww-bridge.ts`, not a browser) CAN set a custom header on the handshake — it authenticates via `X-API-Key` directly, reusing `JARVIS_API_KEY`, matching how `eww-adapter.ts` already authenticates its HTTP polling today.
- `npx tsc --noEmit` and `npm test` must both pass after every task, before that task's commit.
- No live EWW process, no live Electron process, and no real filesystem watching a production directory required by any automated test.

---

## File Structure

| File | Change |
|---|---|
| `src/core/event-bus.ts` | Create — `EventBus.getInstance()`, `subscribe(topic, handler)`, `publish(topic, payload)` |
| `src/server.ts` | Modify — add `/ws/events` WebSocket endpoint + ticket issuance, wire the filesystem watcher |
| `src/core/filesystem-watcher.ts` | Create — `chokidar`-based watcher, publishes `filesystem:changed` onto the bus |
| `src/ipc/eww-bridge.ts` | Create — replaces `src/system/eww-adapter.ts` |
| `src/system/eww-adapter.ts` | Delete |
| `deploy/jarvis-hud-eww.service`, `scripts/install-eww.sh` | Modify — point at the new bridge file |
| `package.json` | Modify — add `chokidar` |

---

## Task 1: Event bus core

**Files:**
- Create: `src/core/event-bus.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Produces: `EventBus.getInstance(): EventBus`, `subscribe<T = any>(topic: string, handler: (payload: T) => void): () => void`, `publish<T = any>(topic: string, payload: T): void`

- [ ] **Step 1: Write the failing tests**

Add to `tests/index.test.ts`:

```typescript
import { EventBus } from "../src/core/event-bus.js";

registerTest("EventBus", "publish delivers the payload to a subscriber on the same topic", () => {
  const bus = EventBus.getInstance();
  let received: any = null;
  const unsubscribe = bus.subscribe("test:topic-a", (payload) => { received = payload; });
  bus.publish("test:topic-a", { value: 42 });
  unsubscribe();
  if (!received || received.value !== 42) {
    throw new Error(`EventBus: expected {value: 42}, got: ${JSON.stringify(received)}`);
  }
});

registerTest("EventBus", "publish does not deliver to a subscriber on a different topic", () => {
  const bus = EventBus.getInstance();
  let received: any = null;
  const unsubscribe = bus.subscribe("test:topic-b", (payload) => { received = payload; });
  bus.publish("test:topic-c", { value: 1 });
  unsubscribe();
  if (received !== null) {
    throw new Error(`EventBus: expected no delivery across topics, got: ${JSON.stringify(received)}`);
  }
});

registerTest("EventBus", "multiple subscribers on the same topic all receive the payload", () => {
  const bus = EventBus.getInstance();
  let countA = 0, countB = 0;
  const unsubA = bus.subscribe("test:topic-d", () => { countA++; });
  const unsubB = bus.subscribe("test:topic-d", () => { countB++; });
  bus.publish("test:topic-d", {});
  unsubA();
  unsubB();
  if (countA !== 1 || countB !== 1) {
    throw new Error(`EventBus: expected both subscribers called once, got countA=${countA}, countB=${countB}`);
  }
});

registerTest("EventBus", "the function returned by subscribe correctly unsubscribes", () => {
  const bus = EventBus.getInstance();
  let count = 0;
  const unsubscribe = bus.subscribe("test:topic-e", () => { count++; });
  bus.publish("test:topic-e", {});
  unsubscribe();
  bus.publish("test:topic-e", {});
  if (count !== 1) {
    throw new Error(`EventBus: expected exactly 1 delivery before unsubscribe, got: ${count}`);
  }
});

registerTest("EventBus", "publish to a topic with no subscribers does not throw", () => {
  const bus = EventBus.getInstance();
  bus.publish("test:topic-with-nobody-listening", { anything: true });
});

registerTest("EventBus", "a handler that throws does not prevent other handlers on the same topic from running", () => {
  const bus = EventBus.getInstance();
  let secondHandlerRan = false;
  const unsub1 = bus.subscribe("test:topic-f", () => { throw new Error("deliberate handler failure"); });
  const unsub2 = bus.subscribe("test:topic-f", () => { secondHandlerRan = true; });
  bus.publish("test:topic-f", {});
  unsub1();
  unsub2();
  if (!secondHandlerRan) {
    throw new Error("EventBus: expected the second handler to still run after the first one threw");
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep EventBus`
Expected: FAIL — module doesn't exist yet

- [ ] **Step 3: Implement**

Create `src/core/event-bus.ts`:

```typescript
import { ObservationPlatform } from "../kernel/observation.js";

const observation = ObservationPlatform.getInstance();

type Handler<T = any> = (payload: T) => void;

/**
 * Pure in-process pub/sub — no I/O of its own. Subsystems publish to named
 * topics (e.g. "filesystem:changed", "voice:transcript") and subscribe with
 * typed handlers. This is the backbone /ws/events forwards onto WebSocket
 * clients (browser pages, host-level bridges) — see server.ts.
 *
 * A handler that throws is caught and logged, not allowed to break delivery
 * to the other subscribers on the same topic or to the publisher's own
 * call stack — a single misbehaving subscriber must never take down
 * whatever just published an event.
 */
export class EventBus {
  private static instance: EventBus | null = null;
  private handlers = new Map<string, Set<Handler>>();

  public static getInstance(): EventBus {
    if (!this.instance) {
      this.instance = new EventBus();
    }
    return this.instance;
  }

  public subscribe<T = any>(topic: string, handler: Handler<T>): () => void {
    if (!this.handlers.has(topic)) {
      this.handlers.set(topic, new Set());
    }
    this.handlers.get(topic)!.add(handler as Handler);
    return () => {
      this.handlers.get(topic)?.delete(handler as Handler);
    };
  }

  public publish<T = any>(topic: string, payload: T): void {
    const topicHandlers = this.handlers.get(topic);
    if (!topicHandlers || topicHandlers.size === 0) return;
    for (const handler of topicHandlers) {
      try {
        handler(payload);
      } catch (err: any) {
        observation.logTelemetry("warn", "EventBus", `Handler for topic "${topic}" threw: ${err.message || err}`);
      }
    }
  }
}
```

- [ ] **Step 4: Run tests, verify pass, typecheck, commit**

Run: `npx tsc --noEmit && npm test`
Expected: no errors, all tests pass

```bash
git add src/core/event-bus.ts tests/index.test.ts
git commit -m "feat: add the core event bus"
```

---

## Task 2: Filesystem watcher publisher

**Files:**
- Create: `src/core/filesystem-watcher.ts`
- Modify: `package.json`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `EventBus` (Task 1)
- Produces: `startFilesystemWatcher(watchPaths: string[]): { stop: () => void }`

- [ ] **Step 1: Add the `chokidar` dependency**

Run: `npm install chokidar`

- [ ] **Step 2: Write the failing test**

Add to `tests/index.test.ts`:

```typescript
import { startFilesystemWatcher } from "../src/core/filesystem-watcher.js";
import fs from "fs";
import os from "os";
import path from "path";

registerTest("FilesystemWatcher", "publishes filesystem:changed when a watched file is created", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-fs-watch-test-"));
  const bus = EventBus.getInstance();
  let received: any = null;
  const unsubscribe = bus.subscribe("filesystem:changed", (payload) => { received = payload; });
  const watcher = startFilesystemWatcher([tmpDir]);
  try {
    // chokidar's initial scan + the OS's own file-event latency make this
    // inherently async and not instant — poll briefly rather than
    // asserting immediately after the write.
    fs.writeFileSync(path.join(tmpDir, "test-file.txt"), "hello");
    const deadline = Date.now() + 5000;
    while (!received && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!received || !received.path || !received.path.includes("test-file.txt")) {
      throw new Error(`FilesystemWatcher: expected a filesystem:changed event naming test-file.txt, got: ${JSON.stringify(received)}`);
    }
  } finally {
    unsubscribe();
    watcher.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test 2>&1 | grep FilesystemWatcher`
Expected: FAIL — module doesn't exist yet

- [ ] **Step 4: Implement**

Create `src/core/filesystem-watcher.ts`:

```typescript
import chokidar, { FSWatcher } from "chokidar";
import { EventBus } from "./event-bus.js";
import { ObservationPlatform } from "../kernel/observation.js";

const observation = ObservationPlatform.getInstance();
const bus = EventBus.getInstance();

export interface FilesystemChangedPayload {
  path: string;
  eventType: "add" | "change" | "unlink";
}

/**
 * Publishes filesystem:changed onto the event bus instead of anything
 * downstream needing its own cron-style polling loop. Ignores dotfiles and
 * node_modules by default — chokidar's own sensible baseline, not something
 * this codebase needs to hand-roll.
 */
export function startFilesystemWatcher(watchPaths: string[]): { stop: () => void } {
  const watcher: FSWatcher = chokidar.watch(watchPaths, {
    ignored: /(^|[/\\])\.|node_modules/,
    persistent: true,
    ignoreInitial: true,
  });

  const publish = (eventType: FilesystemChangedPayload["eventType"]) => (path: string) => {
    bus.publish<FilesystemChangedPayload>("filesystem:changed", { path, eventType });
  };

  watcher.on("add", publish("add"));
  watcher.on("change", publish("change"));
  watcher.on("unlink", publish("unlink"));
  watcher.on("error", (err: any) => {
    observation.logTelemetry("warn", "FilesystemWatcher", `Watcher error: ${err.message || err}`);
  });

  return {
    stop: () => {
      watcher.close();
    },
  };
}
```

- [ ] **Step 5: Run tests, verify pass, typecheck, commit**

Run: `npx tsc --noEmit && npm test`
Expected: no errors, all tests pass

```bash
git add src/core/filesystem-watcher.ts package.json package-lock.json tests/index.test.ts
git commit -m "feat: add a chokidar-based filesystem watcher publishing onto the event bus"
```

---

## Task 3: `/ws/events` WebSocket endpoint

**Files:**
- Modify: `src/server.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `EventBus` (Task 1)
- Produces: `GET /api/events-ticket` (browser clients), `WS /ws/events` (accepts either `?ticket=` query param for browser clients, or an `X-API-Key` header for Node clients)

- [ ] **Step 1: Add ticket issuance, mirroring the existing voice-ticket pattern exactly**

In `src/server.ts`, find the existing `VOICE_TICKET_TTL_MS`/`voiceTickets`/`issueVoiceTicket`/`consumeVoiceTicket`/`/api/voice-ticket` block (search for `issueVoiceTicket`). Immediately after it, add the parallel pattern for events tickets:

```typescript
// One-time tickets for /ws/events — same reasoning as the voice tickets
// above: a browser WebSocket handshake can't carry a custom X-API-Key
// header, so identity crosses via a short-lived, single-use ticket
// obtained through a normal authenticated POST instead.
const EVENTS_TICKET_TTL_MS = 30_000;
const eventsTickets = new Map<string, { username: string; expiresAt: number }>();

function issueEventsTicket(username: string): string {
  const now = Date.now();
  for (const [t, v] of eventsTickets) {
    if (v.expiresAt < now) eventsTickets.delete(t);
  }
  const ticket = crypto.randomBytes(24).toString("hex");
  eventsTickets.set(ticket, { username, expiresAt: now + EVENTS_TICKET_TTL_MS });
  return ticket;
}

function consumeEventsTicket(ticket: string): string | null {
  const entry = eventsTickets.get(ticket);
  eventsTickets.delete(ticket);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.username;
}

app.post("/api/events-ticket", validateApiKey, (req: any, res: any) => {
  res.json({ ticket: issueEventsTicket(req.username) });
});
```

- [ ] **Step 2: Add the `/ws/events` route**

Find the existing `voiceWss`/`/ws/voice` block (search for `new WebSocketServer`). Immediately after it, add:

```typescript
// A generic event stream: every EventBus publish, regardless of topic,
// gets forwarded to every connected client. Two auth paths, since the two
// kinds of client can't authenticate the same way: a browser page (the
// Electron window's frontend) can't set a custom header on a WebSocket
// handshake, so it authenticates via a single-use ticket exactly like
// /ws/voice does; a Node.js client (eww-bridge.ts, a real host process,
// not a browser) CAN set a header, so it authenticates via the permanent
// X-API-Key directly, matching how eww-adapter.ts already authenticates
// its HTTP polling today.
const eventsWss = new WebSocketServer({ server: httpServer, path: "/ws/events" });
eventsWss.on("connection", (ws, req) => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  const ticket = url.searchParams.get("ticket");
  const apiKeyHeader = req.headers["x-api-key"];

  let username: string | null = null;
  if (ticket) {
    username = consumeEventsTicket(ticket);
  } else if (typeof apiKeyHeader === "string" && apiKeyHeader === process.env.INTERNAL_API_KEY) {
    username = "admin";
  }

  if (!username) {
    ws.send(JSON.stringify({ type: "error", message: "Missing or invalid/expired events ticket, and no valid X-API-Key header." }));
    ws.close();
    return;
  }

  observation.logTelemetry("info", "EventsWs", `/ws/events connection opened for "${username}".`);
  const bus = EventBus.getInstance();
  const unsubscribers: Array<() => void> = [];
  // Forward every topic — a per-client topic allowlist/filter is left to
  // the client side (eww-bridge.ts only reacts to topics it cares about
  // and ignores the rest), not enforced server-side in this first version.
  const forward = (topic: string) => (payload: any) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "event", topic, payload }));
    }
  };
  // There's no bus-level "subscribe to everything" API by design (Task 1
  // keeps the bus's interface to per-topic subscribe/publish only) — this
  // route explicitly stays subscribed to the known Phase-1 topic set,
  // extended as new publishers are added in later tasks/phases.
  for (const topic of ["filesystem:changed", "system:anomaly"]) {
    unsubscribers.push(bus.subscribe(topic, forward(topic)));
  }

  ws.on("close", () => {
    for (const unsub of unsubscribers) unsub();
    observation.logTelemetry("info", "EventsWs", `/ws/events connection closed for "${username}".`);
  });
});
```

Note: `admin`'s API-key check reuses `INTERNAL_API_KEY` directly here (not `validateApiKey`, which is HTTP-middleware-shaped and doesn't apply to a raw WS upgrade request) — this mirrors the same direct-comparison pattern `auth-middleware.ts`'s `validateApiKey` itself uses internally for the admin bootstrap key. If this repo's `auth-middleware.ts` exposes a reusable exported helper for that comparison (check before writing new comparison logic — a `safeCompare`/`timingSafeEqual`-based helper, not a bare `===`, is the existing convention for comparing secrets), use it here instead of the bare `===` shown above; do not introduce a non-constant-time secret comparison if a safe one already exists to import.

- [ ] **Step 3: Write the tests**

Add to `tests/index.test.ts` (check the file's existing pattern for spawning a live test server on a free port and connecting a real client, matching how other HTTP-boundary tests in this file already do it):

```typescript
registerTest("HTTP Boundary", "WS /ws/events rejects a connection with no ticket and no valid API key", async () => {
  const port = 3019; // confirm this port isn't already used elsewhere in this file before committing
  const child = await spawnTestServer(port, { INTERNAL_API_KEY: TEST_ADMIN_API_KEY });
  try {
    const ws = new (await import("ws")).default(`ws://127.0.0.1:${port}/ws/events`);
    const result: any = await new Promise((resolve) => {
      ws.on("message", (data: any) => resolve(JSON.parse(data.toString())));
      ws.on("close", () => resolve({ closed: true }));
    });
    if (!result.closed && result.type !== "error") {
      throw new Error(`HTTP Boundary: expected an error or close for an unauthenticated /ws/events connection, got: ${JSON.stringify(result)}`);
    }
  } finally {
    await stopTestServer(child);
  }
});

registerTest("HTTP Boundary", "WS /ws/events accepts a connection with a valid X-API-Key header and forwards a real bus event", async () => {
  const port = 3020;
  const child = await spawnTestServer(port, { INTERNAL_API_KEY: TEST_ADMIN_API_KEY });
  try {
    const WebSocketCtor = (await import("ws")).default;
    const ws = new WebSocketCtor(`ws://127.0.0.1:${port}/ws/events`, { headers: { "X-API-Key": TEST_ADMIN_API_KEY } });
    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    ws.close();
  } finally {
    await stopTestServer(child);
  }
});
```

The second test only confirms the connection is accepted (a full end-to-end "publish a real event on the server process and observe it arrive over this exact socket" test needs the server process to expose a way to trigger a publish, which isn't available from outside the spawned child process in this test harness's existing pattern — check how other tests in this file handle verifying server-internal behavior they can't directly call into, and follow that same convention; if no such pattern exists yet, a connection-accepted assertion is the correct scope for this task, and forwarding correctness is implicitly covered by Task 1's own unit tests plus this task's manual verification step below).

- [ ] **Step 4: Manual verification**

Start the dev server for real, obtain an events ticket via `curl -X POST localhost:3000/api/events-ticket -H "X-API-Key: <your admin key>"`, connect a WebSocket client (e.g. `wscat -c "ws://localhost:3000/ws/events?ticket=<ticket>"`) and confirm it stays open; separately touch a file in a directory the filesystem watcher covers (once Task 2's watcher is actually wired up to real paths in a later task) and confirm a `filesystem:changed` event arrives over the socket.

- [ ] **Step 5: Run tests, typecheck, commit**

Run: `npx tsc --noEmit && npm test`
Expected: no errors, all tests pass

```bash
git add src/server.ts tests/index.test.ts
git commit -m "feat: add /ws/events WebSocket endpoint forwarding EventBus publishes"
```

---

## Task 4: Wire the filesystem watcher into `server.ts`

**Files:**
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `startFilesystemWatcher` (Task 2)

- [ ] **Step 1: Start the watcher at server startup**

Find where other startup jobs are started in `server.ts` (near `scheduler.startEmailWatchJob()` and similar calls). Add:

```typescript
// Publishes filesystem:changed onto the event bus for anything watching
// via /ws/events — replaces cron-style polling for filesystem-driven
// reactions. Scoped to JARVIS_FILES_DIR (the same directory
// src/capabilities/providers/files.ts already treats as the one safe,
// scoped root) rather than the whole repo or filesystem.
if (process.env.JARVIS_FILES_DIR) {
  startFilesystemWatcher([process.env.JARVIS_FILES_DIR]);
} else {
  observation.logTelemetry("warn", "FilesystemWatcher", "JARVIS_FILES_DIR not set — filesystem watching disabled.");
}
```

Add the corresponding import: `import { startFilesystemWatcher } from "./core/filesystem-watcher.js";`

- [ ] **Step 2: Typecheck, run tests**

Run: `npx tsc --noEmit && npm test`
Expected: no errors, all tests pass

- [ ] **Step 3: Manual verification**

Start the dev server with `JARVIS_FILES_DIR` set to a real directory, connect a `/ws/events` client (per Task 3's manual verification), create/modify/delete a file in that directory, and confirm a real `filesystem:changed` event arrives over the socket with the correct path and event type.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat: start the filesystem watcher at server startup, scoped to JARVIS_FILES_DIR"
```

---

## Task 5: `eww-bridge.ts` — replaces `eww-adapter.ts`

**Files:**
- Create: `src/ipc/eww-bridge.ts`
- Delete: `src/system/eww-adapter.ts`
- Modify: `deploy/jarvis-hud-eww.service`
- Modify: `scripts/install-eww.sh`

**Interfaces:**
- Consumes: `WS /ws/events` (Task 3), the existing `GET /api/hud/status` endpoint (unchanged)

- [ ] **Step 1: Read the existing service/install files first**

Read `deploy/jarvis-hud-eww.service` and `scripts/install-eww.sh` in full to see exactly how they currently reference `eww-adapter.ts`/its compiled/run form, so Step 3's edit matches the real current invocation (ts-node? a compiled .js path? a specific working directory?) rather than guessing.

- [ ] **Step 2: Create `eww-bridge.ts`**

Create `src/ipc/eww-bridge.ts`:

```typescript
// src/ipc/eww-bridge.ts
//
// Replaces src/system/eww-adapter.ts. Runs on the bare host exactly like
// the file it replaces (Eww needs a real X11/Wayland connection the
// Docker container doesn't have) — same deployment story, same
// dependency-light intent, but connects to /ws/events as a real-time
// trigger instead of polling the HUD status endpoint on a fixed 2-second
// timer regardless of whether anything actually changed. A Node.js
// WebSocket client (unlike a browser) can set a custom header on the
// handshake, so this authenticates via the permanent X-API-Key directly —
// no ticket dance needed, matching how eww-adapter.ts already
// authenticated its HTTP polling.

import { execFile } from "child_process";
import WebSocket from "ws";

const EVENTS_WS_URL = process.env.JARVIS_EVENTS_WS_URL || "ws://localhost:3000/ws/events";
const STATUS_URL = process.env.JARVIS_HUD_URL || "http://localhost:3000/api/hud/status";
const API_KEY = process.env.JARVIS_API_KEY || "";
// A safety-net refresh independent of any bus event, in case a relevant
// mutation ever happens without a corresponding filesystem:changed /
// system:anomaly publish reaching this bridge (e.g. a gap in what
// currently publishes onto the bus) — much less frequent than
// eww-adapter.ts's old 2-second poll, since real events are now the
// primary trigger, not the only one.
const FALLBACK_REFRESH_MS = 30_000;

function ewwUpdate(pairs: Record<string, string>): void {
  const args = ["update", ...Object.entries(pairs).map(([k, v]) => `${k}=${v}`)];
  execFile("eww", args, { timeout: 3000 }, (err) => {
    if (err) {
      console.error(`[eww-bridge] eww update failed: ${err.message}`);
    }
  });
}

async function refreshStatus(): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(STATUS_URL, {
      headers: API_KEY ? { "X-API-Key": API_KEY } : {},
      signal: controller.signal,
    });
    if (!res.ok) {
      ewwUpdate({ jarvis_badge: "error", jarvis_status: JSON.stringify("Unreachable"), jarvis_thought: JSON.stringify("HUD endpoint returned an error."), jarvis_task: JSON.stringify("Unknown"), jarvis_notes: JSON.stringify("") });
      return;
    }
    const data = await res.json();
    ewwUpdate({
      jarvis_badge: data.badge || "idle",
      jarvis_status: JSON.stringify(data.statusLabel || ""),
      jarvis_thought: JSON.stringify((data.thoughtLines || []).join("\n")),
      jarvis_task: JSON.stringify(data.activeTask || "None"),
      jarvis_notes: JSON.stringify((data.recentNotes || []).map((n: any) => n.title).join("\n") || "None yet"),
    });
  } catch (err: any) {
    ewwUpdate({ jarvis_badge: "error", jarvis_status: JSON.stringify("Unreachable"), jarvis_thought: JSON.stringify(`Cannot reach Jarvis: ${err.message}`), jarvis_task: JSON.stringify("Unknown"), jarvis_notes: JSON.stringify("") });
  } finally {
    clearTimeout(timeoutId);
  }
}

function connect(): void {
  const ws = new WebSocket(EVENTS_WS_URL, { headers: API_KEY ? { "X-API-Key": API_KEY } : {} });

  ws.on("open", () => {
    console.error("[eww-bridge] connected to /ws/events");
    refreshStatus(); // hydrate immediately on connect, don't wait for the first event
  });

  ws.on("message", (data: any) => {
    let parsed: any;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (parsed?.type === "event") {
      refreshStatus();
    }
  });

  ws.on("close", () => {
    console.error("[eww-bridge] /ws/events connection closed, reconnecting in 5s");
    setTimeout(connect, 5000);
  });

  ws.on("error", (err: any) => {
    console.error(`[eww-bridge] WebSocket error: ${err.message}`);
  });
}

connect();
setInterval(refreshStatus, FALLBACK_REFRESH_MS);

function shutdown(signal: string): void {
  console.error(`[eww-bridge] received ${signal}, stopping.`);
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
```

- [ ] **Step 3: Update the systemd unit and install script**

Based on what Step 1's read revealed, update `deploy/jarvis-hud-eww.service` and `scripts/install-eww.sh` to reference `src/ipc/eww-bridge.ts` (or its compiled output path, matching whatever the existing files actually pointed at for `eww-adapter.ts`) instead of the old file. Add `JARVIS_EVENTS_WS_URL` to any environment documentation the service file or script already carries for `JARVIS_HUD_URL`/`JARVIS_API_KEY`.

- [ ] **Step 4: Delete the old adapter**

```bash
rm src/system/eww-adapter.ts
```

- [ ] **Step 5: Typecheck, run tests**

Run: `npx tsc --noEmit && npm test`
Expected: no errors, all tests pass

- [ ] **Step 6: Manual verification**

With the dev server running and a real EWW window open (or `eww` installed and available on PATH), run `npx tsx src/ipc/eww-bridge.ts` directly, confirm it connects, hydrates the HUD on startup, and updates again when a real `filesystem:changed` event fires (per Task 4's manual verification setup).

- [ ] **Step 7: Commit**

```bash
git add src/ipc/eww-bridge.ts deploy/jarvis-hud-eww.service scripts/install-eww.sh
git rm src/system/eww-adapter.ts
git commit -m "feat: replace eww-adapter.ts's polling with eww-bridge.ts's event-driven push"
```

---

## Final check

- [ ] Run `npx tsc --noEmit && npm test` one more time end to end.
- [ ] Confirm `grep -rn "eww-adapter" src/ deploy/ scripts/` finds no remaining references (everything should point at `eww-bridge.ts` now).
- [ ] Confirm the full manual verification chain works together: dev server running, `eww-bridge.ts` running, a real file change in `JARVIS_FILES_DIR` triggers a real `eww update` call within a couple of seconds — not the old fixed 2-second poll, a genuine reaction to the actual change.
- [ ] This plan deliberately does not touch the voice pipeline, whisper-cpp, the TTS service, or `live-voice.ts` — those are the separate, later voice-daemon plan per the parent spec's own scoping. Confirm nothing in this plan's diff touches those files.
