// Deliberately NOT part of the build_requests / human-approval pipeline
// (see coding-agent.ts, autonomous_executive.ts). This module only
// re-runs the existing test suite in an isolated, ad-hoc sandbox
// (execInChatSandbox — no DB row, no build_request, no code change
// proposed or applied) and reports pass/fail. It never creates a
// workspace, never drafts code, never opens a PR. If a real fix is
// ever warranted, that still goes through the existing human-consult
// -> human-approval flow like everything else in this codebase.

import { EventBus } from "../core/event-bus.js";
import * as builderClient from "../kernel/builder-client.js";
import { ObservationPlatform } from "../kernel/observation.js";

const SANDBOX_KEY = "system-anomaly-verifier";
const VERIFY_COMMAND = "npm ci && npm test && npx tsc --noEmit";
const SUMMARY_MAX_CHARS = 500;

type ExecFn = (
  username: string,
  command: string
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/**
 * Subscribes to adaptation:analysis (Task 1); whenever hasHighSeverity is
 * true, re-runs the test suite in the already-existing ad-hoc chat sandbox
 * (execInChatSandbox — the same one run_sandbox_command in tools.ts uses,
 * keyed by a synthetic, non-colliding username so it can never collide with
 * a real logged-in user's chat sandbox) and reports pass/fail on
 * builder:shadow-verified. A failed attempt to even run the sandbox (e.g.
 * JARVIS_BUILDER_SECRET unset, jarvis-builder unreachable) is itself just a
 * reported fact via that same topic — never an unhandled rejection.
 *
 * execFn defaults to the real builderClient.execInChatSandbox; tests inject
 * a fake instead (Node's ESM module namespace objects are non-writable from
 * the importing side, so monkeypatching builderClient.execInChatSandbox
 * directly isn't possible — this optional parameter is the injection point).
 */
export function startShadowVerifier(
  execFn: ExecFn = builderClient.execInChatSandbox
): { stop: () => void } {
  const bus = EventBus.getInstance();
  const observation = ObservationPlatform.getInstance();

  const unsubscribe = bus.subscribe("adaptation:analysis", async (payload: any) => {
    if (!payload?.hasHighSeverity) return;

    try {
      const result = await execFn(SANDBOX_KEY, VERIFY_COMMAND);
      const combined = (result.stdout + result.stderr).slice(0, SUMMARY_MAX_CHARS);
      bus.publish("builder:shadow-verified", {
        timestamp: Date.now(),
        triggeredBy: "adaptation:analysis",
        passed: result.exitCode === 0,
        exitCode: result.exitCode,
        summary: combined,
      });
    } catch (err: any) {
      observation.logTelemetry("warn", "ShadowVerifier", `shadow verify failed to run: ${err.message}`);
      bus.publish("builder:shadow-verified", {
        timestamp: Date.now(),
        triggeredBy: "adaptation:analysis",
        passed: false,
        exitCode: -1,
        summary: `sandbox unavailable: ${err.message}`,
      });
    }
  });

  return { stop: unsubscribe };
}
