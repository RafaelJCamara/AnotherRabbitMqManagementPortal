// The live protocol (ADR-005): one multiplexed channel with credits and per-topic QoS. The frames
// are identical on the WebSocket and on the desktop MessagePort. Item payloads are validated per
// topic against `TopicDef.item`, so the frame schema leaves them as `unknown`.
import { z } from 'zod';
import { TopicIdSchema } from './brands.ts';
import { QosSchema } from './config/env.ts';
import { ProblemSchema } from './errors.ts';

const sid = z.number().int().nonnegative();
const seq = z.number().int().nonnegative();

export const ClientFrameSchema = z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('hello'),
    v: z.literal(1),
    resume: z
      .strictObject({
        session: z.string(),
        lastSeq: z.record(z.string(), seq),
      })
      .optional(),
  }),
  z.strictObject({
    t: z.literal('sub'),
    sid,
    topic: TopicIdSchema,
    params: z.unknown(),
    credit: z.number().int().nonnegative(),
  }),
  z.strictObject({
    t: z.literal('credit'),
    sid,
    n: z.number().int().positive(),
  }),
  z.strictObject({ t: z.literal('unsub'), sid }),
  z.strictObject({ t: z.literal('ping'), ts: z.number() }),
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

export const ServerFrameSchema = z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('welcome'),
    v: z.literal(1),
    session: z.string(),
    engineVersion: z.string(),
    limits: z.strictObject({
      maxSubs: z.literal(64),
      outboxBytes: z.number().int().positive(),
      maxFrameBytes: z.number().int().positive(),
    }),
  }),
  z.strictObject({ t: z.literal('subok'), sid, qos: QosSchema }),
  z.strictObject({
    t: z.literal('data'),
    sid,
    seq,
    items: z.array(z.unknown()),
    dropped: z.number().int().positive().optional(),
    sampledEvery: z.number().int().positive().optional(),
  }),
  z.strictObject({
    t: z.literal('snapshot'),
    sid,
    seq,
    items: z.array(z.unknown()),
  }),
  z.strictObject({
    t: z.literal('delta'),
    sid,
    seq,
    upserts: z.array(z.unknown()),
    removes: z.array(z.string()),
  }),
  z.strictObject({
    t: z.literal('status'),
    sid,
    state: z.enum(['active', 'paused', 'degraded', 'stale']),
  }),
  z.strictObject({
    t: z.literal('gap'),
    sid,
    fromSeq: seq,
    toSeq: seq,
    reason: z.enum(['overflow', 'resume-unavailable', 'engine-restart']),
  }),
  z.strictObject({
    t: z.literal('end'),
    sid,
    reason: z.enum(['unsub', 'completed', 'lease_expired', 'error']),
    problem: ProblemSchema.optional(),
  }),
  z.strictObject({
    t: z.literal('goaway'),
    reason: z.enum(['drain', 'version-mismatch', 'auth-expired']),
    reconnectAfterMs: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({ t: z.literal('pong'), ts: z.number() }),
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;
