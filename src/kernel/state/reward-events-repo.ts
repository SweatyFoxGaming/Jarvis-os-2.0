import { getPool } from "./db.js";
import { ObservationPlatform } from "../observation.js";

const observation = ObservationPlatform.getInstance();

export type RewardSource = "task_review" | "terminal_outcome";

// The one write path. Fire-and-forget from every caller's perspective —
// see the design spec's Error handling section: a failure to record a
// reward event must never block or fail a coding session.
export async function recordRewardEvent(
  buildRequestId: number,
  source: RewardSource,
  modelUsed: string | null,
  category: string,
  rewardValue: number
): Promise<void> {
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO reward_events (build_request_id, source, model_used, category, reward_value) VALUES ($1, $2, $3, $4, $5)`,
      [buildRequestId, source, modelUsed, category, rewardValue]
    );
  } catch (err: any) {
    observation.logTelemetry("warn", "RewardEvents", `recordRewardEvent(${buildRequestId}, ${source}) failed: ${err.message}`);
  }
}

// Reorders `candidates` by descending average reward_value over each
// model's most recent 50 events. A model with zero events gets a neutral
// score of exactly 0 — combined with Array.prototype.sort's stability,
// that means unscored models keep their original relative order, so this
// never disturbs today's fallback order until there's real data to
// justify it. Degrades to `candidates` unchanged on any failure.
export async function getModelPreferenceOrder(candidates: string[]): Promise<string[]> {
  try {
    const db = getPool();
    const scores = new Map<string, number>();
    for (const model of candidates) {
      const { rows } = await db.query(
        `SELECT reward_value FROM reward_events WHERE model_used = $1 ORDER BY created_at DESC LIMIT 50`,
        [model]
      );
      const avg = rows.length > 0 ? rows.reduce((sum: number, r: any) => sum + r.reward_value, 0) / rows.length : 0;
      scores.set(model, avg);
    }
    return [...candidates].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));
  } catch (err: any) {
    observation.logTelemetry("warn", "RewardEvents", `getModelPreferenceOrder(${JSON.stringify(candidates)}) failed: ${err.message}`);
    return candidates;
  }
}

export async function getCategoryScore(category: string): Promise<{ score: number; count: number } | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT AVG(reward_value)::float AS score, COUNT(*)::int AS count FROM (
         SELECT reward_value FROM reward_events WHERE category = $1 ORDER BY created_at DESC LIMIT 50
       ) recent`,
      [category]
    );
    if (!rows[0] || rows[0].count === 0) return null;
    return { score: rows[0].score, count: rows[0].count };
  } catch (err: any) {
    observation.logTelemetry("warn", "RewardEvents", `getCategoryScore(${category}) failed: ${err.message}`);
    return null;
  }
}

export async function getModelScore(model: string): Promise<{ score: number; count: number } | null> {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT AVG(reward_value)::float AS score, COUNT(*)::int AS count FROM (
         SELECT reward_value FROM reward_events WHERE model_used = $1 ORDER BY created_at DESC LIMIT 50
       ) recent`,
      [model]
    );
    if (!rows[0] || rows[0].count === 0) return null;
    return { score: rows[0].score, count: rows[0].count };
  } catch (err: any) {
    observation.logTelemetry("warn", "RewardEvents", `getModelScore(${model}) failed: ${err.message}`);
    return null;
  }
}

export async function getOverallScore(source?: RewardSource): Promise<{ score: number; count: number } | null> {
  try {
    const db = getPool();
    const { rows } = source
      ? await db.query(
          `SELECT AVG(reward_value)::float AS score, COUNT(*)::int AS count FROM (
             SELECT reward_value FROM reward_events WHERE source = $1 ORDER BY created_at DESC LIMIT 50
           ) recent`,
          [source]
        )
      : await db.query(
          `SELECT AVG(reward_value)::float AS score, COUNT(*)::int AS count FROM (
             SELECT reward_value FROM reward_events ORDER BY created_at DESC LIMIT 50
           ) recent`
        );
    if (!rows[0] || rows[0].count === 0) return null;
    return { score: rows[0].score, count: rows[0].count };
  } catch (err: any) {
    observation.logTelemetry("warn", "RewardEvents", `getOverallScore(${source ?? "<all>"}) failed: ${err.message}`);
    return null;
  }
}
