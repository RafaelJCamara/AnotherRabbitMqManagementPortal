// /api/overview, /api/whoami, /api/extensions: what the probe reads first (fact sheet, probe
// table). Every field the engine does not depend on is optional, because another product (or an
// older release) leaves it out: LavinMQ has no `rabbitmq_version`, for instance.
import { z } from 'zod';

import { defineEndpoint } from './define.ts';

export const OverviewSchema = z.object({
  node: z.string().optional(),
  cluster_name: z.string().optional(),
  product_name: z.string().optional(),
  product_version: z.string().optional(),
  rabbitmq_version: z.string().optional(),
  lavinmq_version: z.string().optional(),
  management_version: z.string().optional(),
  erlang_version: z.string().optional(),
  default_queue_type: z.string().optional(),
  /** The statistics switches the broker reports for itself (DC-32). */
  disable_stats: z.boolean().optional(),
  enable_queue_totals: z.boolean().optional(),
  is_op_policy_updating_enabled: z.boolean().optional(),
  exchange_types: z
    .array(z.object({ name: z.string(), enabled: z.boolean().optional() }))
    .optional(),
  listeners: z
    .array(
      z.object({
        node: z.string().optional(),
        protocol: z.string(),
        port: z.number().int(),
        ip_address: z.string().optional(),
      }),
    )
    .optional(),
  object_totals: z
    .object({
      queues: z.number().optional(),
      exchanges: z.number().optional(),
      connections: z.number().optional(),
      channels: z.number().optional(),
      consumers: z.number().optional(),
    })
    .optional(),
});
export type Overview = z.infer<typeof OverviewSchema>;

export const overview = defineEndpoint({
  id: 'overview.get',
  template: '/api/overview',
  schema: OverviewSchema,
  stats: true,
});

/** `tags` is a comma-separated string on old releases and a list on current ones. */
export const WhoamiSchema = z
  .object({
    name: z.string(),
    tags: z.union([z.array(z.string()), z.string()]),
  })
  .transform((body) => ({
    name: body.name,
    tags:
      typeof body.tags === 'string'
        ? body.tags.split(',').filter((tag) => tag !== '')
        : body.tags,
  }));
export type Whoami = z.infer<typeof WhoamiSchema>;

export const whoami = defineEndpoint({
  id: 'whoami.get',
  template: '/api/whoami',
  schema: WhoamiSchema,
});

/**
 * `[]` means LavinMQ or a minimal broker. On RabbitMQ an entry is `{"javascript": "shovel.js"}`, or
 * from 4.x `{"javascript": ["shovel_management-ejs.js", "shovel.js"]}`, or an empty array for a
 * plugin that adds no script (golden fixtures, M0-25).
 */
export const extensions = defineEndpoint({
  id: 'extensions.list',
  template: '/api/extensions',
  schema: z.array(
    z.union([
      z.object({ javascript: z.union([z.string(), z.array(z.string())]) }),
      z.array(z.string()),
    ]),
  ),
});
