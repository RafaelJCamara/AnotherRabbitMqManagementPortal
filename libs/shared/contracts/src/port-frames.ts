// Desktop MessagePort envelope (ADR-002): the REST router is tunnelled through fastify.inject and
// the live protocol rides the same port. Large bodies are streamed as `http.chunk` frames.
import { z } from 'zod';
import { ClientFrameSchema, ServerFrameSchema } from './live-frames.ts';

const id = z.number().int().nonnegative();
const headers = z.record(z.string(), z.string());
const body = z.union([z.string(), z.instanceof(ArrayBuffer)]);

export const PortFrameSchema = z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('http.req'),
    id,
    method: z.string(),
    url: z.string(),
    headers,
    body: body.optional(),
  }),
  z.strictObject({
    t: z.literal('http.res'),
    id,
    status: z.number().int().min(100).max(599),
    headers,
    body: body.optional(),
    streamed: z.boolean().optional(),
  }),
  z.strictObject({
    t: z.literal('http.chunk'),
    id,
    body: z.instanceof(ArrayBuffer),
    last: z.boolean(),
  }),
  z.strictObject({ t: z.literal('http.abort'), id }),
  z.strictObject({
    t: z.literal('live'),
    frame: z.union([ClientFrameSchema, ServerFrameSchema]),
  }),
]);
export type PortFrame = z.infer<typeof PortFrameSchema>;
