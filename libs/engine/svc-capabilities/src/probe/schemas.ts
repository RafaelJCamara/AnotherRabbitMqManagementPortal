// What the probe reads of each management answer, as zod. Every field is optional but the ones a
// step cannot do without: another product or an older release leaves fields out (LavinMQ has no
// `rabbitmq_version`), and a field the probe does not know is simply not read. The adapter parses an
// answer with the schema of the request, so these are the contract between the probe and the broker.
import { z } from 'zod';

export const OverviewSchema = z.object({
  node: z.string().optional(),
  product_name: z.string().optional(),
  rabbitmq_version: z.string().optional(),
  lavinmq_version: z.string().optional(),
  default_queue_type: z.string().optional(),
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
      }),
    )
    .optional(),
});
export type Overview = z.infer<typeof OverviewSchema>;

/** `tags` is a comma-separated string on old releases and LavinMQ, a list on current ones. */
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

/** An entry is `{javascript: "x.js"}`, `{javascript: [...]}` or an empty array (golden fixtures). */
export const ExtensionsSchema = z.array(
  z.union([
    z.object({ javascript: z.union([z.string(), z.array(z.string())]) }),
    z.array(z.string()),
  ]),
);

export const NodesSchema = z.array(
  z.object({
    name: z.string(),
    running: z.boolean().optional(),
    being_drained: z.boolean().optional(),
    enabled_plugins: z.array(z.string()).optional(),
  }),
);

export const FeatureFlagsSchema = z.array(
  z.object({ name: z.string(), state: z.string() }),
);
export const NamedListSchema = z.array(z.object({ name: z.string() }));

/** The answer of the auth discovery endpoint of 4.1 and earlier (`/api/auth`). */
export const AuthDiscoverySchema = z.object({
  oauth_enabled: z.boolean().optional(),
  oauth_provider_url: z.string().optional(),
});

/** A list the broker pages answers a bare array or the `{items}` envelope (OQ-433). */
export function listOf<T extends z.ZodType>(item: T) {
  return z
    .union([z.array(item), z.object({ items: z.array(item) })])
    .transform((answer) => (Array.isArray(answer) ? answer : answer.items));
}

export const PolicyItemSchema = z.object({
  name: z.string(),
  vhost: z.string().optional(),
});

export const ExchangeSchema = z.object({ name: z.string() });

/**
 * A new schema object around `schema`. The BrokerScheduler single-flights identical GETs and reuses
 * an answer for a while, and it counts two requests as identical when they share the schema object.
 * A probe is an explicit "ask again" (and asks `/api/overview` several times to see whether a load
 * balancer answers), so each of its reads gets a schema of its own.
 */
export function uncached<T>(schema: z.ZodType<T>): z.ZodType<T> {
  return schema.transform((value) => value);
}
