# Shared State & Multi-Tenant Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the two smallest, most tractable in-memory singletons (KeyPool's per-key cooldown state, EventBus's local pub/sub) a Redis-backed path to cross-instance consistency, make the Postgres pool retry instead of hard-failing on a burst, and add regression coverage for the new Redis connections dropping — without breaking any existing single-instance deployment, which is every deployment that exists today.

**Architecture — read this before touching anything:** This is explicitly the largest and riskiest of the three phases in this plan set, and it is **not** a complete multi-instance migration. Today's deployment is one `docker-compose.yml` + one `systemd` unit on one host, with zero Redis infrastructure and zero load balancer — a real horizontally-scaled deployment doesn't exist yet, so nothing here can be validated against one. This plan scopes itself to what's genuinely tractable:

- **KeyPool** (`src/runtime/key-pool.ts`) — small, simple state (a key string + a cooldown timestamp). Migrates cleanly: Task 2.
- **EventBus** (`src/core/event-bus.ts`) — currently a synchronous, fire-and-forget, in-process pub/sub used by 6 files. Rewriting it to be fully Redis-backed would force every `publish()`/`subscribe()` call site to become async, a much bigger blast radius than this plan takes on. Instead, Task 3 adds an **additive** cross-instance relay: local delivery stays exactly as synchronous and fast as it is today, and `publish()` additionally (non-blocking, fire-and-forget) relays to a Redis channel that other instances pick up and re-publish locally. No existing call site's signature changes.
- **SessionState** (`src/cognition/session.ts`) — **explicitly out of scope for this plan.** It holds live instances of seven different engine classes (`CognitiveWorkspace`, `MindStateTracker`, `AttentionEngine`, `ThoughtEngine`, `ConfidenceModel`, `ExecutiveStateTracker`, `InternalDialogue`, `SynchronizationEngine`) — none of them serializable today. Making per-user session state shareable across instances means redesigning those classes to be serializable first, which is its own multi-task project, not a task inside this one. If real multi-instance deployment becomes concrete, that redesign should be its own plan.
- **Postgres pool resilience** (Task 4) and **Redis-disconnect regression tests** (Task 5) don't depend on the above and are fully self-contained.

**Tech Stack:** `ioredis` (new dependency — no Redis client exists in this codebase today), Redis 7 (new `docker-compose.yml` service), TypeScript/Node, `pg` (existing).

## Global Constraints

- **Every Redis-backed code path must degrade to today's exact in-memory-only behavior when `REDIS_URL` is unset.** No deployment that exists today sets it. A missing/unreachable Redis must never crash the process or block a request — only skip the cross-instance behavior and log a warning once.
- New dependency: `ioredis` (add to `package.json`'s `"dependencies"`). No other new dependencies.
- `docker-compose.yml` gets one new `redis` service; it is not wired into `api`'s `depends_on` as a hard requirement (matching the existing `voice-daemon` pattern of `service_started`, not `service_healthy` — see that service's own comment for why an optional subsystem must never be able to block the whole gateway from starting).

---

### Task 1: Redis infrastructure — connection wrapper, dependency, docker-compose service

**Files:**
- Create: `src/kernel/redis-client.ts`
- Modify: `package.json` (add `ioredis` dependency)
- Modify: `docker-compose.yml` (add `redis` service)
- Modify: `.env.example` (document `REDIS_URL`)

