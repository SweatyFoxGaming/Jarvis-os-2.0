import { spawn, ChildProcess } from "child_process";
import net from "net";
import path from "path";
import { registerTest } from "./registry.js";

// Same idea as the main repo's "HTTP Boundary" tests: spawn the real process
// and hit real HTTP endpoints, rather than only unit-testing in isolation —
// this is the one place that would have caught the process failing to boot
// at all. Deliberately stays on the safe side of createWorkspace's actual
// Docker/git work: every case below is rejected by server.ts's own
// validation or its X-Builder-Secret auth gate before workspace.ts's
// createWorkspace/execInWorkspace/destroyWorkspace ever runs.

const PORT = 4100; // hardcoded in server.ts, not configurable
const TEST_SECRET = "test-only-jarvis-builder-secret-not-real";

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}

registerTest("HTTP Boundary", "jarvis-builder boots and gates every route except /health behind X-Builder-Secret", async () => {
  const alreadyRunning = await isPortInUse(PORT);
  let child: ChildProcess | null = null;
  let spawnError: Error | null = null;
  if (!alreadyRunning) {
    // Spawns the tsx binary directly rather than through the `npx` wrapper:
    // killing the npx process leaves the real tsx/node process it launches
    // still listening — the same orphaned-process bug already found and
    // fixed for the main repo's own calendar-OAuth HTTP Boundary test.
    child = spawn(path.join(process.cwd(), "node_modules", ".bin", "tsx"), ["server.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, JARVIS_BUILDER_SECRET: TEST_SECRET },
      stdio: "ignore",
    });
    // Without a listener, a spawn-level failure (e.g. the tsx binary itself
    // missing) fires ChildProcess's 'error' event with nothing attached,
    // which Node treats as an unhandled error and crashes the whole test
    // runner instead of failing just this one test. Recorded here and
    // surfaced below via the readiness-timeout message, rather than thrown
    // directly from this handler — it can fire after the try block has
    // already moved on.
    child.on("error", (err) => { spawnError = err; });
  }
  const knowsSecret = !alreadyRunning;

  try {
    const deadline = Date.now() + 25_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (spawnError) throw new Error(`jarvis-builder failed to spawn: ${(spawnError as Error).message}`);
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/health`);
        if (res.status === 200) { ready = true; break; }
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!ready) throw new Error(`jarvis-builder never became reachable on :${PORT}/health`);

    const noSecretPost = await fetch(`http://127.0.0.1:${PORT}/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ buildRequestId: 1, baseBranch: "main" }),
    });
    if (noSecretPost.status !== 401) {
      throw new Error(`expected 401 with no X-Builder-Secret on POST /workspaces, got ${noSecretPost.status}`);
    }

    const noSecretExec = await fetch(`http://127.0.0.1:${PORT}/workspaces/1/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo hi" }),
    });
    if (noSecretExec.status !== 401) {
      throw new Error(`expected 401 with no X-Builder-Secret on POST /workspaces/1/exec, got ${noSecretExec.status}`);
    }

    const noSecretDelete = await fetch(`http://127.0.0.1:${PORT}/workspaces/1`, { method: "DELETE" });
    if (noSecretDelete.status !== 401) {
      throw new Error(`expected 401 with no X-Builder-Secret on DELETE /workspaces/1, got ${noSecretDelete.status}`);
    }

    const noSecretChatExec = await fetch(`http://127.0.0.1:${PORT}/chat-sandboxes/testuser/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo hi" }),
    });
    if (noSecretChatExec.status !== 401) {
      throw new Error(`expected 401 with no X-Builder-Secret on POST /chat-sandboxes/testuser/exec, got ${noSecretChatExec.status}`);
    }

    const noSecretChatDelete = await fetch(`http://127.0.0.1:${PORT}/chat-sandboxes/testuser`, { method: "DELETE" });
    if (noSecretChatDelete.status !== 401) {
      throw new Error(`expected 401 with no X-Builder-Secret on DELETE /chat-sandboxes/testuser, got ${noSecretChatDelete.status}`);
    }

    if (!knowsSecret) return; // rest needs this test's own known JARVIS_BUILDER_SECRET

    const secretHeaders = { "X-Builder-Secret": TEST_SECRET, "Content-Type": "application/json" };

    const missingBuildRequestId = await fetch(`http://127.0.0.1:${PORT}/workspaces`, {
      method: "POST",
      headers: secretHeaders,
      body: JSON.stringify({ baseBranch: "main" }),
    });
    if (missingBuildRequestId.status !== 400) {
      throw new Error(`expected 400 for a missing buildRequestId, got ${missingBuildRequestId.status}`);
    }

    const negativeBuildRequestId = await fetch(`http://127.0.0.1:${PORT}/workspaces`, {
      method: "POST",
      headers: secretHeaders,
      body: JSON.stringify({ buildRequestId: -1, baseBranch: "main" }),
    });
    if (negativeBuildRequestId.status !== 400) {
      throw new Error(`expected 400 for a negative buildRequestId, got ${negativeBuildRequestId.status}`);
    }

    const missingBaseBranch = await fetch(`http://127.0.0.1:${PORT}/workspaces`, {
      method: "POST",
      headers: secretHeaders,
      body: JSON.stringify({ buildRequestId: 1 }),
    });
    if (missingBaseBranch.status !== 400) {
      throw new Error(`expected 400 for a missing baseBranch, got ${missingBaseBranch.status}`);
    }

    const invalidWorkspaceId = await fetch(`http://127.0.0.1:${PORT}/workspaces/not-a-number/exec`, {
      method: "POST",
      headers: secretHeaders,
      body: JSON.stringify({ command: "echo hi" }),
    });
    if (invalidWorkspaceId.status !== 400) {
      throw new Error(`expected 400 for a non-numeric workspace id, got ${invalidWorkspaceId.status}`);
    }

    const missingCommand = await fetch(`http://127.0.0.1:${PORT}/workspaces/1/exec`, {
      method: "POST",
      headers: secretHeaders,
      body: JSON.stringify({}),
    });
    if (missingCommand.status !== 400) {
      throw new Error(`expected 400 for a missing command, got ${missingCommand.status}`);
    }

    const unsafeChatKey = await fetch(`http://127.0.0.1:${PORT}/chat-sandboxes/${encodeURIComponent("../etc/passwd")}/exec`, {
      method: "POST",
      headers: secretHeaders,
      body: JSON.stringify({ command: "echo hi" }),
    });
    if (unsafeChatKey.status !== 400) {
      throw new Error(`expected 400 for an unsafe chat sandbox key, got ${unsafeChatKey.status}`);
    }

    const missingChatCommand = await fetch(`http://127.0.0.1:${PORT}/chat-sandboxes/testuser/exec`, {
      method: "POST",
      headers: secretHeaders,
      body: JSON.stringify({}),
    });
    if (missingChatCommand.status !== 400) {
      throw new Error(`expected 400 for a missing command on a chat sandbox exec, got ${missingChatCommand.status}`);
    }

    const unsafeChatDeleteKey = await fetch(`http://127.0.0.1:${PORT}/chat-sandboxes/${encodeURIComponent("evil; rm -rf /")}`, {
      method: "DELETE",
      headers: secretHeaders,
    });
    if (unsafeChatDeleteKey.status !== 400) {
      throw new Error(`expected 400 for an unsafe chat sandbox key on delete, got ${unsafeChatDeleteKey.status}`);
    }
  } finally {
    if (child && child.exitCode === null && !child.killed) {
      child.kill(); // SIGTERM
      const exited = await new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(false), 5000);
        child!.once("exit", () => {
          clearTimeout(timeout);
          resolve(true);
        });
      });
      // tsx/node ignoring SIGTERM (e.g. wedged in a slow require) would
      // otherwise leave this process running forever — escalate exactly
      // once rather than retrying SIGTERM in a loop.
      if (!exited) child.kill("SIGKILL");
    }
  }
});
