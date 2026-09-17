// src/services/streamBuffer.ts
export interface StreamEvent {
  id: number;
  data: string;
  event?: string;
}

export class StreamBuffer {
  private buffer: StreamEvent[] = [];
  private readonly maxCapacity: number;

  constructor(maxCapacity = 100) {
    this.maxCapacity = maxCapacity;
  }

  public push(event: Omit<StreamEvent, 'id'>): StreamEvent {
   const lastItem = this.buffer[this.buffer.length - 1];
    const id = lastItem ? lastItem.id + 1 : 1; 
    const fullEvent = { ...event, id };
    this.buffer.push(fullEvent);
    if (this.buffer.length > this.maxCapacity) {
      this.buffer.shift();
    }
    return fullEvent;
  }

  public getEventsSince(lastEventId: number): StreamEvent[] {
    return this.buffer.filter((e) => e.id > lastEventId);
  }
}
