// Shared schemas of the explorer contracts (M0-48): inventory kinds, filter, sort, window, rows and
// the freshness every answer carries. Every input is bounded and there is no "list all" (I-7); every
// array in an output has a maximum no larger than the broker's own page ceiling.
import { z } from 'zod';

import { ObjectKeySchema } from '../brands.ts';

// 'connections' (cut from slice A, budget) and 'bindings' follow in their own slices.
export const INVENTORY_KINDS = ['queues', 'exchanges'] as const;
export type InventoryKind = (typeof INVENTORY_KINDS)[number];

/** The most rows one answer carries; equals the broker's own page ceiling. */
export const WINDOW_LIMIT_MAX = 500;
/** One AG Grid block (scale-first 10). */
export const WINDOW_LIMIT_DEFAULT = 200;
/** The most keys one explorer.window subscription names. */
export const VISIBLE_KEYS_MAX = 500;
export const FILTER_TEXT_MAX = 200;
export const SEARCH_RESULT_MAX = 50;

const count = z.number().int().nonnegative();

export const InventoryFilterSchema = z.strictObject({
  /** Case-insensitive substring of the name. */
  text: z.string().max(FILTER_TEXT_MAX).optional(),
  vhosts: z.array(z.string().max(255)).max(100).optional(),
  /** Queue type, exchange type or protocol, by kind. */
  types: z.array(z.string().max(64)).max(16).optional(),
  states: z.array(z.string().max(32)).max(16).optional(),
  /** Queues only. */
  hasConsumers: z.boolean().optional(),
  /** Queues only. */
  minMessages: count.optional(),
});

/** `column` is checked against the kind's own columns by the action (an unknown column is VALIDATION_FAILED). */
export const InventorySortSchema = z.strictObject({
  column: z.string().max(64),
  dir: z.enum(['asc', 'desc']),
});

export const InventoryWindowSchema = z.strictObject({
  offset: z.number().int().min(0),
  limit: z
    .number()
    .int()
    .min(1)
    .max(WINDOW_LIMIT_MAX)
    .default(WINDOW_LIMIT_DEFAULT),
  /** Pins the read to the index version of an earlier answer. */
  version: count.optional(),
});

/** What every answer says about the data it came from (I-13: nothing is silently partial or old). */
export const FreshnessSchema = z.strictObject({
  state: z.enum(['live', 'stale', 'loading', 'unavailable']),
  /** Epoch ms of the sweep that built this version. */
  sweptAt: count.optional(),
  /** False while the first sweep is running or after a partial one. */
  complete: z.boolean(),
  /** Rows of this kind in the index. */
  loaded: count,
  /** The broker's own object count, when known. */
  expected: count.optional(),
  /** The index cap dropped rows. */
  truncated: z.boolean(),
  /** Rows the cap dropped, counted. */
  dropped: count,
  /** Registry hazard ids from the profile that apply to these rows. */
  hazards: z.array(z.string().max(64)).max(32),
  /** The pinned version is gone; this answer is from `version`. */
  versionChanged: z.boolean(),
  /** Fixed text: never broker text, never a URL (I-10). */
  reason: z.string().max(200).optional(),
});

// A field the broker did not send is absent, never defaulted.
export const QueueRowSchema = z.strictObject({
  key: ObjectKeySchema,
  vhost: z.string(),
  name: z.string(),
  type: z.string().optional(),
  state: z.string().optional(),
  node: z.string().optional(),
  durable: z.boolean().optional(),
  autoDelete: z.boolean().optional(),
  exclusive: z.boolean().optional(),
  messages: count.optional(),
  messagesReady: count.optional(),
  messagesUnacknowledged: count.optional(),
  consumers: count.optional(),
  policy: z.string().optional(),
  operatorPolicy: z.string().optional(),
  deliveryLimit: z.number().int().optional(),
});

export const ExchangeRowSchema = z.strictObject({
  key: ObjectKeySchema,
  vhost: z.string(),
  name: z.string(),
  type: z.string().optional(),
  durable: z.boolean().optional(),
  autoDelete: z.boolean().optional(),
  internal: z.boolean().optional(),
});

/** What every window answer carries besides its rows. */
export const windowMeta = {
  window: z.strictObject({
    offset: count,
    limit: z.number().int().min(1).max(WINDOW_LIMIT_MAX),
  }),
  /** Rows of this kind in the index. */
  total: count,
  /** Rows after the filter. */
  matched: count,
  version: count,
  freshness: FreshnessSchema,
};
