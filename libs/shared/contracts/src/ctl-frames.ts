// Control channel between the desktop main process and the engine utility process (blueprint 2.3).
// Every frame is validated on receipt. Not part of the published specs: it never leaves the machine.
import { z } from 'zod';

export const CtlFrameSchema = z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('init'),
    paths: z.strictObject({ data: z.string(), logs: z.string() }),
    dek: z.instanceof(Uint8Array).optional(),
    // Validated by the settings schema in the engine, not by the transport.
    settings: z.unknown(),
  }),
  z.strictObject({
    t: z.literal('ready'),
    contract: z.string(),
    schemaHash: z.string(),
  }),
  z.strictObject({ t: z.literal('attach'), windowId: z.number().int() }),
  z.strictObject({
    t: z.literal('shutdown'),
    deadlineMs: z.number().int().positive(),
  }),
  z.strictObject({
    t: z.literal('suspend'),
    deadlineMs: z.number().int().positive(),
  }),
  z.strictObject({ t: z.literal('resume') }),
  z.strictObject({
    t: z.literal('notify'),
    title: z.string(),
    body: z.string(),
  }),
  z.strictObject({
    t: z.literal('save'),
    fileToken: z.string(),
    artifactId: z.string(),
  }),
]);
export type CtlFrame = z.infer<typeof CtlFrameSchema>;
