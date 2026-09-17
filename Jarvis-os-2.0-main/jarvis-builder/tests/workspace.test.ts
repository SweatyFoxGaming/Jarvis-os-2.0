import { registerTest } from "./registry.js";
import { positiveIntegerEnv, assertSafeBranchName, assertSafeSandboxKey } from "../workspace.js";

// These are the two pure, side-effect-free pieces of workspace.ts's logic —
// everything else in that file shells out to git/docker and, critically,
// operates on REPO_HOST_PATH (defaulting to the real host checkout, not this
// worktree) via real `git worktree add`/`git branch -D` calls. Exercising
// createWorkspace/destroyWorkspace end-to-end here would mean either mutating
// whatever repo happens to be checked out at that path on whatever machine
// runs this suite, or requiring a scratch git repo + a full sandbox image
// build (minutes, on a cold cache) just to run `npm test`. Both are a worse
// trade than the coverage gap: this suite instead locks in the two things
// that are actually safe to assert without touching Docker or host git state
// — see server-auth.test.ts for the HTTP-layer validation that also runs
// before any of those side effects would occur.

registerTest("positiveIntegerEnv", "accepts a valid positive integer string", () => {
  const result = positiveIntegerEnv("5", 10);
  if (result !== 5) throw new Error(`expected 5, got ${result}`);
});

registerTest("positiveIntegerEnv", "falls back on a negative value — the exact bug class this exists to prevent", () => {
  const result = positiveIntegerEnv("-1", 10);
  if (result !== 10) throw new Error(`expected fallback 10 for a negative input, got ${result}`);
});

registerTest("positiveIntegerEnv", "falls back on zero", () => {
  const result = positiveIntegerEnv("0", 10);
  if (result !== 10) throw new Error(`expected fallback 10 for zero, got ${result}`);
});

registerTest("positiveIntegerEnv", "falls back on undefined (the unset-env-var case)", () => {
  const result = positiveIntegerEnv(undefined, 10);
  if (result !== 10) throw new Error(`expected fallback 10 for undefined, got ${result}`);
});

registerTest("positiveIntegerEnv", "falls back on a non-safe-integer value (e.g. 1e100)", () => {
  const result = positiveIntegerEnv("1e100", 10);
  if (result !== 10) throw new Error(`expected fallback 10 for 1e100, got ${result}`);
});

registerTest("assertSafeBranchName", "accepts an ordinary branch name", () => {
  assertSafeBranchName("main");
  assertSafeBranchName("feature/x-1.2_3");
});

registerTest("assertSafeBranchName", "rejects a name starting with '-' (argument-injection primitive)", () => {
  let threw = false;
  try {
    assertSafeBranchName("--upload-pack=/bin/sh");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected assertSafeBranchName to reject a leading '-'");
});

registerTest("assertSafeBranchName", "rejects a name with shell-meaningful characters", () => {
  let threw = false;
  try {
    assertSafeBranchName("main; rm -rf /");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected assertSafeBranchName to reject a name with unsafe characters");
});

// assertSafeSandboxKey is the one boundary that validates a chat sandbox
// key (in practice, a username with no character restrictions applied at
// registration — see users-repo.ts in the main app) before it's
// interpolated into a Docker container name and a filesystem path.
registerTest("assertSafeSandboxKey", "accepts an ordinary username", () => {
  assertSafeSandboxKey("admin");
  assertSafeSandboxKey("chad.adams-01");
});

registerTest("assertSafeSandboxKey", "rejects a key with shell/path-meaningful characters", () => {
  let threw = false;
  try {
    assertSafeSandboxKey("../../etc/passwd");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected assertSafeSandboxKey to reject a path-traversal-shaped key");
});

registerTest("assertSafeSandboxKey", "rejects a key with spaces or shell metacharacters", () => {
  let threw = false;
  try {
    assertSafeSandboxKey("evil; rm -rf /");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected assertSafeSandboxKey to reject a key with unsafe characters");
});

registerTest("assertSafeSandboxKey", "rejects an empty string", () => {
  let threw = false;
  try {
    assertSafeSandboxKey("");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected assertSafeSandboxKey to reject an empty key");
});

registerTest("assertSafeSandboxKey", "rejects a key longer than 64 characters", () => {
  let threw = false;
  try {
    assertSafeSandboxKey("a".repeat(65));
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected assertSafeSandboxKey to reject an over-length key");
});
