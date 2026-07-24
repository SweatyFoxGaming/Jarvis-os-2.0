import express from "express";
import { createWorkspace, execInWorkspace, destroyWorkspace, ensureSandboxImage, startReaper } from "./workspace.js";

const app = express();
app.use(express.json());

const SECRET = process.env.JARVIS_BUILDER_SECRET;
if (!SECRET || SECRET.length < 16) {
  console.error("[jarvis-builder] JARVIS_BUILDER_SECRET is not set (or too short) — refusing to start.");
  process.exit(1);
}

// Every route below this line requires the shared secret — this service
// sits on the internal Docker network only (never published to the host),
// but the secret is a deliberate second layer: this is the one process in
// the whole stack with access to the host's Docker socket, so it doesn't
// get to rely on network placement alone.
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const provided = req.headers["x-builder-secret"];
  if (provided !== SECRET) {
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
    res.status(500).json({ error: err.message || String(err) });
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

const PORT = 4100;
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`[jarvis-builder] listening on port ${PORT}`);
  await ensureSandboxImage();
  startReaper();
});
