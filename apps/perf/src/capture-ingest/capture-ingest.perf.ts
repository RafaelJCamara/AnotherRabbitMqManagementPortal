// perf:capture-ingest (M1-09, AC-1): 50,000 saved messages through the real capture store, the real
// AES-256-GCM cipher and the real capture worker thread (the built `workers/capture.mjs`), then a
// full-text filter over them.
//
// What is asserted (the issue's first criterion, on this machine):
//   - every message accepted is stored: none lost, none refused (I-13);
//   - a transaction of the worker takes at most 5 ms (p95) and the p99 stays under 25 ms (the max is printed), measured
//     next to the database, in the worker (blueprint 1.4);
//   - the main loop's delay p99 stays at or below 20 ms above what the sampler reads on an idle loop
//     (I-5; on Windows the idle floor is the 15.6 ms timer tick, see the explorer harness);
//   - a full-text filter over the 50,000 returns within 1 s (p95 of 60 runs).
//
// The figures are SYNTHETIC and one machine's: messages of about 1 KiB of JSON, one writer, no broker,
// no UI. They are printed with the machine so a run can be compared with the last.
//
// Node only: `pnpm nx run perf:capture-ingest` (it builds the engine bundle first, for the worker).
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { createIdGenerator } from '@app/kernel';
import {
  createCaptureRepositoryClient,
  createMigrationRunner,
  openSqlite,
} from '@app/persistence';
import type { CaptureRepository } from '@app/ports';
import { createFieldCipher } from '@app/secrets';
import {
  createCaptureStore,
  type CapturedMessageInput,
} from '@app/svc-messages';
import { describe, expect, it } from 'vitest';

const MESSAGES = Number(process.env.PERF_CAPTURE_MESSAGES ?? 50_000);
const BATCH = 200;
const OWNER = 'perf-user';
const TXN_P95_BUDGET_MS = 5;
const TXN_P99_BUDGET_MS = 25;
const LOOP_DELAY_P99_BUDGET_MS = 20;
const SEARCH_BUDGET_MS = 1000;
const SAMPLE_RESOLUTION_MS = 1;
const NS_PER_MS = 1e6;
/** The producer waits when the queue holds more than this many messages (a tap has backpressure). */
const QUEUE_HIGH_WATER = 3000;

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const workerFile = join(
  root,
  'dist',
  'apps',
  'engine',
  'workers',
  'capture.mjs',
);

// Vitest 5 hides the console output of a passing test, and these figures are the point of the run.
const report = (line: string): void => {
  process.stdout.write(line + '\n');
};

