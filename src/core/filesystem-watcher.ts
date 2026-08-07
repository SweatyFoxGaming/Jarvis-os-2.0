import chokidar, { FSWatcher } from "chokidar";
import fs from "fs";
import path from "path";
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
  // Chokidar's own `ignoreInitial` decides what counts as "pre-existing"
  // purely by whether its async readdirp scan has finished — not by what
  // was on disk the instant this function was called. That scan doesn't
  // even start until the current synchronous stack unwinds, so a file
  // created immediately after this call (as in this codebase's own test,
  // and as would happen if a caller creates the watch dir then writes to
  // it right away) races the scan and gets swallowed as initial content
  // instead of surfacing as a live add — permanently, not just delayed.
  // Taking our own synchronous snapshot up front avoids trusting that
  // timing: anything not in the snapshot is a genuine new file no matter
  // when chokidar's scan happens to observe it.
  const preExisting = new Set<string>();
  for (const watchPath of watchPaths) {
    try {
      const entries = fs.readdirSync(watchPath, { recursive: true }) as string[];
      for (const entry of entries) {
        preExisting.add(path.join(watchPath, entry));
      }
    } catch {
      // watchPath may not exist yet or may itself be a file — chokidar's
      // own "error" handler below covers reporting that.
    }
  }

  const watcher: FSWatcher = chokidar.watch(watchPaths, {
    ignored: /(^|[/\\])\.|node_modules/,
    persistent: true,
    ignoreInitial: false,
  });

  const publish = (eventType: FilesystemChangedPayload["eventType"]) => (filePath: string) => {
    if (eventType === "add" && preExisting.has(filePath)) return;
    bus.publish<FilesystemChangedPayload>("filesystem:changed", { path: filePath, eventType });
  };

  watcher.on("add", publish("add"));
  watcher.on("change", publish("change"));
  watcher.on("unlink", (filePath: string) => {
    // Prune from the startup snapshot so a later recreate at this same path
    // is treated as a genuine new "add" instead of being silently
    // suppressed forever by the preExisting check above. Also keeps the
    // Set from growing unbounded over the process lifetime.
    preExisting.delete(filePath);
    publish("unlink")(filePath);
  });
  watcher.on("error", (err: any) => {
    observation.logTelemetry("warn", "FilesystemWatcher", `Watcher error: ${err.message || err}`);
  });

  return {
    stop: () => {
      watcher.close();
    },
  };
}