**Interfaces:**
- Produces: `createRedisClient(url: string): Redis` (pure constructor — wires an `"error"` handler that logs via `ObservationPlatform` and never throws/crashes on connection failure; used directly by Task 5's tests and internally by `getRedisClient()`), `getRedisClient(): Redis | null` (singleton; returns `null` if `REDIS_URL` is unset — callers must handle `null`), `isRedisConfigured(): boolean`.

- [ ] **Step 1: Add the dependency**

In `package.json`, in `"dependencies"` (alphabetically, near the existing `"dotenv"`/`"express"` entries), add:

```json
    "ioredis": "^5.4.1",
```

Run: `npm install`
Expected: `node_modules/ioredis` is installed, `package-lock.json` updates.

- [ ] **Step 2: Write `src/kernel/redis-client.ts`**

```typescript
import Redis from "ioredis";
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
```

- [ ] **Step 3: Add the `redis` service to `docker-compose.yml`**

In `docker-compose.yml`, add a new service after `postgres` (before the `jarvis-builder` comment block):

```yaml
  # Optional cross-instance coordination for KeyPool cooldown state and
  # EventBus's cross-instance relay (see docs/superpowers/plans/
  # 2026-08-10-shared-state-multi-tenant-infra.md) -- every deployment
  # without REDIS_URL set in .env runs exactly as it did before this
  # service existed, in-memory-only, same as api's own depends_on below
  # (service_started, not service_healthy: an unreachable/down Redis must
  # never block the gateway from starting, matching voice-daemon's own
  # documented reasoning above for why an optional subsystem gets
  # service_started, not service_healthy).
  redis:
    image: redis:7-alpine
    container_name: jarvis-redis
    restart: unless-stopped
```

And add `redis: condition: service_started` to `api`'s `depends_on:` block (alongside the existing `postgres`/`llama-cpp`/`jarvis-builder`/`voice-daemon` entries).

- [ ] **Step 4: Document `REDIS_URL` in `.env.example`**

Add, near the existing `POSTGRES_*` variables:

```
# Optional. Unsets by default -- every feature that uses this (KeyPool
# cross-instance cooldown sharing, EventBus's cross-instance relay) falls
# back to local-only, in-memory behavior when this is blank. Only needed
# for a genuine multi-instance deployment, which this codebase doesn't
# fully support yet (see docs/superpowers/plans/
# 2026-08-10-shared-state-multi-tenant-infra.md).
REDIS_URL=redis://redis:6379
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/kernel/redis-client.ts docker-compose.yml .env.example
git commit -m "feat: add optional Redis infrastructure for cross-instance state sharing"
```

---

### Task 2: KeyPool — cross-instance cooldown sharing via Redis

**Files:**
- Modify: `src/runtime/key-pool.ts`
- Modify: `src/runtime/cognition-router.ts:262, 272, 275` (add `await` to now-async calls)
- Test: `tests/index.test.ts` (extend the existing `KeyPool` test coverage — search for `KeyPool` imports/tests already in the file, e.g. near `import { KeyPool } from "../src/runtime/key-pool.js"` at line 37)

**Interfaces:**
- Consumes: `getRedisClient()`, `isRedisConfigured()` (Task 1).
- Produces: `KeyPool.getAvailableKey(provider): Promise<string | null>` (was synchronous — now `async`), `KeyPool.reportFailure(provider, key, retryAfterSeconds?): Promise<void>` (was synchronous — now `async`). `keyCount()` and `strainRatio()` stay synchronous (local-only bookkeeping; not migrated — see this task's own reasoning below).

**Design note:** Only `getAvailableKey`/`reportFailure` change — the two methods that decide "can this key be used right now." `strainRatio()` (used by `cognition-router.ts`'s fair-share throttle) intentionally stays local-only: it's an approximation already ("the fraction of *this instance's* keys on cooldown"), and making it perfectly cross-instance-accurate would need a much bigger redesign for a value that only ever feeds a soft delay heuristic, not a correctness guarantee.

- [ ] **Step 1: Write the failing test**

Add to `tests/index.test.ts`, in the existing test area covering `KeyPool` (search for its import and any existing `registerTest(..., "KeyPool"` or similar block; add this near it):

```typescript
registerTest("KeyPool", "reportFailure's cooldown is visible to a second KeyPool instance via Redis when configured", async () => {
  // Two separate KeyPool instances (simulating two process instances)
  // sharing one Redis -- reportFailure on pool A's key must make
  // getAvailableKey on pool B skip that same key, not just pool A's own.
  // Skipped entirely (not a failure) if this test environment has no real
  // Redis reachable -- this is exercising cross-instance behavior, which
  // by this plan's own Global Constraints must be fully optional.
  const { getRedisClient, isRedisConfigured } = await import("../src/kernel/redis-client.js");
  if (!isRedisConfigured()) {
    console.log("  (skipped: REDIS_URL not set in this environment)");
    return;
  }
  const redis = getRedisClient();
  if (!redis) {
    console.log("  (skipped: Redis client unavailable)");
    return;
  }

  const testKey = `test-key-${Date.now()}`;
  const poolA = new KeyPool({ groq: [testKey], gemini: [] });
  const poolB = new KeyPool({ groq: [testKey], gemini: [] });

  const beforeFailure = await poolB.getAvailableKey("groq");
  if (beforeFailure !== testKey) {
    throw new Error(`KeyPool: expected pool B to see the key available before any failure, got ${beforeFailure}`);
  }

  await poolA.reportFailure("groq", testKey, 30);

  const afterFailure = await poolB.getAvailableKey("groq");
  if (afterFailure !== null) {
    throw new Error(`KeyPool: expected pool B to see the key on cooldown after pool A's reportFailure, got ${afterFailure}`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails (or skips)**

Run: `npm test`
Expected: without `REDIS_URL` set, the test logs the skip message and passes trivially (nothing to verify yet). With `REDIS_URL` set to a reachable Redis (e.g. `REDIS_URL=redis://localhost:6379 npm test` against a locally running `docker run -p 6379:6379 redis:7-alpine`), it FAILS: `getAvailableKey` is still synchronous today (returns a value, not a Promise), so `await poolB.getAvailableKey(...)` resolves to whatever the synchronous call returned, and pool B — which has no idea pool A reported a failure — still returns `testKey`.

- [ ] **Step 3: Implement the Redis-backed cooldown check**

Replace `src/runtime/key-pool.ts` in full:

```typescript
import * as crypto from "crypto";
import { getRedisClient, isRedisConfigured } from "../kernel/redis-client.js";
import { ObservationPlatform } from "../kernel/observation.js";

const observation = ObservationPlatform.getInstance();

export type Provider = "groq" | "gemini";

export const DEFAULT_COOLDOWN_SECONDS = 60;

interface KeyState {
  key: string;
  cooldownUntil: number; // epoch ms; 0 means never on cooldown
}

// Redis key names must never contain the raw API key (visible in
// `redis-cli monitor`/slow-log output, and in principle in Redis itself if
// ever exposed) -- a short hash is enough to detect "same key, another
// instance already reported this on cooldown" without storing the secret
// anywhere new.
function cooldownRedisKey(provider: Provider, key: string): string {
  const hash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
  return `jarvis:keypool:cooldown:${provider}:${hash}`;
}

export class KeyPool {
  private state: Record<Provider, KeyState[]>;
  private cursor: Record<Provider, number> = { groq: 0, gemini: 0 };

  constructor(keys: Record<Provider, string[]>) {
    this.state = {
      groq: keys.groq.map((key) => ({ key, cooldownUntil: 0 })),
      gemini: keys.gemini.map((key) => ({ key, cooldownUntil: 0 })),
    };
  }

  /**
   * Local-only check, unchanged from before this task -- kept synchronous
   * and separate from getAvailableKey's Redis-aware check below so
   * strainRatio() (which only needs the local view) never pays for a
   * network round trip.
   */
  private isLocallyOnCooldown(entry: KeyState, now: number): boolean {
    return entry.cooldownUntil > now;
  }

  private async isCrossInstanceOnCooldown(provider: Provider, key: string): Promise<boolean> {
    if (!isRedisConfigured()) return false;
    const redis = getRedisClient();
    if (!redis) return false;
    try {
      const value = await redis.get(cooldownRedisKey(provider, key));
      return value !== null;
    } catch (err: any) {
      // A Redis error here must never block key selection -- fall back to
      // "not on cooldown as far as we can tell", same as Redis being
      // unconfigured. This task's Global Constraints require that a
      // down/unreachable Redis never blocks a request.
      observation.logTelemetry("warn", "KeyPool", `Redis cooldown check failed for ${provider}: ${err.message}`);
      return false;
    }
  }

  async getAvailableKey(provider: Provider): Promise<string | null> {
    const keys = this.state[provider];
    if (keys.length === 0) return null;
    const now = Date.now();
    for (let i = 0; i < keys.length; i++) {
      const idx = (this.cursor[provider] + i) % keys.length;
      const entry = keys[idx];
      if (this.isLocallyOnCooldown(entry, now)) continue;
      if (await this.isCrossInstanceOnCooldown(provider, entry.key)) continue;
      this.cursor[provider] = (idx + 1) % keys.length;
      return entry.key;
    }
    return null;
  }

  async reportFailure(provider: Provider, key: string, retryAfterSeconds?: number): Promise<void> {
    const seconds = retryAfterSeconds ?? DEFAULT_COOLDOWN_SECONDS;
    const entry = this.state[provider].find((k) => k.key === key);
    if (entry) {
      entry.cooldownUntil = Date.now() + seconds * 1000;
    }
    if (isRedisConfigured()) {
      const redis = getRedisClient();
      if (redis) {
        try {
          await redis.set(cooldownRedisKey(provider, key), "1", "EX", seconds);
        } catch (err: any) {
          observation.logTelemetry("warn", "KeyPool", `Redis cooldown write failed for ${provider}: ${err.message}`);
        }
      }
    }
  }

  reportSuccess(_provider: Provider, _key: string): void {
    // Reserved for future adaptive cooldown tuning.
  }

  // Used by cognition-router.ts to bound its per-provider key-retry loop
  // (try every configured key for a provider before moving to the next
  // model/provider) with a hard, finite cap — independent of getAvailableKey's
  // own cooldown-driven termination, so a future bug in that logic can't
  // turn the retry loop into a spin.
  keyCount(provider: Provider): number {
    return this.state[provider].length;
  }

  // Used by cognition-router.ts's pool-strain check — the fraction of all
  // configured keys, across all providers, currently on cooldown. Local-only
  // by design — see this task's own design note in the plan for why.
  strainRatio(): number {
    const all = [...this.state.groq, ...this.state.gemini];
    if (all.length === 0) return 0;
    const now = Date.now();
    const onCooldown = all.filter((k) => k.cooldownUntil > now).length;
    return onCooldown / all.length;
  }
}
```

- [ ] **Step 4: Update `cognition-router.ts`'s call sites to `await`**

In `src/runtime/cognition-router.ts`, the call site block around lines 260-275 already runs inside an `async` method (confirmed: `getAvailableKey`/`reportSuccess`/`reportFailure` are called from within `generateWithFallback`, which is `async`). Change:

```typescript
        const key = this.deps.keyPool.getAvailableKey(provider);
```

to:

```typescript
        const key = await this.deps.keyPool.getAvailableKey(provider);
```

and:

```typescript
          this.deps.keyPool.reportSuccess(provider, key);
```

stays unchanged (still synchronous — `reportSuccess` wasn't modified), and:

```typescript
          this.deps.keyPool.reportFailure(provider, key, retryAfterSeconds);
```

to:

```typescript
          await this.deps.keyPool.reportFailure(provider, key, retryAfterSeconds);
```

- [ ] **Step 5: Run the test to verify it passes**

Run (with a real Redis reachable): `REDIS_URL=redis://localhost:6379 npm test`
Expected: PASS.

Run (without Redis configured, the default): `npm test`
Expected: PASS (test skips its own assertions, as designed in Step 1) — and every other test, including any pre-existing `KeyPool`-category tests exercising `getAvailableKey`/`reportFailure` synchronously, still passes now that callers `await` them (a `Promise<string | null>` awaited still resolves to the right value — this is a non-breaking signature change for every caller that already awaits, and this task already found and fixed the one production call site in `cognition-router.ts`; check for any other direct callers with `grep -rn "keyPool\.\(getAvailableKey\|reportFailure\)" src/ tests/` before considering this step done).

- [ ] **Step 6: Commit**

```bash
git add src/runtime/key-pool.ts src/runtime/cognition-router.ts tests/index.test.ts
git commit -m "feat: share KeyPool cooldown state across instances via Redis, with in-memory fallback"
```

---

### Task 3: EventBus — additive cross-instance relay via Redis pub/sub

**Files:**
- Modify: `src/core/event-bus.ts`
- Modify: `src/server.ts` (start the relay at startup for one real cross-instance-relevant topic)
- Test: `tests/index.test.ts` (extend existing `EventBus`-adjacent coverage, or add a new block near other `Platform`/`EventBus` tests)

**Interfaces:**
- Consumes: `getRedisClient()`, `isRedisConfigured()` (Task 1).
- Produces: `EventBus.publish<T>(topic, payload, opts?: { fromRelay?: boolean }): void` (signature extended with an optional third parameter — existing two-argument call sites are unaffected), `EventBus.startCrossInstanceRelay(topics: string[]): void` (new method; no-ops if Redis isn't configured or the relay is already started).

- [ ] **Step 1: Write the failing test**

Add near the existing `Platform` category tests in `tests/index.test.ts` (which already import/exercise other core singletons):

```typescript
registerTest("Platform", "EventBus relays a published event to Redis, and re-publishes locally what it receives back", async () => {
  const { getRedisClient, isRedisConfigured } = await import("../src/kernel/redis-client.js");
  if (!isRedisConfigured()) {
    console.log("  (skipped: REDIS_URL not set in this environment)");
    return;
  }
  const redis = getRedisClient();
  if (!redis) {
    console.log("  (skipped: Redis client unavailable)");
    return;
  }

  const { EventBus } = await import("../src/core/event-bus.js");
  const bus = EventBus.getInstance();
  const topic = `test:relay:${Date.now()}`;

  bus.startCrossInstanceRelay([topic]);
  // Relay subscription is async internally (ioredis's subscribe() returns
  // a Promise) -- give it a moment to actually register before publishing,
  // otherwise this test would be racing its own setup.
  await new Promise((resolve) => setTimeout(resolve, 200));

  const received: any[] = [];
  const unsubscribe = bus.subscribe(topic, (payload) => received.push(payload));

  try {
    bus.publish(topic, { hello: "world" });
    // The relay round-trips through real Redis pub/sub (publish -> Redis ->
    // this same process's own subscriber -> re-publish locally) -- not
    // instantaneous, so poll briefly rather than asserting immediately.
    const deadline = Date.now() + 3000;
    while (received.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Exactly 2: the bus's own synchronous local delivery (immediate) plus
    // the relay round-trip's local re-publish (fromRelay: true) -- never 1
    // (relay didn't fire) and never 3+ (a relay loop re-publishing its own
    // relayed message back out to Redis again).
    if (received.length !== 2) {
      throw new Error(`EventBus: expected exactly 2 local deliveries (direct + relay round-trip), got ${received.length}: ${JSON.stringify(received)}`);
    }
    for (const payload of received) {
      if (payload.hello !== "world") {
        throw new Error(`EventBus: relayed payload mismatch: ${JSON.stringify(payload)}`);
      }
    }
  } finally {
    unsubscribe();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails (or skips)**

Run: `npm test`
Expected: without Redis configured, skips and passes trivially. With `REDIS_URL` set to a reachable Redis: FAILS — `startCrossInstanceRelay` doesn't exist yet on `EventBus`.

- [ ] **Step 3: Implement the relay**

Replace `src/core/event-bus.ts` in full:

```typescript
import { ObservationPlatform } from "../kernel/observation.js";
import { getRedisClient, isRedisConfigured } from "../kernel/redis-client.js";
import type Redis from "ioredis";

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
```

- [ ] **Step 4: Start the relay at server startup**

In `src/server.ts`, near where `startAudioClient`/`startVoiceSession` are started (around line 1496-1497), add:

```typescript
// Opt-in, no-ops if REDIS_URL is unset (every deployment today) -- see
// docs/superpowers/plans/2026-08-10-shared-state-multi-tenant-infra.md.
// "system:anomaly" is the one topic genuinely useful across instances
// today (a real multi-instance deployment doesn't exist yet); extending
// this list is a deployment decision for whenever one does.
EventBus.getInstance().startCrossInstanceRelay(["system:anomaly"]);
```

`EventBus` is already imported in `server.ts` (used by the `/ws/events` handler at line 1410) — no new import needed.

- [ ] **Step 5: Run the test to verify it passes**

Run (with Redis reachable): `REDIS_URL=redis://localhost:6379 npm test`
Expected: PASS.

Run (default, no Redis): `npm test`
Expected: PASS, including every pre-existing test that calls `EventBus.getInstance().publish(...)` with its original two-argument form (the third `opts` parameter is optional, so no existing call site needs to change).

- [ ] **Step 6: Commit**

```bash
git add src/core/event-bus.ts src/server.ts tests/index.test.ts
git commit -m "feat: add opt-in Redis cross-instance relay to EventBus, additive to local delivery"
```

---

### Task 4: Postgres pool — retry with backoff instead of a hard 5s failure

**Files:**
- Modify: `src/kernel/state/db.ts`
- Modify: `src/kernel/state/session-repo.ts:16-22` (`appendMessage`, migrated as the first real integration point — the highest-frequency write in the system, called every chat turn)
- Test: `tests/index.test.ts`

**Interfaces:**
- Produces: `queryWithRetry<T>(text: string, params?: any[], opts?: { maxRetries?: number; baseDelayMs?: number; queryFn?: (text: string, params?: any[]) => Promise<pg.QueryResult<T>> }): Promise<pg.QueryResult<T>>`, exported from `src/kernel/state/db.ts`.

- [ ] **Step 1: Write the failing test**

Add to `tests/index.test.ts`, near other `Database`-category tests (search for `registerTest("Database"` — there are existing ones covering `initDatabase`/`pingDatabase` behavior):

```typescript
registerTest("Database", "queryWithRetry retries a pool-exhaustion error with backoff, then returns the eventual success", async () => {
  let attempts = 0;
  const fakeQueryFn = async (_text: string, _params?: any[]) => {
    attempts++;
    if (attempts < 3) {
      throw new Error("timeout exceeded when trying to connect");
    }
    return { rows: [{ ok: true }], rowCount: 1 } as any;
  };
  const result = await queryWithRetry("SELECT 1", [], { maxRetries: 3, baseDelayMs: 5, queryFn: fakeQueryFn });
  if (attempts !== 3) {
    throw new Error(`Database: expected exactly 3 attempts (2 pool-exhaustion failures + 1 success), got ${attempts}`);
  }
  if (!result.rows[0].ok) {
    throw new Error("Database: expected the eventual successful result to be returned");
  }
});

registerTest("Database", "queryWithRetry does not retry a non-pool-exhaustion error", async () => {
  let attempts = 0;
  const fakeQueryFn = async () => {
    attempts++;
    throw new Error('syntax error at or near "SELCT"');
  };
  let caught: any = null;
  try {
    await queryWithRetry("SELCT 1", [], { maxRetries: 3, baseDelayMs: 5, queryFn: fakeQueryFn });
  } catch (err: any) {
    caught = err;
  }
  if (!caught || !caught.message.includes("syntax error")) {
    throw new Error(`Database: expected the original syntax error to propagate unretried, got: ${caught?.message}`);
  }
  if (attempts !== 1) {
    throw new Error(`Database: expected exactly 1 attempt for a non-retryable error, got ${attempts}`);
  }
});
```

Add `queryWithRetry` to this test file's import from `src/kernel/state/db.ts` (find the existing import of `db.ts` exports, or add a new one: `import { queryWithRetry } from "../src/kernel/state/db.js";`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `queryWithRetry` doesn't exist yet (`TypeError: queryWithRetry is not a function` or an import error).

- [ ] **Step 3: Implement `queryWithRetry` in `db.ts`**

In `src/kernel/state/db.ts`, add after `getPool()` (after line 105, before the `createSchema` comment block):

```typescript
// The exact error pg-pool throws when connectionTimeoutMillis (getPool()'s
// own 5s config above) is exceeded while waiting for an available client --
// verified against this project's installed pg-pool version (see
// node_modules/pg-pool/index.js's own `new Error('timeout exceeded when
// trying to connect')`). Matched by substring, not by a dedicated error
// class, because node-postgres doesn't expose one for this case.
const POOL_EXHAUSTION_ERROR_MESSAGE = "timeout exceeded when trying to connect";

/**
 * Retries ONLY pool-exhaustion errors (a connection burst hitting getPool()'s
 * max:10 cap) with exponential backoff, instead of failing on the first 5s
 * timeout. Any other error (a real query error, a constraint violation,
 * etc.) is never retried -- retrying those would be silently wrong (e.g. a
 * duplicate-key insert retried blindly could mask a real bug). queryFn is
 * injectable for tests (see tests/index.test.ts) that need to simulate
 * pool exhaustion deterministically without a real burst of concurrent
 * connections.
 */
export async function queryWithRetry<T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[],
  opts: {
    maxRetries?: number;
    baseDelayMs?: number;
    queryFn?: (text: string, params?: any[]) => Promise<pg.QueryResult<T>>;
  } = {}
): Promise<pg.QueryResult<T>> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const run = opts.queryFn ?? ((queryText: string, queryParams?: any[]) => getPool().query<T>(queryText, queryParams));

  let lastErr: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await run(text, params);
    } catch (err: any) {
      lastErr = err;
      const isPoolExhaustion = typeof err?.message === "string" && err.message.includes(POOL_EXHAUSTION_ERROR_MESSAGE);
      if (!isPoolExhaustion || attempt === maxRetries) {
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt);
      observation.logTelemetry(
        "warn",
        "Database",
        `Connection pool exhausted (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms.`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS for both new tests.

- [ ] **Step 5: Integrate into `appendMessage` (highest-frequency write path)**

In `src/kernel/state/session-repo.ts`, replace:

```typescript
import { getPool } from "./db.js";
import { ObservationPlatform } from "../observation.js";

const observation = ObservationPlatform.getInstance();

export interface HistoryMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
}

// Matches the in-memory bound in WorkspaceUserContext.addMessage() — no
// point rehydrating more than the working buffer ever keeps anyway.
const HISTORY_LIMIT = 50;

export async function appendMessage(username: string, role: string, content: string): Promise<void> {
  const db = getPool();
  await db.query(
    "INSERT INTO conversation_history (username, role, content) VALUES ($1, $2, $3)",
    [username, role, content]
  );
}
```

with:

```typescript
import { getPool, queryWithRetry } from "./db.js";
import { ObservationPlatform } from "../observation.js";

const observation = ObservationPlatform.getInstance();

export interface HistoryMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
}

// Matches the in-memory bound in WorkspaceUserContext.addMessage() — no
// point rehydrating more than the working buffer ever keeps anyway.
const HISTORY_LIMIT = 50;

// The highest-frequency write in this codebase (every chat turn, for every
// user) -- the first real integration point for queryWithRetry's
// pool-exhaustion backoff, so a burst of concurrent chat turns retries
// instead of dropping a message on the first 5s pool timeout.
export async function appendMessage(username: string, role: string, content: string): Promise<void> {
  await queryWithRetry(
    "INSERT INTO conversation_history (username, role, content) VALUES ($1, $2, $3)",
    [username, role, content]
  );
}
```

(`loadRecentHistory`/`pruneOldMessages` are left on plain `getPool().query()` for this task — `appendMessage` alone demonstrates the integration on the single hottest path; migrating every repo function is a mechanical follow-up, not blocking this plan.)

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all tests pass, including any existing `Session`-category tests exercising `appendMessage`/conversation history round-trips.

- [ ] **Step 7: Commit**

```bash
git add src/kernel/state/db.ts src/kernel/state/session-repo.ts tests/index.test.ts
git commit -m "feat: retry Postgres pool-exhaustion errors with backoff instead of failing immediately"
```

---

### Task 5: Regression tests for a dropped Redis connection and a malformed relayed payload

**Files:**
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `createRedisClient(url: string): Redis` (Task 1 — the pure, non-singleton constructor, used here specifically because it lets this test point at a deliberately-unreachable address without touching the shared singleton or `process.env`), `ObservationPlatform.getInstance().getTelemetry(): ITelemetryEvent[]` (`src/kernel/observation.ts:93-95`), `getRedisClient()`/`isRedisConfigured()` (Task 1), `EventBus.startCrossInstanceRelay` (Task 3).

**Covers both halves of "socket disconnects and payload error handling": Step 1 is the disconnect case (an unreachable Redis must log, not crash); the second test below (Step 4) is the payload case (a malformed message arriving over an otherwise-healthy relay subscription must be dropped with a warning, not crash the process or deliver garbage to local subscribers).

- [ ] **Step 1: Write the test**

Add to `tests/index.test.ts`, near other `Platform`/infrastructure tests:

```typescript
registerTest("Platform", "a Redis client pointed at an unreachable address logs a warning instead of crashing the process", async () => {
  const { createRedisClient } = await import("../src/kernel/redis-client.js");
  const { ObservationPlatform } = await import("../src/kernel/observation.js");
  const observation = ObservationPlatform.getInstance();

  const beforeCount = observation.getTelemetry().length;

  // Port 1 is a real, always-unassigned low port on any normal host --
  // connection fails fast (ECONNREFUSED) rather than timing out slowly,
  // keeping this test's runtime short and deterministic without a mock.
  const client = createRedisClient("redis://127.0.0.1:1");

  try {
    // If createRedisClient's "error" handler (src/kernel/redis-client.ts)
    // were missing, this unhandled "error" event would throw here and take
    // the whole test process down with it -- the actual thing this test
    // guards against. Reaching the assertions below at all is already
    // half the proof.
    const deadline = Date.now() + 3000;
    let sawWarning = false;
    while (Date.now() < deadline) {
      const recent = observation.getTelemetry().slice(beforeCount);
      if (recent.some((e) => e.subsystem === "Redis" && e.level === "warn")) {
        sawWarning = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!sawWarning) {
      throw new Error("Platform: expected a Redis connection failure to log a 'warn' telemetry event under subsystem 'Redis'");
    }
  } finally {
    client.disconnect();
  }
});
```

- [ ] **Step 2: Run the disconnect test**

Run: `npm test`
Expected: PASS — this test doesn't depend on `REDIS_URL`/a real reachable Redis at all (it deliberately connects to an unreachable address), so it runs and passes in every environment, including CI with no Redis available.

- [ ] **Step 3: Verify the negative case by hand — confirm this test would have caught a real regression**

Temporarily comment out the `client.on("error", ...)` handler inside `createRedisClient` (`src/kernel/redis-client.ts`), run `npm test` again, and confirm the new test now fails with an uncaught exception (proving the test actually exercises the crash path it claims to guard against) — then restore the handler.

Run: `npm test`
Expected (after restoring the handler): PASS again.

- [ ] **Step 4: Write the malformed-payload test**

Add immediately after the disconnect test in `tests/index.test.ts`:

```typescript
registerTest("Platform", "EventBus's cross-instance relay drops a malformed relayed message with a warning instead of crashing or delivering garbage", async () => {
  const { getRedisClient, isRedisConfigured } = await import("../src/kernel/redis-client.js");
  if (!isRedisConfigured()) {
    console.log("  (skipped: REDIS_URL not set in this environment)");
    return;
  }
  const redis = getRedisClient();
  if (!redis) {
    console.log("  (skipped: Redis client unavailable)");
    return;
  }

  const { EventBus } = await import("../src/core/event-bus.js");
  const { ObservationPlatform } = await import("../src/kernel/observation.js");
  const observation = ObservationPlatform.getInstance();
  const bus = EventBus.getInstance();
  const topic = `test:malformed-relay:${Date.now()}`;

  bus.startCrossInstanceRelay([topic]);
  await new Promise((resolve) => setTimeout(resolve, 200));

  const received: any[] = [];
  const unsubscribe = bus.subscribe(topic, (payload) => received.push(payload));
  const beforeCount = observation.getTelemetry().length;

  try {
    // Published directly via the raw redis client, bypassing EventBus.publish
    // entirely -- simulates a malformed message arriving on the wire (e.g.
    // a version-mismatched instance, or wire corruption), not something
    // EventBus's own JSON.stringify could ever produce on its own.
    await redis.publish(`jarvis:events:${topic}`, "{not valid json");

    const deadline = Date.now() + 3000;
    let sawWarning = false;
    while (Date.now() < deadline) {
      const recent = observation.getTelemetry().slice(beforeCount);
      if (recent.some((e) => e.subsystem === "EventBus" && e.level === "warn")) {
        sawWarning = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!sawWarning) {
      throw new Error("EventBus: expected a malformed relayed message to log a 'warn' telemetry event under subsystem 'EventBus'");
    }
    if (received.length !== 0) {
      throw new Error(`EventBus: a malformed relayed message must never reach local subscribers, got ${received.length} deliveries: ${JSON.stringify(received)}`);
    }
  } finally {
    unsubscribe();
  }
});
```

- [ ] **Step 5: Run both tests**

Run: `npm test`
Expected: PASS for both the disconnect test and the malformed-payload test (both skip cleanly without `REDIS_URL` set; both exercise their real failure path when it is).

- [ ] **Step 6: Commit**

```bash
git add tests/index.test.ts
git commit -m "test: add regression coverage for Redis relay disconnects and malformed relayed payloads"
```
