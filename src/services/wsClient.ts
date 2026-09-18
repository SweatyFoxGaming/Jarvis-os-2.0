import { WebSocket } from 'ws';
import { EventEnvelopeSchema, EventEnvelope, EventType } from '../types/protocol.js';

export type MessageHandler = (envelope: EventEnvelope) => void;

export class JarvisWSClient {
  private ws: WebSocket | null = null;
  private url: string;
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectDelay: number = 30000; // 30s cap
  private baseReconnectDelay: number = 1000;  // 1s base
  private messageQueue: string[] = [];
  private handlers: Map<string, Set<MessageHandler>> = new Map();
  private pingInterval: NodeJS.Timeout | null = null;

  constructor(url: string = 'ws://127.0.0.1:8765') {
    this.url = url;
  }

  public connect(): void {
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      console.log('[WS] Connected to Jarvis OS Daemon');
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.flushQueue();
      this.startHeartbeat();
    });

    this.ws.on('message', (data: string) => {
      this.handleIncomingMessage(data.toString());
    });

    this.ws.on('close', () => {
      console.warn('[WS] Connection closed');
      this.cleanup();
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error('[WS] Socket error:', err.message);
      this.ws?.close();
    });
  }

  public send(envelope: EventEnvelope): void {
    const raw = JSON.stringify(envelope);
    if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(raw);
    } else {
      console.warn('[WS] Disconnected. Queueing message:', envelope.correlation_id);
      this.messageQueue.push(raw);
    }
  }

  public subscribe(eventType: EventType, handler: MessageHandler): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);

    return () => {
      this.handlers.get(eventType)?.delete(handler);
    };
  }

  private handleIncomingMessage(rawData: string): void {
    try {
      const parsed = JSON.parse(rawData);
      const validationResult = EventEnvelopeSchema.safeParse(parsed);

      if (!validationResult.success) {
        console.error('[WS] Protocol error: Malformed envelope', validationResult.error.format());
        return;
      }

      const envelope = validationResult.data;

      if (envelope.event_type === 'system.pong') {
        return; // Heartbeat ACK
      }

      const callbacks = this.handlers.get(envelope.event_type);
      if (callbacks) {
        callbacks.forEach((cb) => cb(envelope));
      }
    } catch (err) {
      console.error('[WS] Failed to parse message frame:', err);
    }
  }

  private startHeartbeat(): void {
    this.pingInterval = setInterval(() => {
      if (this.isConnected) {
        this.send({
          event_type: 'system.ping',
          correlation_id: crypto.randomUUID(),
          payload: {},
          timestamp: new Date().toISOString(),
        });
      }
    }, 10000);
  }

  private flushQueue(): void {
    while (this.messageQueue.length > 0 && this.isConnected) {
      const msg = this.messageQueue.shift();
      if (msg && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(msg);
      }
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );
    this.reconnectAttempts++;
    console.log(`[WS] Reconnecting in ${delay}ms (Attempt ${this.reconnectAttempts})...`);
    setTimeout(() => this.connect(), delay);
  }

  private cleanup(): void {
    this.isConnected = false;
    if (this.pingInterval) clearInterval(this.pingInterval);
  }
}