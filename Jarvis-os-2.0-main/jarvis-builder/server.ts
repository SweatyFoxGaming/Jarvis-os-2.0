import express from "express";
import crypto from "crypto";
import {
  createWorkspace,
  execInWorkspace,
  destroyWorkspace,
  ensureSandboxImage,
  startReaper,
  reconcileWorkspaceReservations,
  WorkspaceCapacityError,
  execInChatSandbox,
  destroyChatSandbox,
  assertSafeSandboxKey,
  reconcileChatSandboxes,
  startChatSandboxReaper,
} from "./workspace.js";

const app = express();
app.use(express.json());

const SECRET = process.env.JARVIS_BUILDER_SECRET;
if (!SECRET || SECRET.length < 16) {
  console.error("[jarvis-builder] JARVIS_BUILDER_SECRET is not set (or too short) — refusing to start.");
  process.exit(1);
}

// Plain !== on a secret is subject to a timing attack in theory (string
// comparison short-circuits on the first mismatched byte) — matters more
// here than most: this is the one process in the stack with access to the
// host's Docker socket, so a timing side-channel here is a path straight
// to that. Compares equal-length buffers either way so the time taken
// doesn't leak how many leading characters of a guess were correct.
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// Every route below this line requires the shared secret — this service
// sits on the internal Docker network only (never published to the host),
// but the secret is a deliberate second layer: this is the one process in
// the whole stack with access to the host's Docker socket, so it doesn't
// get to rely on network placement alone.
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const provided = req.headers["x-builder-secret"];
  if (typeof provided !== "string" || !safeCompare(provided, SECRET)) {
    return res.status(401).json({ error: "Missing or invalid X-Builder-Secret header." });
  }
  next();
});

app.get("/health", (_req, res) => {
  res.json({ status: "up" });
});

app.post("/workspaces", async (req, res) => {
  const { buildRequestId, baseBranch } = req.body || {};
  if (typeof buildRequestId !== "number" || !Number.isInteger(buildRequestId) || buildRequestId <= 0) {
    return res.status(400).json({ error: "buildRequestId must be a positive integer." });
  }
  if (typeof baseBranch !== "string" || !baseBranch.trim()) {
    return res.status(400).json({ error: "baseBranch is required." });
  }
  try {
    const workspace = await createWorkspace(buildRequestId, baseBranch.trim());
    res.json(workspace);
  } catch (err: any) {
    // 503, not 500: the sandbox cap being full is expected backpressure a
    // caller/monitoring should be able to tell apart from a genuine
    // internal failure, not the same generic error either would produce.
    const status = err instanceof WorkspaceCapacityError ? 503 : 500;
    res.status(status).json({ error: err.message || String(err) });
  }
});

app.post("/workspaces/:id/exec", async (req, res) => {
  const buildRequestId = Number(req.params.id);
  const { command } = req.body || {};
  if (!Number.isInteger(buildRequestId) || buildRequestId <= 0) {
    return res.status(400).json({ error: "Invalid workspace id." });
  }
  if (typeof command !== "string" || !command.trim()) {
    return res.status(400).json({ error: "command is required." });
  }
  try {
    const result = await execInWorkspace(buildRequestId, command);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.delete("/workspaces/:id", async (req, res) => {
  const buildRequestId = Number(req.params.id);
  if (!Number.isInteger(buildRequestId) || buildRequestId <= 0) {
    return res.status(400).json({ error: "Invalid workspace id." });
  }
  try {
    await destroyWorkspace(buildRequestId);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// Ad-hoc chat sandboxes — no buildRequestId, no baseBranch, no approval
// lifecycle. Keyed by a caller-supplied string (the main app passes the
// requesting username); get-or-create semantics mean the caller never has
// to make a separate "create" call before its first exec.
app.post("/chat-sandboxes/:key/exec", async (req, res) => {
  const { key } = req.params;
  const { command } = req.body || {};
  try {
    assertSafeSandboxKey(key);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
  if (typeof command !== "string" || !command.trim()) {
    return res.status(400).json({ error: "command is required." });
  }
  try {
    const result = await execInChatSandbox(key, command);
    res.json(result);
  } catch (err: any) {
    const status = err instanceof WorkspaceCapacityError ? 503 : 500;
    res.status(status).json({ error: err.message || String(err) });
  }
});

app.delete("/chat-sandboxes/:key", async (req, res) => {
  const { key } = req.params;
  try {
    assertSafeSandboxKey(key);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
  try {
    await destroyChatSandbox(key);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

const PORT = 4100;

async function start(): Promise<void> {
  // Populates the in-memory concurrency-cap reservation from whatever
  // sandbox containers already exist in Docker — a restart of this process
  // doesn't destroy already-running containers from before it, so without
  // this the cap would start from zero and could be exceeded by however
  // many requests arrive before the 24h reaper eventually catches up. Runs
  // (and is awaited) before app.listen() below, not inside its callback:
  // the previous ordering let Express start accepting /workspaces requests
  // against the still-default-empty reservation set while this ran
  // concurrently in the background, wide open to exactly the
  // over-admission this whole cap exists to prevent. createWorkspace()
  // also checks areReservationsReady() itself as a second, independent
  // guard against the same gap.
  await reconcileWorkspaceReservations();
  // Best-effort (see reconcileChatSandboxes' own comment) — not awaited
  // ahead of listen() the way the build-workspace reconciliation above is,
  // since chat sandboxes have no hard "block until this succeeds" gate to
  // race against.
  reconcileChatSandboxes();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[jarvis-builder] listening on port ${PORT}`);
  });

  // Started right after binding, before awaiting the (potentially
  // minutes-long) image build below: the reaper is what actually frees
  // expired reservations, so delaying it behind a cold image build would
  // needlessly leave the concurrency cap full for however long that build
  // takes, on top of not reaping any already-expired containers during
  // that window.
  startReaper();
  startChatSandboxReaper();

  // Not awaited before listen(): an image build can take minutes on a cold
  // start, and /health (and the reservation cap above) don't depend on it —
  // only createWorkspace()'s own `docker run` does, and that already fails
  // with a clear Docker-level error if the image isn't there yet.
  try {
    await ensureSandboxImage();
  } catch (err: any) {
    console.error(
      `[jarvis-builder] failed to ensure sandbox image is ready: ${err?.message || err}. ` +
        "Workspace creation will fail until this is resolved and the service is restarted."
    );
  }
}

start();
