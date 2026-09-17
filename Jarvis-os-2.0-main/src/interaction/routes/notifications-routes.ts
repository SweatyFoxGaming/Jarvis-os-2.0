import { Router } from 'express';
import { validateApiKey } from "../../kernel/auth-middleware.js";
import * as scheduler from "../../kernel/scheduler.js";
import * as push from "../push.js";
import * as pushRepo from "../../kernel/state/push-subscriptions-repo.js";

export const notificationsRouter: Router = Router();

// Notifications Stream
notificationsRouter.get("/api/notifications/stream", validateApiKey, (req: any, res: any) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const sessionId = `session_${Math.random().toString(36).substring(2)}`;
  res.write(`event: connected\ndata: ${JSON.stringify({ session_id: sessionId, status: "connected" })}\n\n`);

  const interval = setInterval(() => {
    res.write(`event: ping\ndata: ${JSON.stringify({ timestamp: Date.now() / 1000 })}\n\n`);
  }, 30000);

  req.on("close", () => {
    clearInterval(interval);
  });
});

notificationsRouter.get("/api/notifications", validateApiKey, (req: any, res: any) => {
  const items = scheduler.getNotifications(req.username);
  res.json({
    notifications: items,
    count: items.length,
    unread_count: items.filter(n => !n.read).length,
  });
});

notificationsRouter.post("/api/notifications/mark_read", validateApiKey, (req: any, res: any) => {
  scheduler.markAllRead(req.username);
  res.json({ status: "success" });
});

// ---------- Web Push (PWA proactive notifications) ----------
// The public key is not a secret (it's sent to browser push services by
// design) — served unauthenticated so the client can subscribe before it
// necessarily has a validated session.
notificationsRouter.get("/api/push/vapid-public-key", (req: any, res: any) => {
  const key = push.getVapidPublicKey();
  if (!key) return res.status(503).json({ error: "Push notifications are not configured on this server." });
  res.json({ publicKey: key });
});

notificationsRouter.post("/api/push/subscribe", validateApiKey, async (req: any, res: any) => {
  const { endpoint, keys } = req.body?.subscription || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: "A valid PushSubscription object is required." });
  }
  try {
    await pushRepo.addSubscription(req.username, endpoint, keys.p256dh, keys.auth);
    res.json({ status: "subscribed" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

notificationsRouter.post("/api/push/unsubscribe", validateApiKey, async (req: any, res: any) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: "endpoint is required" });
  try {
    await pushRepo.removeSubscription(endpoint);
    res.json({ status: "unsubscribed" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