const percentile = (sorted: readonly number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;

/** The same messages on every run: mulberry32. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CITIES = [
  'london',
  'paris',
  'lisbon',
  'berlin',
  'madrid',
  'porto',
  'rome',
  'oslo',
];
const STATUSES = [
  'created',
  'paid',
  'packed',
  'shipped',
  'delivered',
  'returned',
];
const WORDS = Array.from(
  { length: 400 },
  (_, i) => `item${String((i * 7919) % 4001)}`,
);

function makeMessage(n: number, random: () => number): CapturedMessageInput {
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)] as T;
  const items = Array.from({ length: 12 }, () => ({
    sku: pick(WORDS),
    qty: 1 + Math.floor(random() * 5),
    note: `${pick(WORDS)} ${pick(WORDS)} ${pick(WORDS)}`,
  }));
  const body = JSON.stringify({
    orderId: `ord-${String(n)}`,
    customer: { name: `customer${String(n % 997)}`, city: pick(CITIES) },
    status: pick(STATUSES),
    items,
    memo: `rarewordmark${String(n % 50_000)}`,
  });
  return {
    receivedAt: 1_700_000_000_000 + n,
    exchange: n % 2 === 0 ? 'orders' : 'billing',
    routingKey: `orders.${pick(STATUSES)}`,
    source: 'orders-queue',
    contentType: 'application/json',
    redelivered: n % 25 === 0,
    properties: {
      messageId: `m-${String(n)}`,
      correlationId: `c-${String(n % 5000)}`,
    },
    headers: {
      'x-tenant': `tenant${String(n % 20)}`,
      'x-region': pick(CITIES),
    },
    body: new TextEncoder().encode(body),
  };
}

async function startWorker(path: string): Promise<{
  repo: CaptureRepository;
  stop: () => Promise<void>;
}> {
  const worker = new Worker(pathToFileURL(workerFile), {
    workerData: { path },
  });
  await new Promise<void>((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', (message: unknown) => {
      if ((message as { type?: unknown } | null)?.type === 'ready') resolve();
    });
  });
  const client = createCaptureRepositoryClient(worker);
  return {
    repo: client,
    stop: async () => {
      client.close();
      worker.postMessage({ type: 'close' });
      await new Promise<void>((resolve) => {
        worker.once('exit', () => {
          resolve();
        });
      });
    },
  };
}

describe('capture ingest perf', () => {
  it(`M1-09 AC-1 ${String(MESSAGES)} saved messages: a full-text filter within 1 s, a transaction of at most 5 ms, the loop free`, async () => {
    if (!existsSync(workerFile)) {
      throw new Error(
        `The capture worker is not built (${workerFile}). Run \`pnpm nx build engine\`.`,
      );
    }
    const dir = await mkdtemp(join(tmpdir(), 'perf-capture-'));
    const path = join(dir, 'data.db');
    const handle = await openSqlite({ path });
    await createMigrationRunner({ handle }).migrate();
    const worker = await startWorker(path);
    try {
      // The transaction time of every batch, measured in the worker.
      const txn: number[] = [];
      const timed: CaptureRepository = {
        ...worker.repo,
        appendMessages: async (batch, limits) => {
          const result = await worker.repo.appendMessages(batch, limits);
          txn.push(result.txnMs);
          return result;
        },
      };
      const key = {
        id: randomBytes(16).toString('hex'),
        key: new Uint8Array(randomBytes(32)),
      };
      const ids = createIdGenerator();
      const store = createCaptureStore({
        repo: timed,
        sealer: createFieldCipher({
          current: () => key,
          byId: (id) => (id === key.id ? key.key : undefined),
        }),
        newId: () => ids.ulid(),
        options: {
          ownerQuotaBytes: 64 * 1024 * 1024 * 1024,
          captureMaxMessages: MESSAGES + 1,
        },
      });
      const capture = await store.create(OWNER, {
        kind: 'manual',
        label: 'perf',
        target: {},
        envClass: 'dev',
        persist: 'saved',
      });

      // The floor of the loop-delay figures: what the sampler reads on a loop doing nothing.
      const loop = monitorEventLoopDelay({ resolution: SAMPLE_RESOLUTION_MS });
      loop.enable();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      loop.disable();
      const idleP99 = loop.percentile(99) / NS_PER_MS;
      loop.reset();

      const random = mulberry32(90);
      const began = performance.now();
      loop.enable();
      for (let from = 0; from < MESSAGES; from += BATCH) {
        const count = Math.min(BATCH, MESSAGES - from);
        const receipt = await store.append(
          OWNER,
          capture.id,
          Array.from({ length: count }, (_, i) =>
            makeMessage(from + i + 1, random),
          ),
        );
        expect(receipt.accepted).toBe(count);
        while (store.stats().queue.items > QUEUE_HIGH_WATER) {
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
      }
      await store.flush();
      loop.disable();
      const ingestMs = performance.now() - began;

      const stats = store.stats();
      const view = await store.capture(OWNER, capture.id);
      txn.sort((a, b) => a - b);
      const loopP99 = loop.percentile(99) / NS_PER_MS;
      const loopAboveFloor = Math.max(
        0,
        loopP99 - Math.max(0, idleP99 - SAMPLE_RESOLUTION_MS),
      );

      // Full-text filters over the whole capture.
      const queries = [
        'london',
        'london shipped',
        'rarewordmark4242',
        'customer17 paris',
        'item42 item17',
        'ship*',
        'lisbon returned item900',
        'tenant7 berlin',
        'rarewordmark4999*',
        'oslo created paid',
      ];
      const search: number[] = [];
      let hits = 0;
      for (let round = 0; round < 6; round += 1) {
        for (const text of queries) {
          const at = performance.now();
          const found = await store.query(OWNER, {
            captureId: capture.id,
            text,
            order: 'desc',
            limit: 100,
          });
          search.push(performance.now() - at);
          hits += found.items.length;
        }
      }
      // A filter that also narrows by metadata, and the first and last windows with no text.
      const mixed = performance.now();
      await store.query(OWNER, {
        captureId: capture.id,
        text: 'london',
        exchange: 'orders',
        redelivered: false,
        order: 'asc',
        limit: 100,
      });
      const mixedMs = performance.now() - mixed;
      search.sort((a, b) => a - b);

      report(
        [
          '',
          `capture-ingest (${String(MESSAGES)} messages of about 1 KiB, one writer, a real worker thread; synthetic)`,
          `  machine            ${cpus()[0]?.model ?? 'unknown'} x${String(cpus().length)}, ${process.platform}, node ${process.version}`,
          `  ingest             ${(ingestMs / 1000).toFixed(1)} s, ${String(Math.round((MESSAGES / ingestMs) * 1000))} messages/s, ${String(stats.batches)} transactions`,
          `  transaction ms     p50 ${percentile(txn, 0.5).toFixed(2)}  p95 ${percentile(txn, 0.95).toFixed(2)}  p99 ${percentile(txn, 0.99).toFixed(2)}  max ${(txn.at(-1) ?? 0).toFixed(2)}  (final batch size ${String(stats.batchSize)})`,
          `  loop delay p99 ms  ${loopP99.toFixed(1)} (idle floor ${idleP99.toFixed(1)}, above floor ${loopAboveFloor.toFixed(1)}), max ${(loop.max / NS_PER_MS).toFixed(1)}`,
          `  search ms          p50 ${percentile(search, 0.5).toFixed(1)}  p95 ${percentile(search, 0.95).toFixed(1)}  max ${(search.at(-1) ?? 0).toFixed(1)}  (${String(search.length)} queries, ${String(hits)} hits; with a metadata filter ${mixedMs.toFixed(1)})`,
          `  counters           accepted ${String(stats.accepted)}, stored ${String(stats.stored)}, refused ${JSON.stringify(stats.refused)}, rejected ${JSON.stringify(stats.rejected)}, lost ${String(stats.lostToError)}`,
          '',
        ].join('\n'),
      );

      expect(stats.accepted).toBe(MESSAGES);
      expect(stats.stored).toBe(MESSAGES);
      expect(stats.lostToError).toBe(0);
      expect(stats.refused).toEqual({
        queueFull: 0,
        tooLarge: 0,
        invalid: 0,
        locked: 0,
      });
      expect(view).toMatchObject({
        messages: MESSAGES,
        droppedQueue: 0,
        droppedQuota: 0,
        droppedLimit: 0,
      });
      expect(hits).toBeGreaterThan(0);
      expect(percentile(txn, 0.95)).toBeLessThanOrEqual(TXN_P95_BUDGET_MS);
      expect(percentile(txn, 0.99)).toBeLessThan(TXN_P99_BUDGET_MS);
      expect(loopAboveFloor).toBeLessThanOrEqual(LOOP_DELAY_P99_BUDGET_MS);
      expect(percentile(search, 0.95)).toBeLessThanOrEqual(SEARCH_BUDGET_MS);
    } finally {
      await worker.stop();
      await handle.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
