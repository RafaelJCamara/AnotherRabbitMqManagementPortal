// Management answer to row. The schemas are this service's own (a service imports no adapter): they
// name only the fields the explorer reads. A field the broker did not send, or sent as null, is
// absent from the row, never defaulted (AC-9).
import {
  BINDING_ARGUMENTS_KEY_MAX,
  encodeObjectKey,
  type BindingRowSchema,
  type ExchangeRowSchema,
  type QueueRowSchema,
} from '@app/contracts';
import { z } from 'zod';

export type QueueRow = z.infer<typeof QueueRowSchema>;
export type ExchangeRow = z.infer<typeof ExchangeRowSchema>;
/** The rows of the swept index; bindings are served per vhost by `bindings.ts`. */
export type IndexRow = QueueRow | ExchangeRow;
export type BindingRow = z.infer<typeof BindingRowSchema>;

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

const MgmtBindingSchema = z.object({
  vhost: z.string(),
  source: z.string(),
  destination: z.string(),
  destination_type: z.string(),
  routing_key: text,
  properties_key: text,
  arguments: z.record(z.string(), z.unknown()).nullish(),
});

const page = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item).max(PAGE_ITEMS_MAX),
    page: z.number().int(),
    page_count: z.number().int(),
    total_count: z.number().int().nonnegative().optional(),
  });

/**
 * One answer of `/api/bindings/{vhost}`, whoever sent it. RabbitMQ 3.13 to 4.3 ignores `page` on this
 * endpoint and answers a bare array with every binding of the vhost (recorded on all five versions,
 * OQ-433); LavinMQ answers the paged envelope. A bare array has no item limit here: the broker already
 * sent all of it, so the cap can only be applied after the answer (OQ-688).
 */
const bindingAnswer = z.union([
  page(MgmtBindingSchema).transform((body) => ({
    items: body.items,
    pageCount: body.page_count,
    total: body.total_count,
    paged: true,
  })),
  z.array(MgmtBindingSchema).transform((items) => ({
    items,
    pageCount: 1,
    total: items.length,
    paged: false,
  })),
]);

// One schema object per kind: the scheduler dedupes reads by the identity of the schema.
export const QueuePageSchema = page(MgmtQueueSchema);
export const ExchangePageSchema = page(MgmtExchangeSchema);
export const BindingPageSchema = bindingAnswer;
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

/** The arguments with their keys sorted, so equal arguments give equal text. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, canonical(v)]),
  );
}

/**
 * A binding has no name: its identity is its source, destination type, destination and the
 * broker's `properties_key` (routing key, plus a hash of the arguments when there are any).
 */
export function bindingRow(raw: z.infer<typeof MgmtBindingSchema>): BindingRow {
  const args = raw.arguments ?? {};
  const full =
    Object.keys(args).length === 0 ? '' : JSON.stringify(canonical(args));
  const cut = full.length > BINDING_ARGUMENTS_KEY_MAX;
  return present<BindingRow>({
    key: encodeObjectKey(
      raw.vhost,
      [
        raw.source,
        raw.destination_type,
        raw.destination,
        raw.properties_key ?? raw.routing_key ?? '',
      ].join('\u0000'),
    ),
    vhost: raw.vhost,
    source: raw.source,
    destination: raw.destination,
    destinationType: raw.destination_type,
    routingKey: raw.routing_key,
    propertiesKey: raw.properties_key,
    argumentsKey:
      full === '' ? undefined : full.slice(0, BINDING_ARGUMENTS_KEY_MAX),
    argumentsTruncated: cut ? true : undefined,
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
