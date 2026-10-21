// Management answer to row. The schemas are this service's own (a service imports no adapter): they
// name only the fields the explorer reads. A field the broker did not send, or sent as null, is
// absent from the row, never defaulted (AC-9).
import {
  encodeObjectKey,
  type ExchangeRowSchema,
  type QueueRowSchema,
} from '@app/contracts';
import { z } from 'zod';

export type QueueRow = z.infer<typeof QueueRowSchema>;
export type ExchangeRow = z.infer<typeof ExchangeRowSchema>;
export type IndexRow = QueueRow | ExchangeRow;

/** The most items a management page carries (the adapter's page ceiling). */
const PAGE_ITEMS_MAX = 500;

const count = z.number().int().nonnegative().nullish();
const text = z.string().nullish();
const flag = z.boolean().nullish();

const MgmtQueueSchema = z.object({
  name: z.string(),
  vhost: z.string(),
  type: text,
  state: text,
  node: text,
  durable: flag,
  auto_delete: flag,
  exclusive: flag,
  messages: count,
  messages_ready: count,
  messages_unacknowledged: count,
  consumers: count,
  policy: text,
  operator_policy: text,
  delivery_limit: z.number().int().nullish(),
});

const MgmtExchangeSchema = z.object({
  name: z.string(),
  vhost: z.string(),
  type: text,
  durable: flag,
  auto_delete: flag,
  internal: flag,
});

const page = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item).max(PAGE_ITEMS_MAX),
    page: z.number().int(),
    page_count: z.number().int(),
  });

// One schema object per kind: the scheduler dedupes reads by the identity of the schema.
export const QueuePageSchema = page(MgmtQueueSchema);
export const ExchangePageSchema = page(MgmtExchangeSchema);
export const VhostListSchema = z.array(z.object({ name: z.string() }));

/** Drops the members the broker left out (undefined or null). */
function present<T>(members: {
  [K in keyof T]: T[K] | null | undefined;
}): T {
  return Object.fromEntries(
    Object.entries(members).filter(([, value]) => value != null),
  ) as T;
}

export function queueRow(raw: z.infer<typeof MgmtQueueSchema>): QueueRow {
  return present<QueueRow>({
    key: encodeObjectKey(raw.vhost, raw.name),
    vhost: raw.vhost,
    name: raw.name,
    type: raw.type,
    state: raw.state,
    node: raw.node,
    durable: raw.durable,
    autoDelete: raw.auto_delete,
    exclusive: raw.exclusive,
    messages: raw.messages,
    messagesReady: raw.messages_ready,
    messagesUnacknowledged: raw.messages_unacknowledged,
    consumers: raw.consumers,
    policy: raw.policy,
    operatorPolicy: raw.operator_policy,
    deliveryLimit: raw.delivery_limit,
  });
}

export function exchangeRow(
  raw: z.infer<typeof MgmtExchangeSchema>,
): ExchangeRow {
  return present<ExchangeRow>({
    key: encodeObjectKey(raw.vhost, raw.name),
    vhost: raw.vhost,
    name: raw.name,
    type: raw.type,
    durable: raw.durable,
    autoDelete: raw.auto_delete,
    internal: raw.internal,
  });
}
