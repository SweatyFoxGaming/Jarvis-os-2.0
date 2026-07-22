import webpush from "web-push";
import { ObservationPlatform } from "../kernel/observation.js";
import * as pushRepo from "../kernel/state/push-subscriptions-repo.js";

const observation = ObservationPlatform.getInstance();

let configured = false;
function ensureConfigured(): boolean {
  if (configured) return true;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) return false;
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

export function getVapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || null;
}

// Fire-and-forget from the caller's perspective (scheduler.pushNotification
// already logs its own in-app notification; this is the phone/desktop-push
// half of the same event) — every subscription failure is handled per-device
// so one stale subscription never blocks delivery to the user's other devices.
export async function sendPushToUser(username: string, title: string, body: string): Promise<void> {
  if (!ensureConfigured()) return; // not configured — degrade silently, same as other optional integrations
  let subs;
  try {
    subs = await pushRepo.getSubscriptionsForUser(username);
  } catch (err: any) {
    observation.logTelemetry("warn", "Push", `Failed to load subscriptions for "${username}": ${err.message}`);
    return;
  }
  if (subs.length === 0) return;

  const payload = JSON.stringify({ title, body });
  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
    } catch (err: any) {
      // 404/410 mean the browser's push service considers this subscription
      // dead (uninstalled, storage cleared, etc.) — remove it rather than
      // retry it forever on every future notification.
      if (err.statusCode === 404 || err.statusCode === 410) {
        pushRepo.removeSubscription(sub.endpoint).catch(() => {});
      } else {
        observation.logTelemetry("warn", "Push", `Push send failed for "${username}": ${err.message}`);
      }
    }
  }));
}
