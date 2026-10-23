// M1-10: the codecs of @app/decoders running in the pool of @app/plugin-host, in a real worker.
// The two libraries cannot import each other (adapter and kernel layers); this is where they meet,
// as the composition root will join them.
import * as zlib from 'node:zlib';

import {
  codecPoolOptions,
  decodePayload,
  encodePayload,
  type DecodedPayload,
  type PayloadInput,
} from '@app/decoders';
import {
  createWorkerPool,
  type PoolEvent,
  type WorkerPool,
} from '@app/plugin-host';
import { afterEach, describe, expect, it } from 'vitest';

const MIB = 1024 * 1024;
const open: WorkerPool<PayloadInput, DecodedPayload>[] = [];

function makePool(
  extra: Partial<Parameters<typeof createWorkerPool>[0]> = {},
): WorkerPool<PayloadInput, DecodedPayload> {
  const pool = createWorkerPool<PayloadInput, DecodedPayload>({
    ...codecPoolOptions(),
    execArgv: ['--no-warnings'],
    timeoutMs: 10_000,
    ...extra,
  });
  open.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((pool) => pool.close()));
});

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

function bigJson(bytes: number): Uint8Array {
  const filler = 'x'.repeat(bytes - 19);
  return enc(`{"filler":"${filler}","n":1}`);
}

