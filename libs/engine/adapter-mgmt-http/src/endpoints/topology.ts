// Exchanges, bindings and vhosts: the topology objects.
import { z } from 'zod';

import { defineEndpoint, defineList } from './define.ts';

const Args = z.record(z.string(), z.unknown());

export const ExchangeSchema = z.object({
  name: z.string(),
  vhost: z.string(),
  type: z.string(),
  durable: z.boolean().optional(),
  auto_delete: z.boolean().optional(),
  internal: z.boolean().optional(),
  arguments: Args.optional(),
  user_who_performed_action: z.string().optional(),
});
export type MgmtExchange = z.infer<typeof ExchangeSchema>;

const EXCHANGE_COLUMNS = [
  'name',
  'vhost',
  'type',
  'durable',
  'auto_delete',
  'internal',
  'arguments',
] as const;

export const exchanges = {
  list: defineList({
    id: 'exchanges.list',
    template: '/api/exchanges',
    item: ExchangeSchema,
    columns: EXCHANGE_COLUMNS,
  }),
  inVhost: defineList({
    id: 'exchanges.inVhost',
    template: '/api/exchanges/{vhost}',
    item: ExchangeSchema,
    columns: EXCHANGE_COLUMNS,
  }),
  one: defineEndpoint({
    id: 'exchanges.one',
    template: '/api/exchanges/{vhost}/{name}',
    schema: ExchangeSchema,
  }),
};

export const BindingSchema = z.object({
  source: z.string(),
  vhost: z.string(),
  destination: z.string(),
  destination_type: z.string(),
  routing_key: z.string(),
  // `null` on the binding of the default exchange (LavinMQ, golden fixtures, M0-25).
  arguments: Args.nullable().optional(),
  properties_key: z.string().optional(),
});
export type MgmtBinding = z.infer<typeof BindingSchema>;

export const bindings = {
  list: defineList({
    id: 'bindings.list',
    template: '/api/bindings',
    item: BindingSchema,
  }),
  inVhost: defineList({
    id: 'bindings.inVhost',
    template: '/api/bindings/{vhost}',
    item: BindingSchema,
  }),
  /** Bindings whose source is this exchange. */
  fromExchange: defineList({
    id: 'bindings.fromExchange',
    template: '/api/exchanges/{vhost}/{name}/bindings/source',
    item: BindingSchema,
  }),
  /** Bindings of one queue. */
  ofQueue: defineList({
    id: 'bindings.ofQueue',
    template: '/api/queues/{vhost}/{name}/bindings',
    item: BindingSchema,
  }),
};

export const VhostSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  default_queue_type: z.string().optional(),
  tracing: z.boolean().optional(),
  metadata: z
    .object({
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      default_queue_type: z.string().optional(),
    })
    .optional(),
});
export type MgmtVhost = z.infer<typeof VhostSchema>;

export const vhosts = {
  // The golden fixtures (M0-25): `GET /api/vhosts?page=1&page_size=100` answers 500 on 4.0.9,
  // 4.1.8, 4.2.9 and 4.3.6 (3.13.7 and LavinMQ accept it). The plain list is a bare array.
  list: defineList({
    id: 'vhosts.list',
    template: '/api/vhosts',
    item: VhostSchema,
    paged: false,
  }),
  one: defineEndpoint({
    id: 'vhosts.one',
    template: '/api/vhosts/{vhost}',
    schema: VhostSchema,
  }),
};
