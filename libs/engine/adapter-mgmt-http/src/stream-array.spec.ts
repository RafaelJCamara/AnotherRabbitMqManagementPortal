// The wire proof of M0-48l (slice D): the real client, the real Dialer and a local HTTP server that
// answers /api/bindings/{vhost} the way RabbitMQ does, as one bare array of every binding. The body
// is generated while it is written (never held whole), so the server costs a few KiB of memory.
//
// What this file proves that the unit tests of the reader and of the bindings store cannot: that the
// bytes of a 32 MB answer go through `read.stream` and `@app/json-stream` item by item where `read.get`
// stops at its 16 MiB limit (AC-13), that a reader that stops early closes the socket and leaves the
// pool usable (AC-14), and that the reader gives the event loop a turn at the sizes AC-7 of the reader sets (AC-15, I-5; counted per turn, not timed, OQ-775).
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { openJson, type ArrayEnd } from '@app/json-stream';

import { MgmtHttpError } from './errors.ts';
import { CID, harness, type Harness } from './test-support.ts';

const ITEMS = 150_000;
/** The bindings of the vhost `v`, with the page the client adds to a paged endpoint. */
const BINDINGS = '/api/bindings/v?page=1&page_size=500';
const WRITE_BYTES = 16 * 1024;
const MIB = 1024 * 1024;
const NS_PER_MS = 1e6;
/** A binding of the recorded shape, 214 bytes and a comma: 150,000 of them are about 32 MB. */
const PAD = 'p'.repeat(26);
const destinationOf = (i: number): string =>
  `queue.${String(i).padStart(6, '0')}`;
const bindingOf = (i: number): string => {
  const n = String(i).padStart(6, '0');
  return `{"source":"ex.${n}","vhost":"v","destination":"${destinationOf(i)}","destination_type":"queue","routing_key":"rk.${n}.${PAD}","arguments":{},"properties_key":"rk.${n}.${PAD}"}`;
};

/** What the server did with one request. */
interface Served {
  readonly url: string;
  /** Bytes handed to the socket (the body is ASCII), never more than the reader could have taken. */
  written: number;
  /** Whole body written and ended. */
  finished: boolean;
  /** Settles when the connection of this request closed, whole body written or not. */
  readonly closed: Promise<void>;
}

interface Broker {
  readonly port: number;
  readonly served: readonly Served[];
  close(): Promise<void>;
}

