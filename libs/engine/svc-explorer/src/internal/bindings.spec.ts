// The bindings kind of inventory.query (M0-48 slice H): per vhost, on demand, bounded and counted.
import { readFileSync } from 'node:fs';

import { ConnectionIdSchema } from '@app/contracts';
import {
  BrokerScheduler,
  createManualClock,
  createManualTimers,
  createTestContext,
  createTestExecutor,
  scheduleMgmtRead,
} from '@app/kernel';
import type { MgmtReadPort } from '@app/ports';
import { describe, expect, it } from 'vitest';

import { createSubject } from '../actions/inventory-query.fixture';
import { createInventoryQueryAction } from '../actions/inventory-query';
import {
  brokerFailure,
  createExplorerFakeDeps,
  createScriptedBroker,
} from '../testing';

import { createBindingsStore } from './bindings';
import { REASONS } from './freshness';
import { LIST_READ_TEXT } from './list-read';
import { BindingItemSchema, bindingRow } from './rows';

const { def } = createSubject();
const cid = ConnectionIdSchema.parse('c1');

/** The bytes of a recorded answer of the golden fixtures (`testing/fixtures/mgmt/<version>/<variant>`). */
function recordedBytes(recording: readonly [string, string]): Uint8Array {
  return readFileSync(
    new URL(
      `../../../../../testing/fixtures/mgmt/${recording[0]}/${recording[1]}/bindings.inVhost.json`,
      import.meta.url,
    ),
  );
}

/** `bytes` in chunks of `size`, as a body arrives. */
async function* inChunks(
  bytes: Uint8Array,
  size: number,
): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) {
    yield bytes.subarray(at, at + size);
  }
  await Promise.resolve();
}

/**
 * A management port that answers a stream of `/api/bindings/golden` with a recorded answer (64-byte
 * chunks, so every item crosses a chunk boundary). A `get` is refused: the bindings are streamed. It
 * records what was asked.
 */
function replay(recording: readonly [string, string]) {
  const bytes = recordedBytes(recording);
  const requests: { path: string; query: unknown; lane: string }[] = [];
  const port: MgmtReadPort = {
    get: () => Promise.reject(new Error('the bindings are streamed')),
    stream(request) {
      requests.push({
        path: request.path,
        query: request.query,
        lane: request.lane,
      });
      return Promise.resolve(inChunks(bytes, 64));
    },
  };
  return { port, requests };
}

const encoder = new TextEncoder();

/** A binding as the broker sends it. */
function binding(j: number, more: Record<string, unknown> = {}) {
  return {
    source: `exchange-${String(j % 10)}`,
    vhost: '/',
    destination: `queue-${String(j).padStart(6, '0')}`,
    destination_type: 'queue',
    routing_key: `rk-${String(j)}`,
    properties_key: `rk-${String(j)}`,
    arguments: {},
    ...more,
  };
}

const bare = (items: readonly unknown[]): string => JSON.stringify(items);

/** A body that sends `prefix` and then nothing, ever: the broker went silent. */
function silent(prefix = '['): AsyncIterable<Uint8Array> {
  let sent = false;
  return {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        sent
          ? new Promise<IteratorResult<Uint8Array>>(() => undefined)
          : ((sent = true),
            Promise.resolve({
              done: false as const,
              value: encoder.encode(prefix),
            })),
      return: () => Promise.resolve({ done: true as const, value: undefined }),
    }),
  };
}

function harness(options: Parameters<typeof createExplorerFakeDeps>[0]) {
  const deps = createExplorerFakeDeps(options);
  const engine = createTestExecutor();
  engine.executor.register(createInventoryQueryAction(deps));
  const ask = async (input: Record<string, unknown>) => {
    const outcome = await engine.executor.run(
      def,
      input,
      createTestContext({ idempotencyKey: 'explorer-bindings-spec-key' }),
    );
    if (outcome.kind !== 'output') throw new Error(`got ${outcome.kind}`);
    return outcome.output;
  };
  const bindings = (
    vhosts: string[] | undefined,
    more: Record<string, unknown> = {},
    window: Record<string, unknown> = { offset: 0, limit: 200 },
  ) => ({
    cid: 'c1',
    kind: 'bindings',
    window,
    ...(vhosts === undefined ? {} : { filter: { vhosts } }),
    ...more,
  });
  return { deps, ask, bindings };
}

