import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LIMITS } from './limits.ts';
import { normalizeDeaths } from './normalize.ts';
import type {
  DeathContext,
  DeathEntry,
  DeathHistory,
  DeathMessage,
  DeathProtocol,
} from './types.ts';

const OPAQUE: DeathContext = { clientDeathInterpreted: false };
const CONTEXTS: readonly DeathContext[] = [
  { clientDeathInterpreted: true },
  OPAQUE,
  { clientDeathInterpreted: null },
];

const message = (protocol: DeathProtocol, container: unknown): DeathMessage =>
  protocol === 'amqp091'
    ? { protocol, headers: container }
    : { protocol, messageAnnotations: container };

const FORM = {
  amqp091: 'x-death',
  amqp10: 'x-opt-deaths',
} as const;

// Any JSON-like value, plus the values a JSON parser never makes.
const anything = fc.anything({
  withBigInt: true,
  withDate: true,
  withMap: true,
  withSet: true,
  withNullPrototype: true,
  withObjectString: true,
  withSparseArray: true,
  withTypedArray: true,
  withBoxedValues: true,
});

const keyed = (key: string): fc.Arbitrary<unknown> =>
  fc.record({ [key]: anything }, { requiredKeys: [key] });

/** A container with real key names and fuzzed values. */
const container = (protocol: DeathProtocol): fc.Arbitrary<unknown> =>
  fc.oneof(
    anything,
    keyed(FORM[protocol]),
    fc.record(
      {
        [FORM[protocol]]: fc.array(anything, { maxLength: 6 }),
        'x-first-death-queue': anything,
        'x-last-death-reason': anything,
        'x-delivery-count': anything,
        'x-redrive-count': anything,
      },
      { requiredKeys: [] },
    ),
  );

const text = fc.string({ maxLength: 12 });

/** A well-formed record (all the fields), 1.0 style; times are whole seconds. */
const record = fc.record({
  queue: text,
  reason: fc.constantFrom(
    'rejected',
    'expired',
    'maxlen',
    'delivery_limit',
    'x-new',
  ),
  count: fc.integer({ min: 1, max: 1000 }),
  exchange: text,
  keys: fc.array(text, { maxLength: 4 }),
  first: fc.integer({ min: 0, max: 2_000_000_000 }),
  span: fc.integer({ min: 0, max: 100_000 }),
});
type Record10 = typeof record extends fc.Arbitrary<infer T> ? T : never;

const as091 = (records: readonly Record10[]): unknown[] =>
  records.map((r) => ({
    queue: r.queue,
    reason: r.reason,
    count: r.count,
    exchange: r.exchange,
    'routing-keys': [...r.keys],
    time: { '!': 'timestamp', value: r.first },
  }));

const as10 = (records: readonly Record10[]): unknown[] =>
  records.map((r) => ({
    queue: r.queue,
    reason: r.reason,
    count: r.count,
    exchange: r.exchange,
    'routing-keys': [...r.keys],
    'first-time': r.first * 1000,
    'last-time': (r.first + r.span) * 1000,
  }));

const data = (entry: DeathEntry): DeathEntry => ({
  ...entry,
  index: 0,
  flags: [],
});

/** Writes a result back as the raw form it came from. */
function canonical(result: DeathHistory): unknown {
  if (result.protocol === 'amqp091') {
    return result.entries.map((e) => ({
      queue: e.queue ?? undefined,
      reason: e.reason ?? e.reasonText ?? undefined,
      count: e.count ?? undefined,
      exchange: e.exchange ?? undefined,
      'routing-keys': [...e.routingKeys],
      time:
        e.firstTimeMs === null
          ? undefined
          : { '!': 'timestamp', value: e.firstTimeMs / 1000 },
    }));
  }
  return result.entries.map((e) => ({
    queue: e.queue ?? undefined,
    reason: e.reason ?? e.reasonText ?? undefined,
    count: e.count ?? undefined,
    exchange: e.exchange ?? undefined,
    'routing-keys': [...e.routingKeys],
    'first-time': e.firstTimeMs ?? undefined,
    'last-time': e.lastTimeMs ?? undefined,
  }));
}

