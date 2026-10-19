// Connections, channels and consumers: the clients of the broker. `/api/channels` is the endpoint
// the stats-off hazard is about (DC-32): it answers 400 below 4.3.6 while statistics are off, and
// `disable_stats=true` must not be sent to it there (see query.ts).
import { z } from 'zod';

import { defineEndpoint, defineList } from './define.ts';

export const ConnectionSchema = z.object({
  name: z.string(),
  vhost: z.string().optional(),
  user: z.string().optional(),
  node: z.string().optional(),
  state: z.string().optional(),
  protocol: z.string().optional(),
  channels: z.number().optional(),
  peer_host: z.string().optional(),
  peer_port: z.number().optional(),
  ssl: z.boolean().optional(),
  auth_mechanism: z.string().optional(),
  client_properties: z.record(z.string(), z.unknown()).optional(),
  connected_at: z.number().optional(),
});
export type MgmtConnection = z.infer<typeof ConnectionSchema>;

export const connections = {
  list: defineList({
    id: 'connections.list',
    template: '/api/connections',
    item: ConnectionSchema,
    stats: true,
  }),
  inVhost: defineList({
    id: 'connections.inVhost',
    template: '/api/vhosts/{vhost}/connections',
    item: ConnectionSchema,
    stats: true,
  }),
  one: defineEndpoint({
    id: 'connections.one',
    template: '/api/connections/{name}',
    schema: ConnectionSchema,
    stats: true,
  }),
};

export const ChannelSchema = z.object({
  name: z.string(),
  vhost: z.string().optional(),
  user: z.string().optional(),
  node: z.string().optional(),
  number: z.number().optional(),
  state: z.string().optional(),
  consumer_count: z.number().optional(),
  messages_unacknowledged: z.number().optional(),
  prefetch_count: z.number().optional(),
  connection_details: z
    .object({ name: z.string().optional(), peer_host: z.string().optional() })
    .optional(),
});
export type MgmtChannel = z.infer<typeof ChannelSchema>;

export const channels = {
  list: defineList({
    id: 'channels.list',
    template: '/api/channels',
    item: ChannelSchema,
    stats: true,
  }),
  inVhost: defineList({
    id: 'channels.inVhost',
    template: '/api/vhosts/{vhost}/channels',
    item: ChannelSchema,
    stats: true,
  }),
  one: defineEndpoint({
    id: 'channels.one',
    template: '/api/channels/{name}',
    schema: ChannelSchema,
    stats: true,
  }),
};

export const ConsumerSchema = z.object({
  consumer_tag: z.string(),
  queue: z.object({ name: z.string(), vhost: z.string().optional() }),
  channel_details: z
    .object({
      name: z.string().optional(),
      connection_name: z.string().optional(),
      number: z.number().optional(),
    })
    .optional(),
  ack_required: z.boolean().optional(),
  exclusive: z.boolean().optional(),
  prefetch_count: z.number().optional(),
  active: z.boolean().optional(),
  activity_status: z.string().optional(),
});
export type MgmtConsumer = z.infer<typeof ConsumerSchema>;

/** The consumer lists answer a bare array on RabbitMQ (golden fixtures, OQ-433); a bare array is one page. */
export const consumers = {
  list: defineList({
    id: 'consumers.list',
    template: '/api/consumers',
    item: ConsumerSchema,
  }),
  inVhost: defineList({
    id: 'consumers.inVhost',
    template: '/api/consumers/{vhost}',
    item: ConsumerSchema,
  }),
};
