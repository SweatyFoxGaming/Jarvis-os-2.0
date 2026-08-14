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
    // Override enableOfflineQueue back to true for this one connection
    // only. The base client (and every other Redis-backed caller in this
    // codebase -- KeyPool, EventBus.publish's relay) fails fast with
    // enableOfflineQueue: false so a down/unreachable Redis never blocks a
    // request (see createRedisClient in redis-client.ts). This subscriber
    // connection is different: it's a one-time, long-lived setup call made
    // once at startup, not a per-request command -- duplicate() returns a
    // brand-new connection that hasn't finished its handshake yet, so with
    // offline queueing disabled the very first subscribe() call below would
    // fail outright (rather than queue) any time this runs before that
    // handshake completes, permanently disabling the relay for this
    // process. Queueing here is safe and correct: it just means the
    // subscription takes effect as soon as the connection comes up.
    const subscriber = base.duplicate({ enableOfflineQueue: true });
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
        // Trust boundary: this validates JSON *syntax* only, not payload
        // shape -- a relayed message is trusted exactly as much as Redis
        // itself is trusted (subscribe, not psubscribe, so only the
        // explicitly-listed topics passed to startCrossInstanceRelay are
        // reachable at all; today that's "system:anomaly", a render-only
        // topic nothing dispatches on). This is a deliberate scope
        // boundary, not an oversight: adding a topic whose subscribers take
        // real *actions* (rather than just rendering data) would require
        // payload schema validation here first.
        const payload = JSON.parse(message);
        this.publish(topic, payload, { fromRelay: true });
      } catch (err: any) {
        observation.logTelemetry("warn", "EventBus", `Malformed cross-instance message on "${channel}": ${err.message}`);
      }
    });
  }
}
