import { EventBus } from "../core/event-bus.js";
import { analyzeArchitecture, analyzeQuality, analyzeSecurity, AnalysisResult } from "./analyzer.js";

/**
 * Debounced filesystem:changed -> adaptation:analysis bridge. Re-runs the
 * (fast, source-only) static-analysis trio after a burst of filesystem
 * changes settles, instead of on every individual event — a save-triggered
 * multi-file write (formatter, git checkout, etc.) would otherwise fire the
 * full analysis pass once per touched file.
 *
 * analyzePerformance() is deliberately excluded: it reads live request
 * telemetry (src/kernel/observation.ts), not source files, so a
 * filesystem-triggered re-run of it would be meaningless. It stays on the
 * existing daily-adaptation cycle only (src/adaptation/daily-adaptation.ts).
 */

export interface LiveAnalysisOptions {
  debounceMs?: number;
}

export function startLiveAnalysis(opts: LiveAnalysisOptions = {}): { stop: () => void } {
  const debounceMs = opts.debounceMs ?? 5000;
  const bus = EventBus.getInstance();

  let timer: NodeJS.Timeout | null = null;

  function runAnalysis() {
    timer = null;
    const architecture: AnalysisResult = analyzeArchitecture();
    const quality: AnalysisResult = analyzeQuality();
    const security: AnalysisResult = analyzeSecurity();

    const hasHighSeverity =
      architecture.issues.some((i) => i.severity === "high") ||
      quality.issues.some((i) => i.severity === "high") ||
      security.issues.some((i) => i.severity === "high");

    bus.publish("adaptation:analysis", {
      timestamp: Date.now(),
      architecture,
      quality,
      security,
      hasHighSeverity,
    });
  }

  const unsubscribe = bus.subscribe("filesystem:changed", () => {
    // Trailing-edge debounce: the first event in a burst arms the timer;
    // later events in the same burst are no-ops — a continuous stream still
    // flushes every debounceMs instead of the timer being reset/extended
    // and starving forever.
    if (!timer) {
      timer = setTimeout(runAnalysis, debounceMs);
    }
  });

  return {
    stop: () => {
      unsubscribe();
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
