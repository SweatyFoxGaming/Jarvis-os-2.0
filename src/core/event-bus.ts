import { ObservationPlatform } from "../kernel/observation.js";

const observation = ObservationPlatform.getInstance();

type Handler<T = any> = (payload: T) => void;

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
 */
export class EventBus {
  private static instance: EventBus | null = null;
  private handlers = new Map<string, Set<Handler>>();

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

  public publish<T = any>(topic: string, payload: T): void {
    const topicHandlers = this.handlers.get(topic);
    if (!topicHandlers || topicHandlers.size === 0) return;
    for (const handler of topicHandlers) {
      try {
        handler(payload);
      } catch (err: any) {
        observation.logTelemetry("warn", "EventBus", `Handler for topic "${topic}" threw: ${err.message || err}`);
      }
    }
  }
}