describe('explorer bindings', () => {
  it('M0-48 AC-26 explorer bindings are per vhost, bounded and counted', async () => {
    const { deps, ask, bindings } = harness({
      vhostCount: 3,
      bindingsPerVhost: { '/': 3_000, 'vhost-1': 1_000, 'vhost-2': 50 },
      limits: { maxBindingsResident: 2_000 },
    });
    const { broker } = deps;

    // No "list all" (I-7): without exactly one vhost the query is refused and the broker is not asked.
    for (const vhosts of [undefined, [], ['/', 'vhost-1']]) {
      await expect(ask(bindings(vhosts))).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
    await expect(
      ask(bindings(['/'], { sort: { column: 'name', dir: 'asc' } })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(broker.requests).toHaveLength(0);

    // The first query reads the vhost: 3,000 bindings, 500 a page, in the interactive lane, and stops
    // at the cap (4 pages) because the broker's own count says what is left.
    const first = await ask(bindings(['/']));
    expect(first.kind).toBe('bindings');
    expect(first).toMatchObject({
      total: 2_000,
      matched: 2_000,
      window: { offset: 0, limit: 200 },
      freshness: {
        state: 'live',
        complete: true,
        loaded: 2_000,
        expected: 3_000,
        truncated: true,
        dropped: 1_000,
      },
    });
    expect(first.rows).toHaveLength(200);
    expect(broker.requests.map((r) => r.path)).toEqual(
      Array.from({ length: 4 }, () => '/api/bindings/%2F'),
    );
    expect(broker.requests.map((r) => r.query.page)).toEqual([1, 2, 3, 4]);
    for (const r of broker.requests) {
      expect(r).toMatchObject({
        lane: 'interactive',
        query: { page_size: 500 },
      });
    }
    // Bindings are not part of the sweep: nothing swept, nothing else asked.
    expect(deps.sweeper.index(cid)).toBeUndefined();

    // Resident now: other windows, filters and sorts make no request.
    const tail = await ask(bindings(['/'], {}, { offset: 1_990, limit: 50 }));
    expect(tail.rows).toHaveLength(10);
    const found = await ask(
      bindings(['/'], { filter: { vhosts: ['/'], text: 'rk-12' } }),
    );
    expect(found.matched).toBe(111); // rk-12, rk-120..129, rk-1200..1299
    const sorted = await ask(
      bindings(
        ['/'],
        { sort: { column: 'routingKey', dir: 'asc' } },
        { offset: 0, limit: 3 },
      ),
    );
    expect(
      sorted.rows.map((r) => (r as { routingKey?: string }).routingKey),
    ).toEqual(['rk-0', 'rk-1', 'rk-10']);
    expect(sorted.rows[0]).toMatchObject({
      vhost: '/',
      source: 'exchange-0',
      destination: 'queue-000000',
      destinationType: 'queue',
      propertiesKey: 'rk-0',
    });
    expect(broker.requests).toHaveLength(4);
    expect(deps.bindings.stats(cid)).toMatchObject({
      vhosts: ['/'],
      rows: 2_000,
      dropped: 1_000,
      evictions: 0,
    });

    // A second vhost does not fit beside the first: the least recently used one is evicted, counted.
    const second = await ask(bindings(['vhost-1']));
    expect(second).toMatchObject({
      total: 1_000,
      freshness: { truncated: false, dropped: 0, expected: 1_000 },
    });
    expect(deps.bindings.stats(cid)).toEqual({
      vhosts: ['vhost-1'],
      rows: 1_000,
      dropped: 0,
      evictions: 1,
      evictedRows: 2_000,
    });
    // Asking for the evicted vhost reads it again and evicts the other, also counted.
    await ask(bindings(['/']));
    expect(broker.requests).toHaveLength(4 + 2 + 4);
    expect(deps.bindings.stats(cid)).toMatchObject({
      vhosts: ['/'],
      evictions: 2,
      evictedRows: 3_000,
    });
  });

  it('M0-48 explorer bindings of a large vhost are converted and sorted in chunks that give the loop a turn, with the same rows', async () => {
    const broker = createScriptedBroker({
      bindingsPerVhost: 12_000,
      bindingsAnswer: 'bare',
    });
    const turns = { convert: 0, sort: 0 };
    // Nothing is resident until the read has converted every item; a turn after that is a sort's.
    const store: ReturnType<typeof createBindingsStore> = createBindingsStore({
      mgmt: broker.read,
      limits: { yieldEveryItems: 1_000, maxBindingsResident: 50_000 },
      yieldNow: () => {
        turns[store.stats(cid).rows === 0 ? 'convert' : 'sort']++;
        return Promise.resolve();
      },
    });
    const signal = new AbortController().signal;
    const ask = (
      sort: { column: string; dir: 'asc' | 'desc' },
      offset = 0,
      limit = 3,
    ) => store.window(cid, '/', { offset, limit, sort }, signal);

    const byDestination = await ask({ column: 'destination', dir: 'desc' });

    expect(byDestination).toMatchObject({ total: 12_000, matched: 12_000 });
    expect(byDestination.rows.map((r) => r.destination)).toEqual([
      'queue-011999',
      'queue-011998',
      'queue-011997',
    ]);
    // 12,000 items in chunks of 1,000: a turn after each chunk but the last.
    expect(turns.convert).toBe(11);
    // 12 runs sorted, then merged in 4 levels: a turn per run and per 1,000 items written.
    expect(turns.sort).toBeGreaterThanOrEqual(12 + 3 * 12);
    const sortedTurns = turns.sort;

    // The same order again is a cache hit: no sort, no turn. Another order sorts again, same rows.
    await ask({ column: 'destination', dir: 'desc' }, 11_990, 20);
    expect(turns.sort).toBe(sortedTurns);
    const bySource = await ask({ column: 'source', dir: 'asc' }, 0, 500);
    expect(turns.sort).toBeGreaterThan(sortedTurns);
    expect(bySource.rows.map((r) => r.source).slice(0, 2)).toEqual([
      'exchange-0',
      'exchange-0',
    ]);
    expect(new Set(bySource.rows.map((r) => r.key)).size).toBe(500);
    expect(broker.requests).toHaveLength(1);
  });

  it('M0-48 AC-26b explorer bindings handle a bare-array answer without paging', async () => {
    // RabbitMQ ignores `page` on /api/bindings/{vhost} (OQ-433): the whole vhost is one answer.
    const { deps, ask, bindings } = harness({
      bindingsPerVhost: 3_000,
      bindingsAnswer: 'bare',
      limits: { maxBindingsResident: 2_000 },
    });
    const first = await ask(bindings(['/']));
    // One request only; the read stops at the cap, so the rest is not counted: `dropped` is a minimum
    // and the number left out is said to be unknown (M0-48l), never silent.
    expect(deps.broker.requests).toHaveLength(1);
    expect(deps.broker.requests[0]).toMatchObject({
      path: '/api/bindings/%2F',
      lane: 'interactive',
    });
    expect(first).toMatchObject({
      total: 2_000,
      matched: 2_000,
      freshness: {
        state: 'live',
        complete: true,
        loaded: 2_000,
        truncated: true,
        dropped: 1,
        reason: REASONS.unpagedCut,
      },
    });
    expect(first.freshness.expected).toBeUndefined();
    expect(deps.bindings.stats(cid)).toMatchObject({
      rows: 2_000,
      dropped: 1,
    });
    await ask(bindings(['/'], {}, { offset: 1_990, limit: 50 }));
    expect(deps.broker.requests).toHaveLength(1);

    // A bare answer under the cap: everything is kept, `expected` is the array length, still unpaged.
    const small = harness({ bindingsPerVhost: 40, bindingsAnswer: 'bare' });
    expect(await small.ask(small.bindings(['/']))).toMatchObject({
      total: 40,
      freshness: {
        complete: true,
        expected: 40,
        truncated: false,
        dropped: 0,
        reason: REASONS.unpaged,
      },
    });

    // The recorded answer of RabbitMQ 4.2.9 (statistics off): a bare array of 8 bindings.
    const recorded = replay(['4.2.9', 'stats-off']);
    const real = harness({
      mgmt: recorded.port,
      limits: { maxBindingsResident: 5 },
    });
    const cut = await real.ask(real.bindings(['golden']));
    expect(recorded.requests).toEqual([
      {
        path: '/api/bindings/golden',
        query: { page: 1, page_size: 500 },
        lane: 'interactive',
      },
    ]);
    expect(cut).toMatchObject({
      total: 5,
      freshness: {
        truncated: true,
        dropped: 1,
        reason: REASONS.unpagedCut,
      },
    });
    expect(cut.freshness.expected).toBeUndefined();
    const whole = harness({ mgmt: replay(['4.2.9', 'stats-off']).port });
    const all = await whole.ask(whole.bindings(['golden']));
    expect(all).toMatchObject({
      total: 8,
      freshness: {
        expected: 8,
        truncated: false,
        dropped: 0,
        reason: REASONS.unpaged,
      },
    });
    expect(all.rows).toContainEqual(
      expect.objectContaining({
        source: 'golden.direct',
        destination: 'golden.classic',
        propertiesKey: 'classic~UYRScQ',
      }),
    );
    // The reason is fixed text, never broker text (I-10).
    expect(JSON.stringify(all)).not.toContain('secret-broker-text');
  });

  it('explorer bindings read the recorded bare-array answer of every RabbitMQ version', async () => {
    for (const version of ['3.13.7', '4.0.9', '4.1.8', '4.2.9', '4.3.6']) {
      for (const stats of ['stats-on', 'stats-off']) {
        const recorded = replay([version, stats]);
        const h = harness({ mgmt: recorded.port });
        const answer = await h.ask(h.bindings(['golden']));
        expect(answer, `${version} ${stats}`).toMatchObject({
          total: 8,
          freshness: { expected: 8, dropped: 0, reason: REASONS.unpaged },
        });
        expect(recorded.requests).toHaveLength(1);
      }
    }
  });

  it('explorer bindings read the recorded paged envelope of LavinMQ 2.10.2', async () => {
    const recorded = replay(['lavinmq-2.10.2', 'default']);
    const h = harness({ mgmt: recorded.port });
    const answer = await h.ask(h.bindings(['golden']));
    expect(recorded.requests).toHaveLength(1);
    expect(answer).toMatchObject({
      total: 3,
      freshness: {
        state: 'live',
        complete: true,
        expected: 3,
        truncated: false,
        dropped: 0,
      },
    });
    // A paged answer is not labelled unpaged.
    expect(answer.freshness.reason).toBeUndefined();
  });

  it('explorer bindings evict the least recently used vhost, not the oldest loaded', async () => {
    const { deps, ask, bindings } = harness({
      vhostCount: 3,
      bindingsPerVhost: 800,
      limits: { maxBindingsResident: 2_000 },
    });
    await ask(bindings(['/']));
    await ask(bindings(['vhost-1']));
    await ask(bindings(['/'])); // uses the first again
    await ask(bindings(['vhost-2'])); // 2,400 rows: one vhost has to go
    expect(deps.bindings.stats(cid)).toMatchObject({
      vhosts: ['/', 'vhost-2'],
      rows: 1_600,
      evictions: 1,
      evictedRows: 800,
    });
  });

  it('explorer bindings are read again after their age and served stale when that fails', async () => {
    const { deps, ask, bindings } = harness({
      bindingsPerVhost: 20,
      limits: { bindingsMaxAgeMs: 60_000 },
    });
    const first = await ask(bindings(['/']));
    deps.clock.advance(59_000);
    const same = await ask(bindings(['/']));
    expect(deps.broker.requests).toHaveLength(1);
    expect(same.version).toBe(first.version);

    deps.clock.advance(1_000);
    const again = await ask(bindings(['/']));
    expect(deps.broker.requests).toHaveLength(2);
    expect(again.version).toBeGreaterThan(first.version);
    const pinned = await ask(
      bindings(['/'], {}, { offset: 0, limit: 5, version: first.version }),
    );
    expect(pinned.freshness.versionChanged).toBe(true);

    // The next read fails: the resident rows are served, labelled stale, with a fixed reason (I-10).
    deps.clock.advance(60_000);
    deps.broker.intercept = () => brokerFailure();
    const stale = await ask(bindings(['/']));
    expect(stale.total).toBe(20);
    expect(stale.freshness.state).toBe('stale');
    expect(JSON.stringify(stale)).not.toContain('secret-broker-text');
    const calls = deps.broker.requests.length;
    await ask(bindings(['/'])); // not asked again at once
    expect(deps.broker.requests).toHaveLength(calls);

    // A vhost that was never read has nothing to show: a Problem with fixed text.
    const failed = await ask(bindings(['nope'])).catch((e: unknown) => e);
    expect(failed).toMatchObject({ code: 'BROKER_UNREACHABLE' });
    expect(JSON.stringify(failed)).not.toContain('secret-broker-text');
  });

  it('M0-48l AC-8 explorer bindings are read as a stream with the same request the get path sent', async () => {
    // The recorded RabbitMQ 4.2.9 answer (a bare array of 8 bindings) for a vhost that needs escaping.
    const { deps, ask, bindings } = harness({});
    const recorded = recordedBytes(['4.2.9', 'stats-off']);
    deps.broker.bindingsBody = () => recorded;
    const answer = await ask(bindings(['a/b c']));
    expect(deps.broker.requests).toEqual([
      {
        path: '/api/bindings/a%2Fb%20c',
        query: { page: 1, page_size: 500 },
        lane: 'interactive',
        via: 'stream',
      },
    ]);
    const former = (JSON.parse(readBody(recorded)) as unknown[]).map((raw) =>
      bindingRow(BindingItemSchema.parse(raw)),
    );
    expect(answer.total).toBe(8);
    expect([...answer.rows].sort(byKey)).toEqual([...former].sort(byKey));
    expect(
      deps.broker.streams.map((s) => [s.ended, s.cancelled, s.open]),
    ).toEqual([[true, false, false]]);

    // The paged envelope (LavinMQ): 1,100 bindings are 3 pages of at most 500, each a stream.
    const paged = harness({ bindingsPerVhost: 1_100 });
    const all = await paged.ask(paged.bindings(['/']));
    expect(all).toMatchObject({
      total: 1_100,
      freshness: { expected: 1_100, dropped: 0, truncated: false },
    });
    expect(paged.deps.broker.requests.map((r) => r.via)).toEqual([
      'stream',
      'stream',
      'stream',
    ]);
    expect(paged.deps.broker.requests.map((r) => r.query)).toEqual([
      { page: 1, page_size: 500 },
      { page: 2, page_size: 500 },
      { page: 3, page_size: 500 },
    ]);
    for (const s of paged.deps.broker.streams) {
      expect(s).toMatchObject({ ended: true, cancelled: false, open: false });
    }
  });

  it('M0-48l AC-9 explorer bindings stop at the cap, cancel the body and say the total is not known', async () => {
    const chunk = 4_096;
    const { deps, ask, bindings } = harness({
      bindingsPerVhost: 20_000,
      bindingsAnswer: 'bare',
      bindingsChunkBytes: chunk,
      limits: { maxBindingsResident: 500 },
    });
    const cut = await ask(bindings(['/']));
    expect(cut).toMatchObject({
      total: 500,
      freshness: {
        state: 'live',
        complete: true,
        loaded: 500,
        truncated: true,
        dropped: 1,
        reason: REASONS.unpagedCut,
      },
    });
    expect(cut.freshness.expected).toBeUndefined();
    const [stream] = deps.broker.streams;
    const first500 = encoder.encode(
      bare(Array.from({ length: 500 }, (_, j) => binding(j))),
    ).length;
    expect(stream?.cancelled).toBe(true);
    expect(stream?.open).toBe(false);
    expect(stream?.bytesSent).toBeLessThanOrEqual(first500 + 2 * chunk);

    // Exactly the cap: nothing was cut, the length is exact.
    const exact = harness({
      bindingsPerVhost: 500,
      bindingsAnswer: 'bare',
      limits: { maxBindingsResident: 500 },
    });
    const whole = await exact.ask(exact.bindings(['/']));
    expect(whole).toMatchObject({
      total: 500,
      freshness: {
        expected: 500,
        dropped: 0,
        truncated: false,
        reason: REASONS.unpaged,
      },
    });
    expect(exact.deps.broker.streams[0]).toMatchObject({
      ended: true,
      cancelled: false,
    });
    for (const reason of [cut.freshness.reason, whole.freshness.reason]) {
      expect(reason).not.toMatch(/non-destructive|read-only/i);
    }
  });

  it('M0-48l AC-10 explorer bindings fail closed, install nothing and keep the last good rows stale', async () => {
    const canary = 'canary-secret-name';
    const many = (n: number) => Array.from({ length: n }, (_, j) => binding(j));
    const cases: readonly { name: string; body: string; text: string }[] = [
      {
        name: 'ends inside an item',
        body: bare(many(1_001)).slice(0, -30),
        text: LIST_READ_TEXT.incomplete,
      },
      {
        name: 'a binding without a source',
        body: bare([
          binding(0),
          binding(1, { source: undefined, destination: canary }),
        ]),
        text: LIST_READ_TEXT.incomplete,
      },
      {
        name: 'a binding of 300 KiB',
        body: bare([
          binding(0, { arguments: { pad: 'x'.repeat(300 * 1024) } }),
        ]),
        text: LIST_READ_TEXT.tooLarge,
      },
      {
        name: 'a body over the byte limit',
        body: bare(many(10_000)),
        text: LIST_READ_TEXT.tooLarge,
      },
      {
        name: 'a body that is not JSON',
        body: `<html>${canary}</html>`,
        text: LIST_READ_TEXT.incomplete,
      },
    ];
    const options = {
      bindingsPerVhost: 30,
      bindingsAnswer: 'bare' as const,
      limits: { maxBindingsBodyBytes: 1024 * 1024, bindingsMaxAgeMs: 60_000 },
    };
    const never = (error: unknown): void => {
      const text = JSON.stringify(error) + (error as Error).message;
      expect(text).not.toContain(canary);
      expect(text).not.toContain('secret-broker-text');
    };

    for (const c of cases) {
      // A resident vhost: the failed read installs nothing and the rows are served stale.
      const h = harness(options);
      const good = await h.ask(h.bindings(['/']));
      h.deps.clock.advance(60_000);
      h.deps.broker.bindingsBody = () => c.body;
      const stale = await h.ask(h.bindings(['/']));
      expect(stale, c.name).toMatchObject({
        total: 30,
        version: good.version,
        freshness: { state: 'stale', reason: REASONS.failed },
      });
      expect(h.deps.bindings.stats(cid), c.name).toMatchObject({ rows: 30 });
      expect(h.deps.broker.streams.length, c.name).toBe(2);
      expect(
        h.deps.broker.streams.every((s) => !s.open),
        c.name,
      ).toBe(true);
      never(stale);

      // A vhost that was never read: the Problem has one of the fixed texts.
      const fresh = harness(options);
      fresh.deps.broker.bindingsBody = () => c.body;
      const error: unknown = await fresh
        .ask(fresh.bindings(['/']))
        .catch((e: unknown) => e);
      expect(error, c.name).toMatchObject({ code: 'BROKER_ERROR' });
      expect((error as Error).message, c.name).toContain(c.text);
      expect(fresh.deps.broker.streams.every((s) => !s.open)).toBe(true);
      expect(fresh.deps.bindings.stats(cid).rows).toBe(0);
      never(error);
    }

    // A 503 on the stream: no body is handed out; the adapter's own code is kept with a fixed text.
    const down = harness(options);
    await down.ask(down.bindings(['/']));
    down.deps.clock.advance(60_000);
    down.deps.broker.intercept = () => brokerFailure();
    const served = await down.ask(down.bindings(['/']));
    expect(served).toMatchObject({
      total: 30,
      freshness: { state: 'stale', reason: REASONS.failed },
    });
    never(served);
    const refused = harness(options);
    refused.deps.broker.intercept = () => brokerFailure();
    const problem: unknown = await refused
      .ask(refused.bindings(['/']))
      .catch((e: unknown) => e);
    expect(problem).toMatchObject({ code: 'BROKER_UNREACHABLE' });
    expect((problem as Error).message).toContain(LIST_READ_TEXT.failed);
    never(problem);
  });

  it('M0-48l AC-11 explorer bindings release the scheduler slot on every ending and stop a silent body at the deadline', async () => {
    const clock = createManualClock();
    const timers = createManualTimers(clock);
    const scheduler = new BrokerScheduler({ clock, timers });
    const broker = createScriptedBroker({
      vhostCount: 6,
      bindingsPerVhost: { '/': 50, 'vhost-1': 1_000 },
      bindingsAnswer: 'bare',
    });
    const seen: AbortSignal[] = [];
    const store = createBindingsStore({
      mgmt: scheduleMgmtRead(
        {
          get: (request, signal) => broker.read.get(request, signal),
          stream(request, signal) {
            seen.push(signal);
            return broker.read.stream(request, signal);
          },
        },
        scheduler,
      ),
      clock,
      timers,
      limits: { maxBindingsResident: 100 },
    });
    const window = (vhost: string) =>
      store.window(
        cid,
        vhost,
        { offset: 0, limit: 10 },
        new AbortController().signal,
      );
    const slots = () =>
      scheduler.snapshot().brokers.find((b) => b.connectionId === cid)?.inFlight
        .interactive ?? 0;
    const settled = (promise: Promise<unknown>) => {
      const state = { done: false };
      void promise.then(
        () => (state.done = true),
        () => (state.done = true),
      );
      return state;
    };

    // Ends normally, ends at the cap, fails: the slot is back and the watchdog never fired.
    await window('/');
    expect(slots()).toBe(0);
    await window('vhost-1');
    expect(slots()).toBe(0);
    broker.bindingsBody = () => '<html>not a list</html>';
    await expect(window('vhost-2')).rejects.toMatchObject({
      code: 'BROKER_ERROR',
    });
    expect(slots()).toBe(0);
    expect(scheduler.snapshot().holdTimeouts).toBe(0);
    expect(timers.pending()).toBe(0);

    // A body that goes silent: read until the deadline, 30 s before the scheduler's own hold time.
    broker.bindingsBody = () => silent();
    const quiet = window('vhost-3').catch((e: unknown) => e);
    const done = settled(quiet);
    await timers.settle();
    expect(slots()).toBe(1);
    await timers.advance(89_999);
    expect(done.done).toBe(false);
    expect(slots()).toBe(1);
    await timers.advance(1);
    await expect(quiet).resolves.toMatchObject({
      code: 'BROKER_UNREACHABLE',
      detail: LIST_READ_TEXT.late,
    });
    expect(seen.at(-1)?.aborted).toBe(true);
    expect(slots()).toBe(0);
    expect(scheduler.snapshot().holdTimeouts).toBe(0);
    expect(timers.pending()).toBe(0);

    // stop() in the middle of a body: the read ends at once, the stream is cancelled, no timer is left.
    broker.bindingsBody = () => silent();
    const midway = window('vhost-4').catch((e: unknown) => e);
    await timers.settle();
    expect(slots()).toBe(1);
    store.stop();
    await expect(midway).resolves.toMatchObject({
      code: 'ENGINE_SHUTTING_DOWN',
    });
    await timers.settle();
    expect(broker.streams.at(-1)).toMatchObject({
      cancelled: true,
      open: false,
    });
    expect(slots()).toBe(0);
    expect(scheduler.snapshot().holdTimeouts).toBe(0);
    expect(timers.pending()).toBe(0);
    scheduler.close();
  });

  it('M0-48l AC-12 explorer bindings keep at most two streams open per connection', async () => {
    const make = () => {
      const clock = createManualClock();
      const timers = createManualTimers(clock);
      const broker = createScriptedBroker({
        vhostCount: 6,
        bindingsPerVhost: 5,
        bindingsAnswer: 'bare',
      });
      const store = createBindingsStore({
        mgmt: broker.read,
        clock,
        timers,
        limits: { maxBindingReadsPerConnection: 2 },
      });
      const ask = (vhost: string) =>
        store.window(
          cid,
          vhost,
          { offset: 0, limit: 10 },
          new AbortController().signal,
        );
      return { broker, store, timers, ask };
    };

    // Six vhosts at once: two streams open, four wait; every one is answered in the end.
    const run = make();
    let go: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      go = resolve;
    });
    run.broker.bindingsBody = () => ({
      async *[Symbol.asyncIterator]() {
        await gate;
        yield encoder.encode(bare([binding(0), binding(1)]));
      },
    });
    const six = run.broker.vhosts.map((vhost) => run.ask(vhost));
    await run.timers.settle();
    expect(run.broker.streams).toHaveLength(2);
    go();
    const answers = await Promise.all(six);
    expect(answers.map((a) => a.total)).toEqual([2, 2, 2, 2, 2, 2]);
    expect(run.broker.streams).toHaveLength(6);
    expect(run.broker.maxOpenStreams).toBe(2);

    // stop() with two open and two waiting: all four end with ENGINE_SHUTTING_DOWN, no stream starts.
    const stopped = make();
    stopped.broker.bindingsBody = () => silent();
    const four = stopped.broker.vhosts
      .slice(0, 4)
      .map((vhost) => stopped.ask(vhost).catch((e: unknown) => e));
    await stopped.timers.settle();
    expect(stopped.broker.streams).toHaveLength(2);
    stopped.store.stop();
    for (const outcome of await Promise.all(four)) {
      expect(outcome).toMatchObject({ code: 'ENGINE_SHUTTING_DOWN' });
    }
    await stopped.timers.settle();
    expect(stopped.broker.streams).toHaveLength(2);
    expect(stopped.broker.streams.every((s) => s.cancelled && !s.open)).toBe(
      true,
    );
    expect(stopped.timers.pending()).toBe(0);
  });
});

function byKey(a: { key: string }, b: { key: string }): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function readBody(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
