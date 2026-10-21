// The wire proof of M0-48l (slice D): the real client, the real Dialer and a local HTTP server that
// answers /api/bindings/{vhost} the way RabbitMQ does, as one bare array of every binding. The body
// is generated while it is written (never held whole), so the server costs a few KiB of memory.
//
// What this file proves that the unit tests of the reader and of the bindings store cannot: that the
// bytes of a 32 MB answer go through `read.stream` and `@app/json-stream` item by item where `read.get`
// stops at its 16 MiB limit (AC-13), that a reader that stops early closes the socket and leaves the
// pool usable (AC-14), and that reading the body does not hold the event loop (AC-15, I-5).
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
    'AC-13 mgmt stream reads a bare array above the get body limit',
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
    'AC-14 mgmt stream closes the socket when the reader stops early',
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
      const closedInTime = await within(
        entry?.closed ?? Promise.resolve(),
        1_000,
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
    'AC-15 mgmt stream read keeps event-loop delay p99 at most 20 ms',
    { timeout: SLOW_RUNNER_MS },
    async () => {
      const { h } = await setup();
      const idle = await measureLoop(() => sleep(500));
      let transferred = 0;
      // The same transfer without the reader: what the server and the socket alone do to the loop.
      const transfer = await measureLoop(async () => {
        const body = await h.client.read.stream(bindingsRequest, h.signal);
        for await (const chunk of body) transferred += chunk.length;
      });
      let count = 0;
      let end: ArrayEnd | undefined;
      const heapBefore = process.memoryUsage().heapUsed;
      let heapPeak = heapBefore;
      const sampler = setInterval(() => {
        heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
      }, 20);
      const reader = await measureLoop(async () => {
        end = await readStream(h, { maxItems: 200_000, ...LIMITS }, () => {
          count++;
        });
      });
      clearInterval(sampler);
      // `monitorEventLoopDelay` reports the whole interval between two ticks of its timer, so an idle
      // loop reads about the resolution on Linux and about 16 ms on Windows (a 15.6 ms timer tick),
      // and a busy machine adds to every figure. The limit is therefore on what the reader adds: the
      // p99 above the floor of the platform and above the p99 of the transfer alone (OQ-724, OQ-731).
      // On a quiet Linux runner both are about 1 ms and this is the 20 ms limit of I-5 as written.
      const floor = Math.max(idle.p99Ms - RESOLUTION_MS, transfer.p99Ms);
      const added = Math.max(0, reader.p99Ms - floor);
      process.stdout.write(
        `AC-15 read of ${String(end?.items)} bindings (${((end?.bytes ?? 0) / MIB).toFixed(1)} MiB) took ${reader.tookMs.toFixed(0)} ms ` +
          `(${transfer.tookMs.toFixed(0)} ms without the reader); event-loop delay p99: idle ${idle.p99Ms.toFixed(1)} ms, ` +
          `transfer alone ${transfer.p99Ms.toFixed(1)} ms, with the reader ${reader.p99Ms.toFixed(1)} ms ` +
          `(${added.toFixed(1)} ms added), max ${reader.maxMs.toFixed(1)} ms; ` +
          `heap peak grew ${((heapPeak - heapBefore) / MIB).toFixed(1)} MiB (sampled every 20 ms, not asserted)\n`,
      );

      expect(end?.kind).toBe('complete');
      expect(count).toBe(ITEMS);
      expect(transferred).toBe(end?.bytes);
      expect(added).toBeLessThanOrEqual(20);
    },
  );
});
