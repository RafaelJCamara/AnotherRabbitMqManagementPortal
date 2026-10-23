// `nx run engine:smoke`, the capture worker (M1-09): the built `dist/apps/engine/workers/capture.mjs`
// started as a real worker thread, with the real capture store on top of it. It proves what the
// in-process specs cannot: the bundled worker starts, serves the repository over its port, stops, and
// keeps the main loop free while it writes.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createIdGenerator } from '@app/kernel';
import {
  createMigrationRunner,
  openSqlite,
  type PersistenceHandle,
} from '@app/persistence';
import { createFieldCipher } from '@app/secrets';
import {
  createCaptureStore,
  sampleMessage,
  type CaptureStore,
} from '@app/svc-messages';
import { afterEach, describe, expect, it } from 'vitest';

import {
  startCaptureWorker,
  type CaptureWorkerHost,
} from './workers/capture-host';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const workerUrl = pathToFileURL(
  join(root, 'dist', 'apps', 'engine', 'workers', 'capture.mjs'),
);
const OWNER = 'user-1';

interface Stack {
  readonly store: CaptureStore;
  readonly handle: PersistenceHandle;
  readonly host: CaptureWorkerHost;
}

const hosts: CaptureWorkerHost[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  // The worker holds the file open too: stop it before the directory goes.
  await Promise.all(hosts.splice(0).map((host) => host.stop(2000)));
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** The engine's own pieces: a migrated file, the vault's cipher, the store over the worker. */
async function withWorker(): Promise<Stack> {
  const dir = await mkdtemp(join(tmpdir(), 'capture-worker-'));
  const path = join(dir, 'data.db');
  const handle = await openSqlite({ path });
  cleanups.push(async () => {
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  });
  await createMigrationRunner({ handle }).migrate();
  const host = await startCaptureWorker({ path, workerUrl });
  hosts.push(host);
  const key = {
    id: randomBytes(16).toString('hex'),
    key: new Uint8Array(randomBytes(32)),
  };
  const ids = createIdGenerator();
  const store = createCaptureStore({
    repo: host.repo,
    sealer: createFieldCipher({
      current: () => key,
      byId: (id) => (id === key.id ? key.key : undefined),
    }),
    newId: () => ids.ulid(),
  });
  cleanups.unshift(() => store.close());
  return { store, handle, host };
}

const saved = {
  kind: 'manual',
  target: {},
  envClass: 'dev',
  persist: 'saved',
} as const;

describe('the capture worker (built bundle)', () => {
  it('M1-09 AC-12 is a second entry of the bundle, beside main.mjs', () => {
    expect(existsSync(fileURLToPath(workerUrl))).toBe(true);
    expect(existsSync(join(root, 'dist/apps/engine/main.mjs'))).toBe(true);
  });

  it('M1-09 AC-12 stores, finds and reads messages through a real worker thread, and stops cleanly', async () => {
    const { store, handle, host } = await withWorker();
    const capture = await store.create(OWNER, {
      ...saved,
      label: 'through the worker',
    });

    await store.append(
      OWNER,
      capture.id,
      Array.from({ length: 300 }, (_, i) => sampleMessage(i + 1)),
    );
    await store.flush();
    const found = await store.query(OWNER, {
      captureId: capture.id,
      text: 'london created',
      order: 'asc',
      limit: 500,
    });
    const detail = await store.get(OWNER, capture.id, found.items[0]?.id ?? '');

    expect(found.items).toHaveLength(50);
    expect(detail?.properties).toMatchObject({ messageId: 'm-6' });
    expect(Buffer.from(detail?.body ?? []).toString()).toContain('London');
    expect(store.stats()).toMatchObject({ stored: 300, lostToError: 0 });
    expect(host.repo.stats()).toMatchObject({
      inFlight: 0,
      refused: 0,
      timeouts: 0,
    });
    // The main connection sees what the worker's connection wrote (WAL).
    expect(
      (await handle.db.selectFrom('captured_messages').select('id').execute())
        .length,
    ).toBe(300);
    await host.stop(2000);
    await expect(host.exited).resolves.toBeTypeOf('number');
    await expect(host.repo.usage(OWNER)).rejects.toMatchObject({
      code: 'CAPTURE_WORKER_GONE',
    });
  });

  it('M1-09 AC-12 keeps the main loop free while the worker writes 3,000 messages', async () => {
    const { store } = await withWorker();
    const capture = await store.create(OWNER, {
      ...saved,
      label: 'loop delay',
    });
    const delay = monitorEventLoopDelay({ resolution: 5 });

    delay.enable();
    for (let from = 0; from < 3000; from += 100) {
      await store.append(
        OWNER,
        capture.id,
        Array.from({ length: 100 }, (_, i) => sampleMessage(from + i + 1)),
      );
    }
    await store.flush();
    delay.disable();

    const stats = store.stats();
    expect(stats.stored).toBe(3000);
    expect(stats.lostToError).toBe(0);
    expect(stats.refused.queueFull).toBe(0);
    // I-5: the p99 of the loop's delay stays at or below 20 ms (5 ms of timer resolution is added by
    // the histogram). `perf:capture-ingest` measures it on 50,000 messages.
    expect(delay.percentile(99) / 1e6).toBeLessThanOrEqual(20 + 5);
    // The transaction times are measured next to the database, in the worker.
    expect(stats.maxTxnMs).toBeGreaterThan(0);
    expect(stats.maxTxnMs).toBeLessThan(250);
  });

  it('M1-09 AC-12 refuses a database that is not a file, and a path the worker cannot open', async () => {
    await expect(
      startCaptureWorker({ path: ':memory:', workerUrl }),
    ).rejects.toThrow(/database file/);
    const missing = join(root, 'dist', 'no-such-directory', 'data.db');

    await expect(
      startCaptureWorker({ path: missing, workerUrl, startTimeoutMs: 15_000 }),
    ).rejects.toBeInstanceOf(Error);
  });
});
