// The management answers this service reads, as its own schemas (a service imports no adapter): they
// name only the fields the topology uses. A key the broker left out stays `undefined`, a key it sent
// as `null` stays `null`: the difference is the point (below 4.2.5 with statistics off `policy` is
// absent, and a queue with no policy has `policy: null`), so nothing here defaults or strips a null.
import { z } from 'zod';

const args = z.record(z.string(), z.unknown());

export const QueueRowSchema = z.object({
  name: z.string(),
  type: z.string().nullish(),
  arguments: args.nullish(),
  /** Absent: the broker did not send the field (stats gap). `null`: the queue has no policy. */
  policy: z.string().nullable().optional(),
  operator_policy: z.string().nullable().optional(),
  delivery_limit: z.union([z.number(), z.string()]).nullable().optional(),
});
export type QueueRow = z.infer<typeof QueueRowSchema>;

export const ExchangeRowSchema = z.object({
  name: z.string(),
  type: z.string(),
  internal: z.boolean().nullish(),
  arguments: args.nullish(),
});
export type ExchangeRow = z.infer<typeof ExchangeRowSchema>;

export const BindingRowSchema = z.object({
  source: z.string(),
  destination: z.string(),
  destination_type: z.string(),
  routing_key: z.string(),
  // `null` on the binding of the default exchange (LavinMQ, golden fixtures, M0-25).
  arguments: args.nullish(),
});
export type BindingRow = z.infer<typeof BindingRowSchema>;

export const PolicyRowSchema = z.object({
  name: z.string(),
  pattern: z.string(),
  'apply-to': z.string(),
  priority: z.number(),
  definition: args,
});
export type PolicyRow = z.infer<typeof PolicyRowSchema>;

export const ConsumerRowSchema = z.object({
  queue: z.object({ name: z.string() }),
  ack_required: z.boolean().nullish(),
});
export type ConsumerRow = z.infer<typeof ConsumerRowSchema>;

const page = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    page: z.number().int(),
    page_count: z.number().int(),
    total_count: z.number().int().nonnegative().optional(),
  });

// One schema object per list: the scheduler dedupes reads by the identity of the schema.
export const QueuePageSchema = page(QueueRowSchema);
export const ExchangePageSchema = page(ExchangeRowSchema);
/** A bare array on RabbitMQ (the endpoint ignores `page`, OQ-433); a paged envelope on other providers. */
export const BindingListSchema = z.union([
  z.array(BindingRowSchema),
  page(BindingRowSchema),
]);
export const PolicyListSchema = z.array(PolicyRowSchema);
/** `/api/consumers/{vhost}` is a bare array; a paged envelope is accepted too (other providers). */
export const ConsumerListSchema = z.union([
  z.array(ConsumerRowSchema),
  page(ConsumerRowSchema),
]);
