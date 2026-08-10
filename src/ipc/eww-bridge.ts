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
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import WebSocket from "ws";

// This file compiles to ESM (repo package.json has "type": "module", and
// tsc --module nodenext follows that for a plain .ts source) -- __dirname
// isn't available for free the way it would be under CommonJS, so it's
// derived from import.meta.url instead, same as any other ESM module that
// needs to locate a file next to its own compiled output.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EVENTS_WS_URL = process.env.JARVIS_EVENTS_WS_URL || "ws://localhost:3000/ws/events";
const STATUS_URL = process.env.JARVIS_HUD_URL || "http://localhost:3000/api/hud/status";
// A dedicated URL (not derived from STATUS_URL) so either can be overridden
// independently, same as EVENTS_WS_URL/STATUS_URL already are.
const REPORT_VERSION_URL = process.env.JARVIS_HUD_REPORT_VERSION_URL || "http://localhost:3000/api/hud/report-version";
const API_KEY = process.env.JARVIS_API_KEY || "";
// Re-report periodically (not just once at connect) so a long-running
// bridge process keeps confirming it's genuinely still alive, and so a
// restarted api process (which loses its in-memory last-reported version --
// see health-watchdog.ts's own comment on why that's in-memory only) gets
// repopulated within a bounded time, without requiring a fresh deploy.
//
// This interval MUST stay well under health-watchdog.ts's
// STALE_GRACE_PERIOD_MS (30 minutes), which is how long the server waits
// before concluding a bridge that has stopped reporting "may have stopped
// running". It was previously 60 minutes -- LONGER than the grace period --
// which meant a perfectly healthy bridge was flagged as possibly-dead for
// roughly the second half of every single hour, forever. 5 minutes leaves a
// 6x margin: six consecutive reports have to fail before the server draws
// any conclusion, and the real journal shows individual reports genuinely
// do fail transiently (ECONNREFUSED while the api container restarts).
const VERSION_REPORT_INTERVAL_MS = 5 * 60 * 1000;

// Read once at this process's own startup: deploy-hud.sh always restarts
// jarvis-hud.service after writing a fresh VERSION file (systemctl --user
// restart), so a running bridge process's own compiled-in SHA never changes
// out from under it -- rereading on every periodic report would just be
// extra I/O for a value that's already pinned for this process's lifetime.
// A missing file (an older, pre-this-change deployment) reports null rather
// than throwing.
const OWN_VERSION_SHA: string | null = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, "VERSION"), "utf8").trim() || null;
  } catch {
    return null;
  }
})();
// A safety-net refresh independent of any bus event, in case a relevant
// mutation ever happens without a corresponding filesystem:changed /
// system:anomaly publish reaching this bridge (e.g. a gap in what
// currently publishes onto the bus) — much less frequent than
// eww-adapter.ts's old 2-second poll, since real events are now the
// primary trigger, not the only one.
const FALLBACK_REFRESH_MS = 30_000;
// Trailing-edge debounce for event-triggered refreshes: a bulk filesystem
// operation (git checkout, unzip, editor save-storm) can fan out to
// hundreds of forwarded events in quick succession, and each one used to
// trigger its own fetch + eww subprocess spawn. Coalesce a burst into a
// single refreshStatus() call shortly after the burst ends, rather than
// resetting/extending the timer on every event (which could starve a
// continuous stream of updates indefinitely).
const EVENT_DEBOUNCE_MS = 250;
let eventDebounceTimer: NodeJS.Timeout | null = null;

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
      console.error(`[eww-bridge] HUD endpoint returned ${res.status}`);
      ewwUpdate({ jarvis_badge: "error" });
      return;
    }
    const data = await res.json();
    // Only jarvis_badge is pushed: it's the only defvar eww.yuck's
    // orb-only widget actually renders (badge-class drives which
    // orb-state class is applied). statusLabel/thoughtLines/activeTask/
    // recentNotes used to be pushed here too (jarvis_status/
    // jarvis_thought/jarvis_task/jarvis_notes), back when the HUD had a
    // text panel — Task 7 confirmed nothing in the current yuck reads
    // them anymore and trimmed the pushes; see eww.yuck's own comment
    // for the matching defvar removal. Failure detail that used to be
    // pushed into jarvis_thought for on-HUD display now just goes to
    // stderr (journalctl --user -u jarvis-hud.service) since there's no
    // longer a text surface to show it on.
    ewwUpdate({ jarvis_badge: data.badge || "idle" });
  } catch (err: any) {
    console.error(`[eww-bridge] refreshStatus failed: ${err.message}`);
    ewwUpdate({ jarvis_badge: "error" });
  } finally {
    clearTimeout(timeoutId);
  }
}

// Self-reports this process's own compiled-in VERSION SHA to the api server
// so health-watchdog.ts's companion-staleness check has something real to
// compare against the repo's actual current HEAD. Deliberately skips the
// call entirely (rather than posting a null sha) when OWN_VERSION_SHA is
// null -- an old, pre-this-change deployment with no VERSION file is
// indistinguishable from "not reporting", which is exactly the honest,
// correctly-flagged state for it to land in server-side.
async function reportVersion(): Promise<void> {
  if (!OWN_VERSION_SHA) return;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(REPORT_VERSION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { "X-API-Key": API_KEY } : {}),
      },
      body: JSON.stringify({ sha: OWN_VERSION_SHA }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[eww-bridge] report-version endpoint returned ${res.status}`);
    }
  } catch (err: any) {
    console.error(`[eww-bridge] reportVersion failed: ${err.message}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

function connect(): void {
  const ws = new WebSocket(EVENTS_WS_URL, { headers: API_KEY ? { "X-API-Key": API_KEY } : {} });

  ws.on("open", () => {
    console.error("[eww-bridge] connected to /ws/events");
    refreshStatus(); // hydrate immediately on connect, don't wait for the first event
    // Re-report the version on EVERY successful connection, not just once at
    // process startup. A connection opening is the strongest available
    // signal that the api server is up and reachable again -- which is
    // exactly when an earlier report that failed with ECONNREFUSED/404
    // (observed for real in the journal) can finally succeed. Without this,
    // a failed report just sat there until the next periodic timer fired,
    // and the server-side staleness check reported a false "may not be
    // running" in the meantime. Also covers the api-restart case: the api
    // loses its in-memory last-reported version on restart, and the same
    // restart drops this WebSocket, so reconnect repopulates it immediately.
    reportVersion();
  });

  ws.on("message", (data: any) => {
    let parsed: any;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (parsed?.type === "event") {
      if (!eventDebounceTimer) {
        eventDebounceTimer = setTimeout(() => {
          eventDebounceTimer = null;
          refreshStatus();
        }, EVENT_DEBOUNCE_MS);
      }
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
reportVersion();
setInterval(reportVersion, VERSION_REPORT_INTERVAL_MS);

function shutdown(signal: string): void {
  console.error(`[eww-bridge] received ${signal}, stopping.`);
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