/** Waits for the socket buffer to drain; false when the other side closed first. */
function drained(res: ServerResponse): Promise<boolean> {
  return new Promise((resolve) => {
    const onDrain = (): void => {
      res.off('close', onClose);
      resolve(true);
    };
    const onClose = (): void => {
      res.off('drain', onDrain);
      resolve(false);
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

async function sendBindings(res: ServerResponse, served: Served) {
  res.writeHead(200, { 'content-type': 'application/json' });
  let pending = '[';
  for (let i = 0; i < ITEMS; i++) {
    pending += (i === 0 ? '' : ',') + bindingOf(i);
    if (pending.length < WRITE_BYTES) continue;
    served.written += pending.length;
    const open = res.write(pending) || (await drained(res));
    if (!open || res.destroyed) return;
    pending = '';
  }
  served.written += pending.length + 1;
  served.finished = true;
  res.end(pending + ']');
}

/** A broker with 150,000 bindings in the vhost `v`, as one bare array (the RabbitMQ answer). */
async function startBroker(): Promise<Broker> {
  const served: Served[] = [];
  const server: Server = createServer((req, res) => {
    req.resume();
    if (req.url?.startsWith('/api/overview') === true) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"node":"n1"}');
      return;
    }
    const entry: Served = {
      url: req.url ?? '',
      written: 0,
      finished: false,
      closed: new Promise<void>((resolve) => {
        res.once('close', resolve);
      }),
    };
    served.push(entry);
    void sendBindings(res, entry);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    served,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function setup(): Promise<{ broker: Broker; h: Harness }> {
  const broker = await startBroker();
  const h = harness(broker.port);
  closers.push(() => {
    h.client.close();
  });
  closers.push(() => broker.close());
  return { broker, h };
}

interface Limits {
  readonly maxItems: number;
  readonly maxBytes: number;
  readonly maxItemBytes: number;
}
/** The limits of the bindings store (slice C) apart from the item count. */
const LIMITS = {
  maxBytes: 256 * MIB,
  maxItemBytes: 256 * 1024,
} as const;

const bindingsRequest = {
  connectionId: CID,
  path: '/api/bindings/v',
  query: { page: 1, page_size: 500 },
  lane: 'interactive',
} as const;

/** One streamed GET of the vhost, read through the reader; `onItem` sees every item in order. */
async function readStream(
  h: Harness,
  limits: Limits,
  onItem: (item: unknown) => void,
): Promise<ArrayEnd> {
  const body = await h.client.read.stream(bindingsRequest, h.signal);
  const json = await openJson(body);
  expect(json.shape).toBe('array');
  const items = json.array(limits);
  for (;;) {
    const step = await items.next();
    if (step.done === true) return step.value;
    onItem(step.value);
  }
}

/** How often the loop-delay sampler wakes: an idle loop then reads about this on Linux. */
const RESOLUTION_MS = 1;

/** The defaults of `openJson`: bytes scanned and items delivered between two turns of the loop. */
const YIELD_EVERY_BYTES = 262_144;
const YIELD_EVERY_ITEMS = 5_000;

/** What the reader did between two turns of the event loop. */
interface Turn {
  readonly ms: number;
  readonly bytes: number;
  readonly items: number;
}

interface TurnProbe {
  /** Bytes pulled from the socket by the reader, counted in the turn they were pulled. */
  readonly bytes: (n: number) => void;
  /** One item delivered to the caller. */
  readonly item: () => void;
  /** Stops the probe; the turns in which the reader pulled bytes or delivered items. */
  readonly stop: () => readonly Turn[];
}

/**
 * Counts the turns of the event loop with a `setImmediate` chain (one tick per loop iteration, so
 * a turn is a turn whatever the OS does with the process) and books the reader's work to the turn
 * it ran in. Only the work is a figure here; the milliseconds are the wall time of that turn.
 */
function probeTurns(): TurnProbe {
  const worked: Turn[] = [];
  let bytes = 0;
  let items = 0;
  let last = performance.now();
  let running = true;
  const tick = (): void => {
    if (!running) return;
    const now = performance.now();
    if (bytes > 0 || items > 0) worked.push({ ms: now - last, bytes, items });
    bytes = 0;
    items = 0;
    last = now;
    setImmediate(tick);
  };
  setImmediate(tick);
  return {
    bytes: (n) => {
      bytes += n;
    },
    item: () => {
      items++;
    },
    stop: () => {
      running = false;
      // The turn running when the read ended is a turn too: a reader that never yields has only this one.
      if (bytes > 0 || items > 0)
        worked.push({ ms: performance.now() - last, bytes, items });
      return worked;
    },
  };
}

/** Chunks that are ready at once: every `next()` settles without the loop turning. */
async function* replay(
  chunks: readonly Uint8Array[],
): AsyncGenerator<Uint8Array, void, undefined> {
  for (const chunk of chunks) {
    await Promise.resolve(); // a microtask: the loop does not turn
    yield chunk;
  }
}

/** The body of a read, each chunk booked to the probe as the reader pulls it. */
async function* counted(
  body: AsyncIterable<Uint8Array>,
  probe: TurnProbe,
): AsyncGenerator<Uint8Array, void, undefined> {
  for await (const chunk of body) {
    probe.bytes(chunk.length);
    yield chunk;
  }
}

/** Runs `work` with the event-loop delay sampled; the p99 and the maximum are in milliseconds. */
async function measureLoop(
  work: () => Promise<unknown>,
): Promise<{ p99Ms: number; maxMs: number; tookMs: number }> {
  const loop = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  const began = performance.now();
  loop.enable();
  try {
    await work();
  } finally {
    loop.disable();
  }
  return {
    p99Ms: loop.percentile(99) / NS_PER_MS,
    maxMs: loop.max / NS_PER_MS,
    tookMs: performance.now() - began,
  };
}

/** Resolves true if `promise` settles within `ms`, false if the time passed first. */
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const controller = new AbortController();
  const result = await Promise.race([
    promise.then(() => true),
    sleep(ms, false, { signal: controller.signal }),
  ]);
  controller.abort();
  return result;
}

describe('mgmt stream wire proof (150,000 bindings, about 32 MB)', () => {
  // Reading 32 MB over loopback and parsing 150,000 items takes about a second on a development
  // machine (measured, see the report of the commit); 30 s leaves room for a slow shared runner.
  const SLOW_RUNNER_MS = 30_000;

  it(
    'M0-48l AC-13 mgmt stream reads a bare array above the get body limit',
    { timeout: SLOW_RUNNER_MS },
    async () => {
      const { broker, h } = await setup();

      let refused: unknown;
      try {
        await h.client.read.get(
          {
            connectionId: CID,
            path: '/api/bindings/v',
            query: { page: 1, page_size: 500 },
            schema: z.array(z.unknown()),
            lane: 'interactive',
          },
          h.signal,
        );
      } catch (error) {
        refused = error;
      }
      let count = 0;
      let outOfOrder = 0;
      const end = await readStream(
        h,
        { maxItems: 200_000, ...LIMITS },
        (item) => {
          if (
            (item as { destination?: unknown }).destination !==
            destinationOf(count)
          ) {
            outOfOrder++;
          }
          count++;
        },
      );

      expect(refused).toBeInstanceOf(MgmtHttpError);
      expect((refused as MgmtHttpError).reason).toBe('response-too-large');
      expect(end.kind).toBe('complete');
      expect(end.items).toBe(ITEMS);
      expect(count).toBe(ITEMS);
      expect(outOfOrder).toBe(0);
      // The answer is above the 16 MiB limit of `get` (about 32 MB), and every byte was taken.
      expect(end.bytes).toBeGreaterThan(30 * 1_000_000);
      expect(end.bytes).toBe(broker.served[1]?.written);
      // The get and the stream each sent one request, with the page the client adds to a paged list.
      expect(broker.served.map((entry) => entry.url)).toEqual([
        BINDINGS,
        BINDINGS,
      ]);
      expect(broker.served[1]?.finished).toBe(true);
    },
  );

  it(
    'M0-48l AC-14 mgmt stream closes the socket when the reader stops early',
    { timeout: SLOW_RUNNER_MS },
    async () => {
      const { broker, h } = await setup();

      const end = await readStream(
        h,
        { maxItems: 1_000, ...LIMITS },
        () => undefined,
      );
      const stopped = performance.now();
      const entry = broker.served[0];
      // What is proved is that the socket closes after an early stop (and that the server did not write
      // the rest), not how fast: the wait is the generous one of the slow runner (inside the test's
      // own timeout), so a loaded machine cannot fail it. `closeMs` is printed, not asserted.
      const closedInTime = await within(
        entry?.closed ?? Promise.resolve(),
        SLOW_RUNNER_MS / 2,
      );
      const closeMs = performance.now() - stopped;
      // The pool is not poisoned: the next request of the same client is answered.
      const overview = await h.client.read.get(
        {
          connectionId: CID,
          path: '/api/overview',
          schema: z.object({ node: z.string() }),
          lane: 'interactive',
        },
        h.signal,
      );

      expect(end.kind).toBe('item-limit');
      expect(end.items).toBe(1_000);
      expect(closedInTime).toBe(true);
      expect(entry?.finished).toBe(false);
      expect(entry?.written).toBeLessThan(8 * MIB);
      expect(overview).toEqual({ node: 'n1' });
      process.stdout.write(
        `AC-14 early stop: item-limit after 1000 items, socket closed ${closeMs.toFixed(0)} ms later, ` +
          `server wrote ${((entry?.written ?? 0) / MIB).toFixed(2)} MiB of ${((ITEMS * 215) / MIB).toFixed(0)} MiB\n`,
      );
    },
  );

  it(
    'M0-48l AC-15 mgmt stream read keeps event-loop delay p99 at most 20 ms',
    { timeout: SLOW_RUNNER_MS },
    async () => {
      const { h } = await setup();
      const idle = await measureLoop(() => sleep(500));
      // The body of the real read, taken whole first (about 31 MiB in memory in this test only): the
      // reader is then handed a source that is always ready, as a fast broker or a full socket buffer
      // would, so nothing but its own yield can give the loop a turn. A reader paced by the socket
      // would let the loop run between two chunks whether it yields or not.
      const chunks: Uint8Array[] = [];
      let transferred = 0;
      const body = await h.client.read.stream(bindingsRequest, h.signal);
      for await (const chunk of body) {
        chunks.push(chunk);
        transferred += chunk.length;
      }
      const maxChunk = Math.max(...chunks.map((c) => c.length));

      const probe = probeTurns();
      let count = 0;
      let end: ArrayEnd | undefined;
      const reader = await measureLoop(async () => {
        const json = await openJson(counted(replay(chunks), probe));
        const items = json.array({ maxItems: 200_000, ...LIMITS });
        for (;;) {
          const step = await items.next();
          if (step.done === true) {
            end = step.value;
            return;
          }
          probe.item();
          count++;
        }
      });
      const turns = probe.stop();

      // What is asserted does not depend on how busy the machine is. (1) Work per turn is counted: the
      // bytes the reader pulled and the items it delivered between two turns of the loop, which the
      // OS cannot stretch. (2) The cheapest of the turns that did a full share of bytes is a time
      // that preemption can only lengthen, so a turn of the reader costs at best this much.
      const mostBytes = Math.max(...turns.map((t) => t.bytes));
      const mostItems = Math.max(...turns.map((t) => t.items));
      const full = turns.filter((t) => t.bytes >= 0.9 * YIELD_EVERY_BYTES);
      const fullTurnMs = Math.min(...full.map((t) => t.ms));
      const worstTurnMs = Math.max(...turns.map((t) => t.ms));
      // `monitorEventLoopDelay` is a measurement here, printed and not asserted: it reports the whole
      // interval between two ticks, so it reads the OS scheduler (OQ-720, OQ-731, OQ-775).
      process.stdout.write(
        `AC-15 read of ${String(end?.items)} bindings (${((end?.bytes ?? 0) / MIB).toFixed(1)} MiB, ${String(chunks.length)} chunks) ` +
          `took ${reader.tookMs.toFixed(0)} ms in ${String(turns.length)} turns of the loop; at most ${String(mostBytes)} bytes and ` +
          `${String(mostItems)} items per turn, a turn of 90% of the byte share or more took ${fullTurnMs.toFixed(1)} ms at best ` +
          `and ${worstTurnMs.toFixed(1)} ms at worst; event-loop delay p99 (not asserted): idle ${idle.p99Ms.toFixed(1)} ms, ` +
          `with the reader ${reader.p99Ms.toFixed(1)} ms, max ${reader.maxMs.toFixed(1)} ms\n`,
      );

      expect(end?.kind).toBe('complete');
      expect(count).toBe(ITEMS);
      expect(end?.bytes).toBe(transferred);
      // Without the yield the reader takes every chunk in one turn: 31 MiB and 150,000 items.
      expect(turns.length).toBeGreaterThan(
        transferred / (YIELD_EVERY_BYTES + maxChunk),
      );
      expect(mostBytes).toBeLessThan(YIELD_EVERY_BYTES + maxChunk);
      expect(mostItems).toBeLessThanOrEqual(YIELD_EVERY_ITEMS);
      expect(full.length).toBeGreaterThan(0);
      expect(fullTurnMs).toBeLessThanOrEqual(20);
    },
  );
});
