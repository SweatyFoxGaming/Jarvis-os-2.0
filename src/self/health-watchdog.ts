import * as net from "net";
import { pingDatabase } from "../kernel/state/db.js";
import { ObservationPlatform } from "../kernel/observation.js";
import { MindKernel } from "./kernel.js";

const observation = ObservationPlatform.getInstance();

// Real, honest checks -- these mirror what /health already does for
// Postgres (pingDatabase, bounded to 5s internally) plus two new direct
// reachability checks for the voice daemon and llama-cpp, following the
// same "connect and confirm, don't shell out" style. No Docker-socket
// access is used or needed -- see this plan's Global Constraints for why.

const SOCKET_CHECK_TIMEOUT_MS = 3000;
const HTTP_CHECK_TIMEOUT_MS = 3000;

export function checkSocketReachable(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, SOCKET_CHECK_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function checkHttpReachable(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok || res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface HealthWatchdogDeps {
  pingDatabase: typeof pingDatabase;
  getHealth: () => { status: string };
  checkSocketReachable: typeof checkSocketReachable;
  checkHttpReachable: typeof checkHttpReachable;
}

const defaultDeps: HealthWatchdogDeps = {
  pingDatabase,
  getHealth: () => observation.getHealth(),
  checkSocketReachable,
  checkHttpReachable,
};

export async function assessSystemHealth(
  deps: HealthWatchdogDeps = defaultDeps
): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];

  try {
    const dbOk = await deps.pingDatabase();
    if (!dbOk) problems.push("Postgres is unreachable.");
  } catch (err: any) {
    problems.push(`Postgres health check itself failed: ${err.message}`);
  }

  try {
    const voiceSocketPath = process.env.VOICE_DAEMON_SOCKET || "/tmp/jarvis-voice/voice.sock";
    const voiceOk = await deps.checkSocketReachable(voiceSocketPath);
    if (!voiceOk) problems.push(`Voice daemon is unreachable at ${voiceSocketPath}.`);
  } catch (err: any) {
    problems.push(`Voice daemon health check itself failed: ${err.message}`);
  }

  try {
    // localLlmEndpoint is NOT an env var: it's MindKernel's persisted-settings
    // system setting (Postgres system_settings.local_llm_endpoint, hydrated at
    // boot by MindKernel.hydrateFromDb(), live-editable via /api/settings —
    // see src/self/kernel.ts). Every other call site in this codebase
    // (server.ts, voice-session.ts, cognition-router.ts, settings-routes.ts)
    // reads it the same way, off the MindKernel singleton, never off
    // process.env. Reading a guessed LOCAL_LLM_ENDPOINT env var here would
    // silently check an always-empty URL and make this whole check useless.
    const llamaEndpoint = MindKernel.getInstance().localLlmEndpoint;
    if (llamaEndpoint) {
      const llamaOk = await deps.checkHttpReachable(llamaEndpoint);
      if (!llamaOk) problems.push(`llama-cpp is unreachable at ${llamaEndpoint}.`);
    }
  } catch (err: any) {
    problems.push(`llama-cpp health check itself failed: ${err.message}`);
  }

  return { ok: problems.length === 0, problems };
}
