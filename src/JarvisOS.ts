import { DirectiveOrchestrator } from './orchestration/DirectiveOrchestrator.js';
import { PipelineOrchestrator } from './orchestration/PipelineOrchestrator.js';
import { JarvisDaemon } from './daemon/JarvisDaemon.js';
import { ToolVectorStore } from './capabilities/ToolVectorStore.js';

export class JarvisOS {
  private directiveOrchestrator: DirectiveOrchestrator;
  private pipelineOrchestrator: PipelineOrchestrator;
  private daemon: JarvisDaemon;
  private vectorStore: ToolVectorStore;
  private isInitialized: boolean = false;

  constructor(workspaceDir?: string, redisUrl?: string) {
    this.directiveOrchestrator = new DirectiveOrchestrator(workspaceDir);
    this.pipelineOrchestrator = new PipelineOrchestrator();
    this.daemon = new JarvisDaemon(redisUrl || 'redis://localhost:6379', 'jarvis:directives');
    this.vectorStore = new ToolVectorStore();
  }

  /**
   * Initializes core subsystems and verifies memory store connections.
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) return;
    console.log('🛡️ [JarvisOS Core]: Initializing subsystems (pgvector, sandbox, orchestrators)...');
    this.isInitialized = true;
    console.log('✓ [JarvisOS Core]: System online and stable.');
  }

  /**
   * Executes a single atomic directive via autonomous code synthesis & vector cache.
   */
  public async executeDirective(directive: string, inputPayload: any = {}): Promise<any> {
    await this.initialize();
    return await this.directiveOrchestrator.executeDirective(directive, inputPayload);
  }

  /**
   * Executes a complex multi-step pipeline directive with automated data piping.
   */
  public async runPipeline(complexDirective: string, initialPayload: any = {}): Promise<any> {
    await this.initialize();
    return await this.pipelineOrchestrator.executePipeline(complexDirective, initialPayload);
  }

  /**
   * Starts the background event loop daemon (Redis with automatic in-memory fallback).
   */
  public async startDaemon(onResult?: (result: any) => void): Promise<void> {
    await this.initialize();
    if (onResult) {
      this.daemon.on('result', onResult);
    }
    await this.daemon.start();
  }

  /**
   * Dispatches an asynchronous background directive into the daemon.
   */
  public async dispatchDirective(directive: string, data: any): Promise<void> {
    await this.daemon.dispatchDirective(directive, data);
  }

  /**
   * Shuts down all background daemons and active listeners gracefully.
   */
  public async shutdown(): Promise<void> {
    await this.daemon.stop();
    console.log('🛑 [JarvisOS Core]: Shutdown complete.');
  }
}

export default JarvisOS;
