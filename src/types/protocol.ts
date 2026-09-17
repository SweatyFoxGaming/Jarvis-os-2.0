import { z } from 'zod';

export const EventTypeSchema = z.enum([
  'system.ping',
  'system.pong',
  'voice.state',
  'command.execute',
  'command.result',
  'system.error',
]);

export type EventType = z.infer<typeof EventTypeSchema>;

export const EventEnvelopeSchema = z.object({
  event_type: EventTypeSchema,
  correlation_id: z.string().uuid(),
  payload: z.record(z.string(), z.any()).default({}),
  timestamp: z.string().datetime(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.record(z.string(), z.any()).optional(),
    })
    .nullable()
    .optional(),
});

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;