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
          // Redis's EX option requires a positive integer -- a fractional
          // seconds value (e.g. a provider's retry-after header parsing to
          // 2.5) is rejected by Redis itself ("ERR value is not an integer
          // or out of range"), which would silently skip the cross-instance
          // cooldown write for exactly the real-world case this exists to
          // handle. Round up (never down, so we never under-cooldown) and
          // floor at 1 (Redis also rejects 0/negative EX values).
          await redis.set(cooldownRedisKey(provider, key), "1", "EX", Math.max(1, Math.ceil(seconds)));
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
