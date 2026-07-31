// src/system/eww-adapter.ts
//
// Runs on the bare host (NOT inside Docker — Eww needs a real X11/Wayland
// connection the container doesn't have). Polls the backend's HUD status
// endpoint over the port already exposed to the host by docker-compose
// (no new IPC surface) and pushes each field into the running `eww`
// daemon via `eww update`. Deliberately dependency-free (only Node
// built-ins: fetch, child_process) so it runs with plain `node
// eww-adapter.js` on the host — no project node_modules required.

import { execFile } from "child_process";

const POLL_INTERVAL_MS = 2000;
const STATUS_URL = process.env.JARVIS_HUD_URL || "http://localhost:3000/api/hud/status";
const API_KEY = process.env.JARVIS_API_KEY || "";

function ewwUpdate(pairs: Record<string, string>): void {
  const args = ["update", ...Object.entries(pairs).map(([k, v]) => `${k}=${v}`)];
  execFile("eww", args, (err) => {
    if (err) {
      // eww not running yet / window not open — this is expected before
      // `eww open jarvis-hud` has been run, and on every restart of the
      // eww daemon itself. Log once per failure, keep polling; don't crash
      // the adapter over a transient external-process error.
      console.error(`[eww-adapter] eww update failed: ${err.message}`);
    }
  });
}

async function pollOnce(): Promise<void> {
  try {
    const res = await fetch(STATUS_URL, {
      headers: API_KEY ? { "X-API-Key": API_KEY } : {},
    });
    if (!res.ok) {
      ewwUpdate({ jarvis_badge: "error", jarvis_status: "Unreachable", jarvis_thought: "HUD endpoint returned an error.", jarvis_note: "" });
      return;
    }
    const data = await res.json();
    ewwUpdate({
      jarvis_badge: data.badge || "idle",
      jarvis_status: JSON.stringify(data.statusLabel || ""),
      jarvis_thought: JSON.stringify((data.thoughtLines || []).join("\\n")),
      jarvis_note: JSON.stringify(data.lastNote ? data.lastNote.title : "None yet"),
    });
  } catch (err: any) {
    ewwUpdate({ jarvis_badge: "error", jarvis_status: "Unreachable", jarvis_thought: JSON.stringify(`Cannot reach Jarvis: ${err.message}`), jarvis_note: "" });
  }
}

let stopped = false;
async function loop(): Promise<void> {
  while (!stopped) {
    await pollOnce();
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

function shutdown(signal: string): void {
  console.error(`[eww-adapter] received ${signal}, stopping.`);
  stopped = true;
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

loop();
