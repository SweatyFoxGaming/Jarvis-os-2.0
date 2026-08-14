import { Redis } from "ioredis";
import { ObservationPlatform } from "./observation.js";

const observation = ObservationPlatform.getInstance();

let singleton: Redis | null = null;
let singletonAttempted = false;

/**
 * Pure constructor -- no singleton state, no env var reads. Exists
 * separately from getRedisClient() below so tests (see redis-client.test.ts)
 * can point a real client at a deliberately-unreachable address without
 * touching process.env or this module's singleton. Every Redis-backed
 * caller in this codebase (KeyPool, EventBus's cross-instance relay) MUST
 * treat a connection failure as non-fatal: retryStrategy caps backoff
 * rather than retrying forever, and the "error" handler only logs -- an
 * unhandled "error" event on a Node EventEmitter throws and crashes the
 * process, so this handler existing at all is what keeps a down/unreachable
 * Redis from taking down Jarvis over what must stay an optional subsystem
 * (see this plan's Global Constraints).
 */
export function createRedisClient(url: string): Redis {
  const client = new Redis(url, {
    maxRetriesPerRequest: 3,
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
