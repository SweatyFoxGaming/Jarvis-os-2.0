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
//
// JARVIS_API_KEY here is a plain env var read (same as eww-adapter.ts
// before it), NOT the server's resolved ADMIN_API_KEY export from
// src/kernel/auth-middleware.ts (ADMIN_API_KEY || INTERNAL_API_KEY) — this
// script is standalone, run directly via node/tsx on the bare host, and
// deliberately doesn't import from the project's kernel code. It just
// sends whatever JARVIS_API_KEY the operator has configured; it's on the
// operator to make sure that value actually matches the server's real
// admin key (ADMIN_API_KEY if set, else INTERNAL_API_KEY) for the
// X-API-Key handshake in server.ts's /ws/events upgrade handler to accept
// it.

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
