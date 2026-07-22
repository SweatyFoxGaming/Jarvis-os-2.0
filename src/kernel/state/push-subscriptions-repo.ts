import { getPool } from "./db.js";

export interface PushSubscription {
  id: number;
  username: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: Date;
}

// ON CONFLICT (endpoint) covers the case where the same browser re-subscribes
// (e.g. after clearing storage) — the endpoint is stable per subscription, so
// this updates the keys/owner rather than erroring or creating a duplicate row.
export async function addSubscription(
  username: string,
  endpoint: string,
  p256dh: string,
  auth: string
): Promise<PushSubscription> {
  const db = getPool();
  const { rows } = await db.query(
    `INSERT INTO push_subscriptions (username, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET username = $1, p256dh = $3, auth = $4
     RETURNING *`,
    [username, endpoint, p256dh, auth]
  );
  return rows[0];
}

export async function getSubscriptionsForUser(username: string): Promise<PushSubscription[]> {
  const db = getPool();
  const { rows } = await db.query(`SELECT * FROM push_subscriptions WHERE username = $1`, [username]);
  return rows;
}

export async function removeSubscription(endpoint: string): Promise<void> {
  const db = getPool();
  await db.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
}
