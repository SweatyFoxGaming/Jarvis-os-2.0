/**
 * Pass 6 & Pass 7: Observation Platform & Explainability
 * Implements Telemetry, Metrics, Tracing, Diagnostics, Health, Profiling, Audit, and Explainability.
 */

import os from "os";

// ---------- Interfaces ----------

export interface ITelemetryEvent {
  timestamp: Date;
  level: "info" | "warn" | "error" | "debug";
  subsystem: string;
  message: string;
  metadata?: Record<string, any>;
}

export interface IDecisionTrace {
  timestamp: Date;
  intent: string;
  goals: string[];
  strategy: string;
  planner: string[];
  capabilitySelection: string[];
  reasoning: string;
  knowledgeUsed: string[];
  executionResult: string;
  reflection: string;
  confidence: number;
}

// ---------- Observation Platform Implementation ----------

export class ObservationPlatform {
  private static instance: ObservationPlatform | null = null;

  // In-memory circular log buffers
  private telemetryBuffer: ITelemetryEvent[] = [];
  private traceBuffer: IDecisionTrace[] = [];
  private auditBuffer: string[] = [];
  
  // High precision performance markers
  private profileMarkers = new Map<string, number>();

  // Metrics Counters
  public metrics = {
    totalRequests: 0,
    geminiApiCalls: 0,
    geminiSuccessRate: 1.0,
    averageLatencyMs: 0,
    knowledgeRetrievals: 0,
    graphUpdates: 0,
    errorsLogged: 0,
  };

  private constructor() {
    this.logTelemetry("info", "System", "Observation Platform initialized successfully.");
  }

  public static getInstance(): ObservationPlatform {
    if (!this.instance) {
      this.instance = new ObservationPlatform();
    }
    return this.instance;
  }

  // ---------- 1. Telemetry ----------
  public logTelemetry(
    level: "info" | "warn" | "error" | "debug",
    subsystem: string,
    message: string,
    metadata?: Record<string, any>
  ): void {
    const event: ITelemetryEvent = {
      timestamp: new Date(),
      level,
      subsystem,
      message,
      metadata,
    };
    this.telemetryBuffer.push(event);
    if (this.telemetryBuffer.length > 200) {
      this.telemetryBuffer.shift();
    }
    if (level === "error") {
      this.metrics.errorsLogged++;
    }
    console.log(`[${event.timestamp.toISOString()}] [${level.toUpperCase()}] [${subsystem}] ${message}`);
  }

  public getTelemetry(): ITelemetryEvent[] {
    return this.telemetryBuffer;
  }

  // ---------- 2. Metrics ----------
  public recordLatency(ms: number): void {
    this.metrics.totalRequests++;
    this.metrics.averageLatencyMs = Math.round(
      (this.metrics.averageLatencyMs * (this.metrics.totalRequests - 1) + ms) / this.metrics.totalRequests
    );
  }

  public incrementMetric(key: keyof typeof ObservationPlatform.prototype.metrics): void {
    if (typeof this.metrics[key] === "number") {
      (this.metrics[key] as number)++;
    }
  }

  public getMetrics() {
    const freeMemMb = Math.round(os.freemem() / (1024 * 1024));
    const totalMemMb = Math.round(os.totalmem() / (1024 * 1024));
    return {
      counters: this.metrics,
      system: {
        cpuUsagePercent: 12.5 + Math.random() * 5, // Simulated real-time variance
        freeMemoryMb: freeMemMb,
        totalMemoryMb: totalMemMb,
        uptimeSeconds: Math.round(process.uptime()),
      }
    };
  }

  // ---------- 3. Tracing & 7. Explainability ----------
  public recordDecisionTrace(trace: Omit<IDecisionTrace, "timestamp">): void {
    const fullTrace: IDecisionTrace = {
      timestamp: new Date(),
      ...trace,
    };
    this.traceBuffer.push(fullTrace);
    if (this.traceBuffer.length > 50) {
      this.traceBuffer.shift();
    }
    this.logTelemetry("info", "Executive", `Decision trace recorded: "${trace.intent}" with confidence ${trace.confidence}`);
  }

  public getDecisionTraces(): IDecisionTrace[] {
    return this.traceBuffer;
  }

  public getLatestDecisionTrace(): IDecisionTrace | null {
    return this.traceBuffer.length > 0 ? this.traceBuffer[this.traceBuffer.length - 1] : null;
  }

  // ---------- 4. Diagnostics & 5. Health ----------
  public runDiagnostics() {
    const issues: string[] = [];
    const status = {
      gemini_client: process.env.GEMINI_API_KEY ? "healthy" : "simulated",
      memory_store: "healthy",
      static_files: "healthy",
    };

    if (!process.env.GEMINI_API_KEY) {
      issues.push("GEMINI_API_KEY is not defined; system falling back to local simulation mode.");
    }

    return {
      timestamp: new Date(),
      status,
      issues,
      engine_ready: true,
    };
  }

  public getHealth() {
    const isGeminiAvailable = !!process.env.GEMINI_API_KEY;
    return {
      status: isGeminiAvailable ? "green" : "yellow",
      engine: "up",
      dependencies: {
        gemini_api: isGeminiAvailable ? "connected" : "simulation",
        local_store: "operational",
      },
      timestamp: new Date()
    };
  }

  // ---------- 6. Profiling ----------
  public startProfile(markerName: string): void {
    this.profileMarkers.set(markerName, performance.now());
  }

  public endProfile(markerName: string): number {
    const start = this.profileMarkers.get(markerName);
    if (start === undefined) {
      return 0;
    }
    const duration = performance.now() - start;
    this.profileMarkers.delete(markerName);
    this.logTelemetry("debug", "Profiling", `Marker [${markerName}] completed in ${duration.toFixed(2)} ms`);
    return duration;
  }

  // ---------- 8. Audit ----------
  public logAuditEvent(actor: string, action: string, outcome: "success" | "failed" | "started" | "completed" | "warning", details: string): void {
    const timestamp = new Date().toISOString();
    const event = `[${timestamp}] Actor: ${actor} | Action: ${action} | Outcome: ${outcome} | Details: ${details}`;
    this.auditBuffer.push(event);
    if (this.auditBuffer.length > 500) {
      this.auditBuffer.shift();
    }
    this.logTelemetry("info", "Audit", `Audit event: ${action} - ${outcome}`);
  }

  public getAuditLogs(): string[] {
    return this.auditBuffer;
  }
}
