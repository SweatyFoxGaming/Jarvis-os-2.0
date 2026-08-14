import { ObservationPlatform } from "../kernel/observation.js";
import { getRedisClient, isRedisConfigured } from "../kernel/redis-client.js";
import type { Redis } from "ioredis";

const observation = ObservationPlatform.getInstance();

type Handler<T = any> = (payload: T) => void;

const REDIS_CHANNEL_PREFIX = "jarvis:events:";

/**
 * Pure in-process pub/sub — no I/O of its own. Subsystems publish to named
 * topics (e.g. "filesystem:changed", "voice:transcript") and subscribe with
 * typed handlers. This is the backbone /ws/events forwards onto WebSocket
 * clients (browser pages, host-level bridges) — see server.ts.
 *
 * A handler that throws is caught and logged, not allowed to break delivery
 * to the other subscribers on the same topic or to the publisher's own
 * call stack — a single misbehaving subscriber must never take down
 * whatever just published an event.
 *
 * Cross-instance relay (startCrossInstanceRelay, opt-in, Redis-backed) is
 * ADDITIVE: local delivery via publish() stays exactly as synchronous as it
 * always was, for every existing call site. When configured, publish() also
 * fire-and-forget relays to a Redis channel; a subscriber picks up messages
 * relayed by OTHER instances and re-publishes them locally with
 * { fromRelay: true }, which suppresses re-relaying (loop prevention).
 */
export class EventBus {
  private static instance: EventBus | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private relaySubscriber: Redis | null = null;
  private relayStarted = false;

  public static getInstance(): EventBus {
    if (!this.instance) {
      this.instance = new EventBus();
    }
    return this.instance;
  }

  public subscribe<T = any>(topic: string, handler: Handler<T>): () => void {
    if (!this.handlers.has(topic)) {
      this.handlers.set(topic, new Set());
    }
    this.handlers.get(topic)!.add(handler as Handler);
    return () => {
      this.handlers.get(topic)?.delete(handler as Handler);
    };
  }

  public publish<T = any>(topic: string, payload: T, opts: { fromRelay?: boolean } = {}): void {
    const topicHandlers = this.handlers.get(topic);
    if (topicHandlers && topicHandlers.size > 0) {
      for (const handler of topicHandlers) {
        try {
          handler(payload);
        } catch (err: any) {
          observation.logTelemetry("warn", "EventBus", `Handler for topic "${topic}" threw: ${err.message || err}`);
        }
      }
    }

    // Loop prevention: a message this instance just received FROM the relay
    // must never be relayed straight back out, or every instance would echo
    // it forever. Only a genuinely locally-originated publish() relays.
    if (opts.fromRelay || !isRedisConfigured()) return;
    const redis = getRedisClient();
    if (!redis) return;
    redis.publish(`${REDIS_CHANNEL_PREFIX}${topic}`, JSON.stringify(payload)).catch((err: any) => {
      observation.logTelemetry("warn", "EventBus", `Cross-instance relay publish failed for topic "${topic}": ${err.message}`);
    });
  }

  /**
   * Starts a dedicated Redis subscriber connection (ioredis requires a
   * connection in subscribe mode to be used only for pub/sub commands, so
   * this can't share the main getRedisClient() singleton — it duplicates
   * it, matching ioredis's own documented pattern) listening for the given
   * topics. No-ops if Redis isn't configured, or if already started (a
   * second call with a different topic list does NOT add to the first
   * call's subscriptions — callers needing more topics should pass the
   * full list they need in one call, made once at startup).
   */
  public startCrossInstanceRelay(topics: string[]): void {
    if (this.relayStarted) return;
    if (!isRedisConfigured()) return;
    const base = getRedisClient();
    if (!base) return;
    this.relayStarted = true;
    const subscriber = base.duplicate();
    this.relaySubscriber = subscriber;
    subscriber.on("error", (err: Error) => {
      observation.logTelemetry("warn", "EventBus", `Cross-instance relay subscriber error: ${err.message}`);
    });
    for (const topic of topics) {
      subscriber.subscribe(`${REDIS_CHANNEL_PREFIX}${topic}`).catch((err: any) => {
        observation.logTelemetry("warn", "EventBus", `Failed to subscribe to cross-instance topic "${topic}": ${err.message}`);
      });
    }
    subscriber.on("message", (channel: string, message: string) => {
      const topic = channel.startsWith(REDIS_CHANNEL_PREFIX) ? channel.slice(REDIS_CHANNEL_PREFIX.length) : channel;
      try {
        const payload = JSON.parse(message);
        this.publish(topic, payload, { fromRelay: true });
      } catch (err: any) {
        observation.logTelemetry("warn", "EventBus", `Malformed cross-instance message on "${channel}": ${err.message}`);
      }
    });
  }
}
