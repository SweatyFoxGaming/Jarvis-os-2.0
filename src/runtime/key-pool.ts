export type Provider = "groq" | "gemini";

export const DEFAULT_COOLDOWN_SECONDS = 60;

interface KeyState {
  key: string;
  cooldownUntil: number; // epoch ms; 0 means never on cooldown
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

  getAvailableKey(provider: Provider): string | null {
    const keys = this.state[provider];
    if (keys.length === 0) return null;
    const now = Date.now();
    for (let i = 0; i < keys.length; i++) {
      const idx = (this.cursor[provider] + i) % keys.length;
      if (keys[idx].cooldownUntil <= now) {
        this.cursor[provider] = (idx + 1) % keys.length;
        return keys[idx].key;
      }
    }
    return null;
  }

  reportFailure(provider: Provider, key: string, retryAfterSeconds?: number): void {
    const entry = this.state[provider].find((k) => k.key === key);
    if (!entry) return;
    entry.cooldownUntil = Date.now() + (retryAfterSeconds ?? DEFAULT_COOLDOWN_SECONDS) * 1000;
  }

  reportSuccess(_provider: Provider, _key: string): void {
    // Reserved for future adaptive cooldown tuning.
  }

  // Used by cognition-router.ts's pool-strain check — the fraction of all
  // configured keys, across all providers, currently on cooldown.
  strainRatio(): number {
    const all = [...this.state.groq, ...this.state.gemini];
    if (all.length === 0) return 0;
    const now = Date.now();
    const onCooldown = all.filter((k) => k.cooldownUntil > now).length;
    return onCooldown / all.length;
  }
}
