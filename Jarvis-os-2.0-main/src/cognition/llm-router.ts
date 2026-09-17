export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMProvider {
  name: string;
  generate(messages: LLMMessage[]): Promise<string>;
  isAvailable(): Promise<boolean>;
}

export interface LLMRouterConfig {
  providers: LLMProvider[];
  fallbackProvider?: LLMProvider;
  logger?: (msg: string, meta?: any) => void;
}

export class LLMRouter {
  private providers: LLMProvider[];
  private fallbackProvider?: LLMProvider;
  private logger?: (msg: string, meta?: any) => void;

  constructor(config: LLMRouterConfig) {
    this.providers = config.providers ?? [];
    if (config.fallbackProvider) {
      this.fallbackProvider = config.fallbackProvider;
    }
    this.logger = config.logger;
  }

  public async complete(messages: LLMMessage[]): Promise<{ response: string; providerUsed: string }> {
    // 1. Attempt primary cloud providers (Groq, Gemini, etc.)
    for (const provider of this.providers) {
      try {
        const available = await provider.isAvailable();
        if (!available) continue;

        const response = await provider.generate(messages);
        if (response && response.trim().length > 0) {
          return { response, providerUsed: provider.name };
        }
      } catch (err) {
        this.logWarn(`Primary provider ${provider.name} failed, trying next provider:`, err);
      }
    }

    // 2. Fail over to local llama-cpp engine if all cloud providers fail
    if (this.fallbackProvider) {
      this.logWarn('All primary LLM providers failed. Triggering local llama-cpp fallback.');
      try {
        const response = await this.fallbackProvider.generate(messages);
        return { response, providerUsed: this.fallbackProvider.name };
      } catch (err) {
        this.logError('Local llama-cpp fallback failed:', err);
        throw new Error('All LLM providers (including local llama-cpp fallback) failed to generate a response.');
      }
    }

    throw new Error('No available LLM providers configured or reachable.');
  }

  private logWarn(msg: string, meta?: any): void {
    if (this.logger) this.logger(`[LLMRouter WARN] ${msg}`, meta);
  }

  private logError(msg: string, meta?: any): void {
    if (this.logger) this.logger(`[LLMRouter ERROR] ${msg}`, meta);
  }
}