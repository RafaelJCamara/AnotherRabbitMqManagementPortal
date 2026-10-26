// The management rows the peek preflight reads (M1-13 slice B), as this service's own schemas (a
// service imports no adapter). Every field a stats-off or provider-restricted broker may leave out
// is optional, and `nullish` keeps "absent" and "null" apart (`policy: null` is a queue with no
// policy; an absent `policy` is a broker that did not say). A key not named here is dropped when
// the row is parsed, so a free-text field never reaches the outcome (I-10).
import { z } from 'zod';

const table = z.record(z.string(), z.unknown());

export const QueueRowSchema = z.object({
  name: z.string(),
  type: z.string().nullish(),
  durable: z.boolean().nullish(),
  auto_delete: z.boolean().nullish(),
  exclusive: z.boolean().nullish(),
  arguments: table.nullish(),
  consumers: z.number().nullish(),
  messages: z.number().nullish(),
  messages_ready: z.number().nullish(),
  message_bytes: z.number().nullish(),
  message_bytes_ready: z.number().nullish(),
  policy: z.string().nullish(),
  operator_policy: z.string().nullish(),
  effective_policy_definition: table.nullish(),
  delivery_limit: z.union([z.number(), z.string()]).nullish(),
  delayed_retry: z.string().nullish(),
  leader: z.string().nullish(),
  members: z.array(z.string()).nullish(),
  online: z.array(z.string()).nullish(),
});
export type QueueRow = z.infer<typeof QueueRowSchema>;

export const ConsumerRowSchema = z.object({
  queue: z.object({ name: z.string() }),
  active: z.boolean().nullish(),
});

/** A list is a bare array on RabbitMQ and a paged envelope on some providers; both are one page. */
const listOf = <T extends z.ZodType>(item: T) =>
  z.union([
    z.array(item),
    z.object({
      items: z.array(item),
      page_count: z.number().nullish(),
      total_count: z.number().nullish(),
    }),
  ]);

// One schema object per list: the scheduler dedupes reads by the identity of the schema.
export const ConsumerListSchema = listOf(ConsumerRowSchema);

/** The rows of a list answer, and how many more the broker said it has (never silently dropped). */
export function rowsOf<T>(
  answer:
    | readonly T[]
    | {
        readonly items: readonly T[];
        readonly page_count?: number | null | undefined;
        readonly total_count?: number | null | undefined;
      },
): { readonly rows: readonly T[]; readonly more: number } {
  if (Array.isArray(answer)) return { rows: answer, more: 0 };
  const paged = answer as {
    items: readonly T[];
    page_count?: number | null;
    total_count?: number | null;
  };
  const known = (paged.total_count ?? 0) - paged.items.length;
  const further = (paged.page_count ?? 1) > 1 ? 1 : 0;
  return { rows: paged.items, more: Math.max(known, further, 0) };
}
