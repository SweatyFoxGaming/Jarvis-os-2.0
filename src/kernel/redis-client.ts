import { Redis } from "ioredis";
import { ObservationPlatform } from "./observation.js";

const observation = ObservationPlatform.getInstance();

let singleton: Redis | null = null;
let singletonAttempted = false;

/**
 * Pure constructor -- no singleton state, no env var reads. Exists
 * separately from getRedisClient() below so tests (see tests/index.test.ts's
 * Redis-related Platform-category tests) can point a real client at a
 * deliberately-unreachable address without
 * touching process.env or this module's singleton. Every Redis-backed
 * caller in this codebase (KeyPool, EventBus's cross-instance relay) MUST
 * treat a connection failure as non-fatal: retryStrategy caps backoff
 * rather than retrying forever, and the "error" handler logs a structured
 * warning -- verified (see tests/index.test.ts's disconnect regression
 * test) that ioredis itself already no-ops an unhandled "error" event
 * (silentEmit falls back to a bare console.error when there are zero
 * listeners) rather than letting it crash the process, so this handler
 * isn't what stands between a down Redis and a crashed Jarvis. Its real
 * job is observability: without it, a down/unreachable Redis fails
 * *silently* (a console.error only), invisible to ObservationPlatform and
 * anything watching it -- this handler is what keeps that failure visible
 * over what must stay an optional subsystem (see this plan's Global
 * Constraints).
 */
export function createRedisClient(url: string): Redis {
  const client = new Redis(url, {
    maxRetriesPerRequest: 3,
    enableOfflineQueue: false, // fail fast when down; callers already fall back
    connectTimeout: 2000,
    retryStrategy: (times: number) => Math.min(times * 500, 5000),
  });
  client.on("error", (err: Error) => {
    observation.logTelemetry("warn", "Redis", `Connection error: ${err.message}`);
  });
  return client;
}

export function isRedisConfigured(): boolean {
  return Boolean(process.env.REDIS_URL);
}

/**
 * Returns null, not a client that will forever fail to connect, when
 * REDIS_URL is unset -- every deployment today. Callers (KeyPool,
 * EventBus's relay) must treat null as "cross-instance features disabled,
 * fall back to local-only behavior", never as an error.
 */
export function getRedisClient(): Redis | null {
  if (!isRedisConfigured()) return null;
  if (!singleton && !singletonAttempted) {
    singletonAttempted = true;
    singleton = createRedisClient(process.env.REDIS_URL as string);
  }
  return singleton;
}
