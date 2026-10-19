// /api/queues. With statistics off the broker leaves `policy`, `operator_policy`,
// `effective_policy_definition` and `delivery_limit` out before 4.2.5 and the message counts out
// unless `enable_queue_totals` is set (DC-32), so every field that may be missing is optional.
import { z } from 'zod';

import { defineEndpoint, defineList } from './define.ts';

export const QueueSchema = z.object({
  name: z.string(),
  vhost: z.string(),
  type: z.string().optional(),
  durable: z.boolean().optional(),
  auto_delete: z.boolean().optional(),
  exclusive: z.boolean().optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  node: z.string().optional(),
  state: z.string().optional(),
  messages: z.number().optional(),
  messages_ready: z.number().optional(),
  messages_unacknowledged: z.number().optional(),
  consumers: z.number().optional(),
  policy: z.string().nullable().optional(),
  operator_policy: z.string().nullable().optional(),
  effective_policy_definition: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional(),
  delivery_limit: z.union([z.number(), z.string()]).nullable().optional(),
});
export type MgmtQueue = z.infer<typeof QueueSchema>;

const COLUMNS = [
  'name',
  'vhost',
  'type',
  'durable',
  'auto_delete',
  'exclusive',
  'arguments',
  'node',
  'state',
  'messages',
  'messages_ready',
  'messages_unacknowledged',
  'consumers',
  'policy',
  'operator_policy',
  'effective_policy_definition',
  'delivery_limit',
] as const;

export const queues = {
  list: defineList({
    id: 'queues.list',
    template: '/api/queues',
    item: QueueSchema,
    columns: COLUMNS,
    stats: true,
  }),
  inVhost: defineList({
    id: 'queues.inVhost',
    template: '/api/queues/{vhost}',
    item: QueueSchema,
    columns: COLUMNS,
    stats: true,
  }),
  one: defineEndpoint({
    id: 'queues.one',
    template: '/api/queues/{vhost}/{name}',
    schema: QueueSchema,
    stats: true,
  }),
};

/** `POST /api/queues/{vhost}/{name}/get`: the side-effect-aware peek over HTTP (DC-10/55). */
export const GetMessagesBodySchema = z.object({
  count: z.number().int().min(1),
  ackmode: z.enum([
    'ack_requeue_true',
    'ack_requeue_false',
    'reject_requeue_true',
    'reject_requeue_false',
  ]),
  encoding: z.enum(['auto', 'base64']),
  truncate: z.number().int().min(1).optional(),
  requeue: z.boolean().optional(),
});
export type GetMessagesBody = z.infer<typeof GetMessagesBodySchema>;

export const MessageSchema = z.object({
  payload_bytes: z.number().optional(),
  redelivered: z.boolean().optional(),
  exchange: z.string().optional(),
  routing_key: z.string().optional(),
  message_count: z.number().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  payload: z.string().optional(),
  payload_encoding: z.string().optional(),
});
export type MgmtMessage = z.infer<typeof MessageSchema>;

export const queueGet = defineEndpoint({
  id: 'queues.get',
  template: '/api/queues/{vhost}/{name}/get',
  schema: z.array(MessageSchema),
});
