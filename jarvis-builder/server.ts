import express from "express";

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

const PORT = 4100;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[jarvis-builder] listening on port ${PORT}`);
});
