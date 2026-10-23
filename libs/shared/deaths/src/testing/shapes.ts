// Builders for the shapes the specs feed in. The field names and units are those of
// docs/research/tap-streams-ops.md T3 (mc_amqpl.erl `death_table`, mc_amqp.erl `encode_deaths`);
// no broker recorded them yet (OQ-1042), so these are the documented shapes, not lab output.

export interface Death {
  readonly queue: string;
  readonly reason: string;
  readonly count: number;
  readonly exchange: string;
  readonly routingKeys: readonly string[];
  /** The first death, in epoch seconds. */
  readonly firstSec: number;
  /** The last death, in epoch seconds; defaults to the first. */
  readonly lastSec?: number;
  readonly ttlMs?: number;
}

export const death = (over: Partial<Death> = {}): Death => ({
  queue: 'orders.work',
  reason: 'rejected',
  count: 1,
  exchange: 'orders',
  routingKeys: ['order.created'],
  firstSec: 1_700_000_000,
  ...over,
});

/** The `x-death` array as amqplib decodes it: timestamps are `{ '!': 'timestamp', value }`. */
export const x091 = (deaths: readonly Death[]): unknown[] =>
  deaths.map((d) => ({
    count: d.count,
    reason: d.reason,
    queue: d.queue,
    time: { '!': 'timestamp', value: d.firstSec },
    exchange: d.exchange,
    'routing-keys': [...d.routingKeys],
    ...(d.ttlMs === undefined
      ? {}
      : { 'original-expiration': String(d.ttlMs) }),
  }));

/** The `x-opt-deaths` array as an AMQP 1.0 client sees it: milliseconds, symbol keys as strings. */
export const x10 = (deaths: readonly Death[]): unknown[] =>
  deaths.map((d) => ({
    queue: d.queue,
    reason: d.reason,
    count: d.count,
    'first-time': new Date(d.firstSec * 1000),
    'last-time': new Date((d.lastSec ?? d.firstSec) * 1000),
    exchange: d.exchange,
    'routing-keys': [...d.routingKeys],
    ...(d.ttlMs === undefined ? {} : { ttl: d.ttlMs }),
  }));

/** The same value in the engine's typed form (`TypedHeaderValue`) for a 0-9-1 header table. */
export function typed(value: unknown): unknown {
  if (typeof value === 'string') return { t: 'string', v: value };
  if (typeof value === 'number') return { t: 'long', v: value };
  if (Array.isArray(value)) {
    return { t: 'array', v: (value as unknown[]).map(typed) };
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (record['!'] === 'timestamp') return { t: 'timestamp', v: record.value };
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record)) out[key] = typed(record[key]);
    return { t: 'table', v: out };
  }
  return { t: 'void', v: null };
}