describe('payload codecs in the tier-1 pool', () => {
  it('M1-10 AC-1 decodes a gzip msgpack body in a worker to the same result as in process', async () => {
    const document = { order: 17, lines: [{ sku: 'A-1', qty: 2 }], paid: true };
    const input: PayloadInput = {
      body: zlib.gzipSync(encodePayload('msgpack', document)),
      contentEncoding: 'gzip',
      contentType: 'application/x-msgpack',
    };
    const outcome = await makePool().run(input);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toEqual(decodePayload(input));
    expect(outcome.value.view).toMatchObject({ kind: 'tree', value: document });
    expect(outcome.value.layers[0]).toMatchObject({ encoding: 'gzip' });
  });

  it('M1-10 AC-1 returns hex and the inline error for a malformed payload', async () => {
    const outcome = await makePool().run({
      body: enc('{"a":[1,2'),
      contentType: 'application/json',
    });
    expect(outcome.ok && outcome.value.view.kind).toBe('hex');
    expect(outcome.ok && outcome.value.error?.code).toBe('MALFORMED_JSON');
  });

  it('M1-10 AC-12 decodes 16 MiB while the main loop keeps turning', async () => {
    const pool = makePool();
    const input: PayloadInput = {
      body: bigJson(16 * MIB - 100),
      contentType: 'application/json',
    };
    const state = { settled: false };
    const job = pool.run(input).finally(() => {
      state.settled = true;
    });
    // The decode takes many loop turns' worth of work; the loop must have turned meanwhile. A
    // count, not a percentile: on this thread the same work would give no turns at all.
    let ticks = 0;
    while (!state.settled) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      ticks++;
    }
    const outcome = await job;
    expect(ticks).toBeGreaterThanOrEqual(5);
    expect(outcome.ok && outcome.value.error).toBeUndefined();
    expect(outcome.ok && outcome.value.counters.inputBytes).toBe(
      16 * MIB - 100,
    );
    expect(outcome.ok && outcome.value.counters.viewBytes).toBeLessThanOrEqual(
      4 * MIB,
    );
  });

  it('M1-10 AC-2 terminates a decode that passes its time budget and the engine stays healthy', async () => {
    const pool = makePool({ timeoutMs: 5 });
    const slow = await pool.run({
      body: bigJson(16 * MIB - 100),
      contentType: 'application/json',
    });
    expect(slow).toEqual({ ok: false, reason: 'timeout' });
    expect(pool.stats()).toMatchObject({
      workersTerminated: 1,
      rejected: { timeout: 1 },
    });
    const quick = await pool.run(
      { body: enc('{"a":1}') },
      { timeoutMs: 10_000 },
    );
    expect(quick.ok && quick.value.view.kind).toBe('tree');
    expect(pool.stats().workersStarted).toBe(2);
  });

  it('M1-10 AC-2 turns a decompression bomb into a coded result without hurting the worker', async () => {
    const pool = makePool();
    const bomb = zlib.gzipSync(Buffer.alloc(40 * MIB));
    const outcome = await pool.run({ body: bomb, contentEncoding: 'gzip' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(['OUTPUT_LIMIT', 'RATIO_LIMIT']).toContain(
      outcome.value.error?.code,
    );
    expect(outcome.value.view.kind).toBe('hex');
    // The same worker serves the next payload: nothing was lost, nothing was restarted.
    const next = await pool.run({ body: enc('{"ok":true}') });
    expect(next.ok && next.value.view.kind).toBe('tree');
    expect(pool.stats()).toMatchObject({
      workersStarted: 1,
      workersTerminated: 0,
    });
  });

  it('M1-10 AC-3 shows a pickle that would run a command as a listing, in the worker too', async () => {
    const outcome = await makePool().run({
      body: Uint8Array.from(
        Buffer.from("cos\nsystem\n(S'echo pwned'\ntR.", 'latin1'),
      ),
      contentType: 'application/x-python-pickle',
    });
    expect(outcome.ok && outcome.value.view).toMatchObject({
      kind: 'disassembly',
      deserialised: false,
    });
    expect(outcome.ok && outcome.value.view.text).toContain(
      '! GLOBAL "os" "system"',
    );
  });

  it('M1-10 AC-10 refuses an input above the pool limit before it reaches a worker, and counts it', async () => {
    const pool = makePool();
    const outcome = await pool.run({ body: new Uint8Array(16 * MIB + 1) });
    expect(outcome).toEqual({ ok: false, reason: 'input-too-large' });
    expect(pool.stats()).toMatchObject({
      workersStarted: 0,
      rejected: { 'input-too-large': 1 },
    });
  });

  it('M1-10 AC-10 serves a burst through two workers and a bounded queue, in order of arrival', async () => {
    const pool = makePool({ size: 2, maxQueue: 8 });
    const inputs: PayloadInput[] = Array.from({ length: 10 }, (_, i) => ({
      body: enc(JSON.stringify({ i })),
      contentType: 'application/json',
    }));
    const pairs = await Promise.all(
      inputs.map(async (input) => ({ input, outcome: await pool.run(input) })),
    );
    for (const { input, outcome } of pairs) {
      expect(outcome.ok && outcome.value).toEqual(decodePayload(input));
    }
    expect(pool.stats()).toMatchObject({
      submitted: 10,
      completed: 10,
      queueHighWater: 8,
    });
    // One more than the room: the 11th, 12th... are refused at once while 10 are in flight.
    const burst = await Promise.all(
      Array.from({ length: 14 }, () => pool.run({ body: enc('[1]') })),
    );
    const refused = burst.filter((outcome) => !outcome.ok);
    expect(refused).toHaveLength(4);
    expect(pool.stats().rejected['queue-full']).toBe(4);
    expect(pool.stats().queueHighWater).toBeLessThanOrEqual(8);
  });

  it('M1-10 AC-13 sends the event sink sizes and reasons, never payload bytes', async () => {
    const events: PoolEvent[] = [];
    const pool = makePool({
      timeoutMs: 5,
      onEvent: (event) => {
        events.push(event);
      },
    });
    const body = bigJson(16 * MIB - 100);
    body.set(enc('CANARY-5d1e'), 100);
    await pool.run({ body, contentType: 'application/json' });
    await pool.run({ body: new Uint8Array(17 * MIB) });
    expect(events.length).toBeGreaterThan(1);
    expect(JSON.stringify(events)).not.toContain('CANARY');
  });
});