describe('properties of the normaliser', () => {
  it('M1-04 AC-9 never throws, stays within its bounds and returns plain data, whatever the input', () => {
    for (const protocol of ['amqp091', 'amqp10'] as const) {
      fc.assert(
        fc.property(
          container(protocol),
          fc.constantFrom(...CONTEXTS),
          (raw, context) => {
            const result = normalizeDeaths(message(protocol, raw), context);
            expect(result.entries.length).toBeLessThanOrEqual(
              LIMITS.maxEntries,
            );
            let chars = 0;
            for (const entry of result.entries) {
              expect(entry.routingKeys.length).toBeLessThanOrEqual(
                LIMITS.maxRoutingKeys,
              );
              chars +=
                (entry.queue?.length ?? 0) + (entry.exchange?.length ?? 0);
              chars += entry.reasonText?.length ?? 0;
              for (const key of entry.routingKeys) chars += key.length;
              if (entry.count !== null)
                expect(entry.count).toBeGreaterThanOrEqual(1);
            }
            expect(chars).toBeLessThanOrEqual(LIMITS.maxTotalChars);
            // Plain data: it serialises (no bigint, no cycle, no class instance).
            expect(() => JSON.stringify(result)).not.toThrow();
            expect(result.trusted).toBe(result.trust.trusted);
          },
        ),
        { numRuns: 300 },
      );
    }
  });

  it('M1-04 AC-9 never throws on hostile containers', () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const trap = new Proxy(
      {},
      {
        get() {
          throw new Error('get');
        },
        has() {
          throw new Error('has');
        },
        getOwnPropertyDescriptor() {
          throw new Error('descriptor');
        },
        ownKeys() {
          throw new Error('keys');
        },
      },
    );
    const lengthTrap = new Proxy([], {
      get(_target, key) {
        if (key === 'length') throw new Error('length');
        return undefined;
      },
    });
    const cyclic: Record<string, unknown> = {};
    cyclic['x-death'] = [cyclic];
    cyclic['x-opt-deaths'] = cyclic;
    const polluted = JSON.parse(
      '{"__proto__":{"x-death":[]},"x-death":[{"queue":"q"}]}',
    ) as unknown;
    const huge: unknown[] = [];
    huge.length = 2 ** 32 - 1;
    const hostile: unknown[] = [
      revoked.proxy,
      trap,
      { 'x-death': trap },
      { 'x-death': lengthTrap },
      { 'x-death': [trap, revoked.proxy, lengthTrap] },
      { 'x-death': [{ queue: trap, 'routing-keys': trap, time: trap }] },
      cyclic,
      polluted,
      { 'x-death': huge },
      { 'x-death': [{ 'routing-keys': huge, queue: 'q'.repeat(10_000_000) }] },
      { [Symbol('x-death')]: [] },
      { 'x-death': [() => 1, Symbol('s'), 10n, NaN, undefined, null] },
    ];
    for (const protocol of ['amqp091', 'amqp10'] as const) {
      for (const raw of hostile) {
        for (const context of CONTEXTS) {
          expect(() =>
            normalizeDeaths(message(protocol, raw), context),
          ).not.toThrow();
        }
      }
    }
    const nonObjects = [
      undefined,
      null,
      0,
      'x',
      true,
      5n,
      () => 1,
    ] as unknown[];
    for (const value of nonObjects) {
      expect(() =>
        normalizeDeaths(value as DeathMessage, OPAQUE),
      ).not.toThrow();
    }
  });

  it('M1-04 AC-9 sums the counts, and sorts a 1.0 list newest first while keeping every record', () => {
    fc.assert(
      fc.property(
        fc.array(record, { minLength: 1, maxLength: 20 }),
        (records) => {
          const result = normalizeDeaths(
            message('amqp10', { 'x-opt-deaths': as10(records) }),
            OPAQUE,
          );
          expect(result.totalDeaths).toBe(
            records.reduce((sum, r) => sum + r.count, 0),
          );
          const times = result.entries.map((e) => e.lastTimeMs ?? -1);
          times.slice(1).forEach((time, i) => {
            expect(times[i] ?? -1).toBeGreaterThanOrEqual(time);
          });
          // A permutation: nothing is lost or invented, and ties keep the client's order.
          expect(
            result.entries.map((e) => e.index).sort((a, b) => a - b),
          ).toEqual(records.map((_, i) => i));
          for (let i = 1; i < result.entries.length; i++) {
            const [a, b] = [result.entries[i - 1], result.entries[i]] as [
              DeathEntry,
              DeathEntry,
            ];
            if (a.lastTimeMs === b.lastTimeMs)
              expect(a.index).toBeLessThan(b.index);
          }
        },
      ),
    );
  });

  it('M1-04 AC-9 reads the same history from 0-9-1 and 1.0 whenever every record died once', () => {
    fc.assert(
      fc.property(
        fc.array(record, { minLength: 1, maxLength: 20 }),
        (records) => {
          const once = records.map((r) => ({ ...r, count: 1, span: 0 }));
          // The 1.0 list must already be newest first for the two orders to be the same.
          const ordered = [...once].sort((a, b) => b.first - a.first);
          const a = normalizeDeaths(
            message('amqp091', { 'x-death': as091(ordered) }),
            OPAQUE,
          );
          const b = normalizeDeaths(
            message('amqp10', { 'x-opt-deaths': as10(ordered) }),
            OPAQUE,
          );
          expect(a.entries).toEqual(b.entries);
        },
      ),
    );
  });

  it('M1-04 AC-10 is deterministic and leaves its input untouched', () => {
    for (const protocol of ['amqp091', 'amqp10'] as const) {
      fc.assert(
        fc.property(
          container(protocol),
          fc.constantFrom(...CONTEXTS),
          (raw, context) => {
            const before = structuredClone(raw);
            const first = normalizeDeaths(message(protocol, raw), context);
            const second = normalizeDeaths(message(protocol, raw), context);
            expect(second).toEqual(first);
            expect(raw).toEqual(before);
          },
        ),
        { numRuns: 200 },
      );
    }
  });

  it('M1-04 AC-10 is idempotent: the canonical form of a result normalises to the same records', () => {
    for (const protocol of ['amqp091', 'amqp10'] as const) {
      const build = protocol === 'amqp091' ? as091 : as10;
      fc.assert(
        fc.property(fc.array(record, { maxLength: 20 }), (records) => {
          const context = OPAQUE;
          const once = normalizeDeaths(
            message(protocol, { [FORM[protocol]]: build(records) }),
            context,
          );
          const twice = normalizeDeaths(
            message(protocol, { [FORM[protocol]]: canonical(once) }),
            context,
          );
          expect(twice.entries.map(data)).toEqual(once.entries.map(data));
          expect(twice.totalDeaths).toBe(once.totalDeaths);
          expect(twice.flags).toEqual(
            once.flags.filter((f) => f !== 'reordered'),
          );
        }),
      );
    }
  });
});
