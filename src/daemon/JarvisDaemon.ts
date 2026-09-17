import { createClient, RedisClientType } from 'redis';
import { EventEmitter } from 'events';
import { DirectiveOrchestrator } from '../orchestration/DirectiveOrchestrator';

export class JarvisDaemon extends EventEmitter {
  private redisClient: RedisClientType | null = null;
  private subscriberClient: RedisClientType | null = null;
  private orchestrator: DirectiveOrchestrator;
  private isRunning: boolean = false;
  private redisUrl: string;
  private channelName: string;
  private useMemoryFallback: boolean = false;

  constructor(redisUrl: string = 'redis://localhost:6379', channelName: string = 'jarvis:directives') {
    super();
    this.redisUrl = redisUrl;
    this.channelName = channelName;
    this.orchestrator = new DirectiveOrchestrator();
  }

  /**
   * Starts the background event loop daemon with instant fallback.
   */
  public async start(): Promise<void> {
    if (this.isRunning) return;

    try {
      this.redisClient = createClient({ url: this.redisUrl });
      this.subscriberClient = this.redisClient.duplicate();

      // Suppress default error logs during connection probe
      this.redisClient.on('error', () => {});
      this.subscriberClient.on('error', () => {});

      // Race the connection against a 300ms timeout for instant fallback if Redis is offline
      await Promise.race([
        this.redisClient.connect(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Redis connection timeout')), 300))
      ]);

      await this.subscriberClient.connect();
      this.useMemoryFallback = false;
      this.isRunning = true;
      console.log(`\n👁️ [Jarvis Background Daemon] Connected to Redis on "${this.channelName}"...`);

      await this.subscriberClient.subscribe(this.channelName, async (message) => {
        await this.handleMessage(message);
      });
    } catch {
      this.useMemoryFallback = true;
      this.isRunning = true;
      console.log(`⚡ [Jarvis Background Daemon] Initialized in High-Performance In-Memory Event Loop Mode.`);
    }
  }

  private async handleMessage(message: string): Promise<void> {
    try {
      const payload = JSON.parse(message);
      console.log(`\n🔔 [Daemon Event Received]:`, payload);

      const directive = payload.directive || 'Perform automated system telemetry scan';
      const inputData = payload.data || {};

      const result = await this.orchestrator.executeDirective(directive, inputData);
      
      const outputPayload = JSON.stringify({
        status: 'SUCCESS',
        directive,
        result,
        timestamp: Date.now()
      });

      if (!this.useMemoryFallback && this.redisClient) {
        await this.redisClient.publish(`${this.channelName}:results`, outputPayload);
      } else {
        this.emit('result', JSON.parse(outputPayload));
      }

      console.log(`📤 [Daemon Event Handled Successfully] ✓`);
    } catch (err: any) {
      console.error(`❌ [Daemon Event Error]:`, err.message);
    }
  }

  /**
   * Dispatches a directive into the daemon.
   */
  public async dispatchDirective(directive: string, data: any): Promise<void> {
    const message = JSON.stringify({ directive, data });
    if (!this.useMemoryFallback && this.redisClient) {
      await this.redisClient.publish(this.channelName, message);
    } else {
      setTimeout(async () => {
        await this.handleMessage(message);
      }, 50);
    }
  }

  /**
   * Stops the daemon gracefully.
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (!this.useMemoryFallback) {
      try {
        if (this.subscriberClient) {
          await this.subscriberClient.unsubscribe(this.channelName);
          await this.subscriberClient.quit();
        }
        if (this.redisClient) {
          await this.redisClient.quit();
        }
      } catch {}
    }
    console.log(`🛑 [Jarvis Background Daemon] Stopped.`);
  }
}
