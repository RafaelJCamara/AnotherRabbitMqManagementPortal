import { describe, expect, it } from 'vitest';

import { JsonStreamError, REASON_TEXT } from './errors';
import { openJson } from './index';
import type { ArrayLimits } from './index';
// A byte-for-byte copy of testing/fixtures/mgmt/lavinmq-2.10.2/default/bindings.inVhost.json (the
// recorded paged envelope): this isomorphic project may not import a file from outside itself.
import envelope from './testing/bindings.in-vhost.lavinmq-2.10.2.json?raw';

const encoder = new TextEncoder();
const NO_LIMIT = Number.MAX_SAFE_INTEGER;
const WIDE: ArrayLimits = {
  maxItems: NO_LIMIT,
  maxBytes: NO_LIMIT,
  maxItemBytes: NO_LIMIT,
};

/**
 * A source over `chunks`. When `silent` is set it never answers after the last chunk, and its
 * `return()` never settles either (a real async generator behaves so while a `next()` is pending).
 */
function source(chunks: readonly Uint8Array[], options?: { silent?: boolean }) {
  const state = { pulled: 0, produced: 0, returned: 0, ended: false };
  const iterable: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          const chunk = chunks[state.pulled];
          if (chunk === undefined) {
            if (options?.silent === true) return new Promise(() => undefined);
            state.ended = true;
            return Promise.resolve({ done: true as const, value: undefined });
          }
          state.pulled += 1;
          state.produced += chunk.length;
          return Promise.resolve({ done: false as const, value: chunk });
        },
        return: () => {
          state.returned += 1;
          if (options?.silent === true) return new Promise(() => undefined);
          return Promise.resolve({ done: true as const, value: undefined });
        },
      };
    },
  };
  return { iterable, state };
}

function texts(...parts: string[]): Uint8Array[] {
  return parts.map((part) => encoder.encode(part));
}

function oneByOne(body: string): Uint8Array[] {
  return [...encoder.encode(body)].map((byte) => Uint8Array.of(byte));
}

/** Fails fast with a message instead of waiting for the test timeout. */
async function within<T>(promise: Promise<T>, ms = 200): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('The read did not end.'));
    }, ms);
  });
  try {
    return await Promise.race([promise, hung]);
  } finally {
    clearTimeout(timer);
  }
}

async function failure(promise: Promise<unknown>): Promise<JsonStreamError> {
  try {
    await within(promise);
  } catch (error) {
    if (error instanceof JsonStreamError) return error;
    throw error;
  }
  throw new Error('The read was expected to fail.');
}

async function drain(
  generator: AsyncGenerator<unknown, unknown, undefined>,
): Promise<unknown[]> {
  const items: unknown[] = [];
  for (;;) {
    const step = await generator.next();
    if (step.done === true) return items;
    items.push(step.value);
  }
}

describe('json-stream open', () => {
  it('AC-5 json-stream tells the shape first and reads an envelope within a byte limit', async () => {
    // The shape comes from the first significant byte; blanks may span chunks.
    const shapes: readonly [Uint8Array[], string][] = [
      [texts('[1]'), 'array'],
      [texts(' \n', '\t', ' [1]'), 'array'],
      [texts('{"a":1}'), 'object'],
      [texts('"x"'), 'other'],
      [[], 'empty'],
      [texts(' ', '\n', '\r\t '), 'empty'],
    ];
    for (const [chunks, shape] of shapes) {
      const run = source(chunks);
      expect((await openJson(run.iterable)).shape).toBe(shape);
    }

    // array() on an object delivers nothing and settles the source.
    const object = source(texts('{"a":1}'));
    const stream = await openJson(object.iterable);
    const refused = await failure(drain(stream.array(WIDE)));
    expect(refused.reason).toBe('not-an-array');
    expect(refused.message).toBe(REASON_TEXT['not-an-array']);
    expect(refused.delivered).toBe(0);
    expect(object.state.returned).toBe(1);

    // value() returns the recorded envelope, whatever the chunking.
    for (const chunks of [oneByOne(envelope), [encoder.encode(envelope)]]) {
      const run = source(chunks);
      const read = await openJson(run.iterable);
      expect(read.shape).toBe('object');
      expect(await read.value(NO_LIMIT)).toEqual(JSON.parse(envelope));
      expect(run.state.ended || run.state.returned === 1).toBe(true);
      expect(run.state.returned).toBeLessThanOrEqual(1);
    }

    // value() past its byte limit is too-large; the source is cancelled, not read on.
    const big = source(oneByOne(envelope));
    const bigRead = await openJson(big.iterable);
    const tooLarge = await failure(bigRead.value(100));
    expect(tooLarge.reason).toBe('too-large');
    expect(tooLarge.offset).toBeLessThanOrEqual(100);
    expect(big.state.produced).toBeLessThanOrEqual(101);
    expect(big.state.returned).toBe(1);

    // value() on a truncated envelope, on an empty body and on bad JSON.
    const cases: readonly [string, JsonStreamError['reason']][] = [
      [envelope.slice(0, 300), 'truncated'],
      ['{"items":[1,2', 'truncated'],
      ['{"a":"unfinished', 'truncated'],
      ['"unfinished', 'truncated'],
      ['', 'truncated'],
      ['{"a":canary}', 'malformed'],
      ['{"a":1}x', 'malformed'],
    ];
    for (const [body, reason] of cases) {
      const run = source(oneByOne(body));
      const failed = await failure(
        (await openJson(run.iterable)).value(10_000),
      );
      expect(failed.reason).toBe(reason);
      expect(failed.message).toBe(REASON_TEXT[reason]);
      expect(failed.cause).toBeUndefined();
      expect(
        JSON.stringify(failed, Object.getOwnPropertyNames(failed)),
      ).not.toContain('canary');
      expect(run.state.ended || run.state.returned === 1).toBe(true);
    }

    // A source that reuses one buffer for every chunk: value() keeps its own copies.
    const reused = new Uint8Array(4);
    const pieces = ['{"a"', ':12}'];
    const reuse: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            const piece = pieces.shift();
            if (piece === undefined)
              return Promise.resolve({ done: true as const, value: undefined });
            reused.set(encoder.encode(piece));
            return Promise.resolve({ done: false as const, value: reused });
          },
        };
      },
    };
    expect(await (await openJson(reuse)).value(100)).toEqual({ a: 12 });

    // One claim per stream, and a limit that makes no sense is refused.
    const twice = await openJson(source(texts('{}')).iterable);
    expect(await twice.value(10)).toEqual({});
    await expect(twice.value(10)).rejects.toThrow('already read');
    expect(() => twice.array(WIDE)).toThrow('already read');
    await expect(
      (await openJson(source(texts('{}')).iterable)).value(0),
    ).rejects.toThrow(RangeError);

    // close() cancels an unconsumed source once; a second call is harmless.
    const idle = source(texts('[1,2,3]'));
    const unread = await openJson(idle.iterable);
    await unread.close();
    await unread.close();
    expect(idle.state.returned).toBe(1);
    expect(() => unread.array(WIDE)).toThrow('already read');
  });

  it('AC-6 json-stream ends on abort even when the source is silent', async () => {
    // Two chunks, then silence: the signal ends the read without waiting for the source.
    const silent = source(texts('[1,2,', '3,'), { silent: true });
    const controller = new AbortController();
    const stream = await openJson(silent.iterable, {
      signal: controller.signal,
    });
    const items: unknown[] = [];
    const reading = (async () => {
      for await (const item of stream.array(WIDE)) items.push(item);
    })();
    const ended = failure(reading);
    for (let spin = 0; silent.state.pulled < 2 || spin < 20; spin += 1)
      await Promise.resolve();
    expect(items).toEqual([1, 2, 3]);
    controller.abort();
    const aborted = await ended;
    expect(aborted.reason).toBe('aborted');
    expect(aborted.message).toBe(REASON_TEXT.aborted);
    expect(aborted.delivered).toBe(3);
    expect(silent.state.returned).toBe(1); // called, and not waited for: it never settles

    // The same while the opening is silent (nothing but blanks so far).
    const quiet = source(texts('  '), { silent: true });
    const early = new AbortController();
    const opening = failure(openJson(quiet.iterable, { signal: early.signal }));
    await Promise.resolve();
    early.abort();
    expect((await opening).reason).toBe('aborted');
    expect(quiet.state.returned).toBe(1);

    // Aborted between two chunks: the next chunk is never asked for.
    const between = source(texts('[1,', '2,', '3]'));
    const second = new AbortController();
    const betweenStream = await openJson(between.iterable, {
      signal: second.signal,
    });
    const generator = betweenStream.array(WIDE);
    expect(await generator.next()).toEqual({ done: false, value: 1 });
    const pulledBefore = between.state.pulled;
    second.abort();
    const stopped = await failure(generator.next());
    expect(stopped.reason).toBe('aborted');
    expect(stopped.delivered).toBe(1);
    expect(between.state.pulled).toBe(pulledBefore);
    expect(between.state.returned).toBe(1);

    // Aborted while the current chunk still holds items: they are not delivered.
    const whole = source(texts('[1,2,3]'));
    const chunkAbort = new AbortController();
    const wholeStream = await openJson(whole.iterable, {
      signal: chunkAbort.signal,
    });
    const inChunk = wholeStream.array(WIDE);
    expect(await inChunk.next()).toEqual({ done: false, value: 1 });
    chunkAbort.abort();
    const inChunkStopped = await failure(inChunk.next());
    expect(inChunkStopped.reason).toBe('aborted');
    expect(inChunkStopped.delivered).toBe(1);
    expect(whole.state.returned).toBe(1);

    // Already aborted at openJson: the source is never pulled.
    const never = source(texts('[1]'));
    const done = AbortSignal.abort();
    const refused = await failure(openJson(never.iterable, { signal: done }));
    expect(refused.reason).toBe('aborted');
    expect(refused.offset).toBe(0);
    expect(never.state.pulled).toBe(0);

    // value() is ended by the signal too.
    const slow = source(texts('{"a":'), { silent: true });
    const third = new AbortController();
    const valueStream = await openJson(slow.iterable, { signal: third.signal });
    const valued = failure(valueStream.value(1000));
    await Promise.resolve();
    third.abort();
    expect((await valued).reason).toBe('aborted');
    expect(slow.state.returned).toBe(1);
  });

  it('AC-7 json-stream yields to the event loop at fixed byte and item intervals', async () => {
    const CHUNK = 16 * 1024;
    const YIELD_BYTES = 262_144;
    const YIELD_ITEMS = 5_000;
    const count = 100_000;
    const filler =
      'abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz';
    const body = `[${Array.from({ length: count }, (_, i) => `{"i":${String(i)},"v":"${filler}"}`).join(',')}]`;
    const bytes = encoder.encode(body);
    expect(bytes.length).toBeGreaterThan(YIELD_BYTES * 25); // about 8 MB
    const chunks: Uint8Array[] = [];
    for (let at = 0; at < bytes.length; at += CHUNK)
      chunks.push(bytes.subarray(at, at + CHUNK));

    const measure = async (
      parts: readonly Uint8Array[],
      total: number,
    ): Promise<{
      items: unknown[];
      calls: number;
      maxScanned: number;
      maxDelivered: number;
    }> => {
      const run = source(parts);
      const seen = { items: 0, calls: 0, atBytes: 0, atItems: 0 };
      const worst = { scanned: 0, delivered: 0 };
      const stream = await openJson(run.iterable, {
        yieldNow: () => {
          seen.calls += 1;
          worst.scanned = Math.max(
            worst.scanned,
            run.state.produced - seen.atBytes,
          );
          worst.delivered = Math.max(
            worst.delivered,
            seen.items - seen.atItems,
          );
          seen.atBytes = run.state.produced;
          seen.atItems = seen.items;
          return Promise.resolve();
        },
      });
      const items: unknown[] = [];
      for await (const item of stream.array(WIDE)) {
        seen.items += 1;
        items.push(item);
      }
      // The tail after the last call is bounded as well.
      worst.scanned = Math.max(
        worst.scanned,
        run.state.produced - seen.atBytes,
      );
      worst.delivered = Math.max(worst.delivered, seen.items - seen.atItems);
      expect(run.state.produced).toBe(total);
      return {
        items,
        calls: seen.calls,
        maxScanned: worst.scanned,
        maxDelivered: worst.delivered,
      };
    };

    const bytesRule = await measure(chunks, bytes.length);
    expect(bytesRule.items).toEqual(JSON.parse(body));
    expect(bytesRule.calls).toBeGreaterThanOrEqual(
      Math.floor(bytes.length / YIELD_BYTES),
    );
    expect(bytesRule.maxScanned).toBeLessThanOrEqual(YIELD_BYTES + CHUNK);
    expect(bytesRule.maxDelivered).toBeLessThanOrEqual(YIELD_ITEMS);

    // Many tiny items in one chunk: the item rule makes the calls.
    const tiny = encoder.encode(
      `[${Array.from({ length: 12_000 }, () => '1').join(',')}]`,
    );
    const itemRule = await measure([tiny], tiny.length);
    expect(itemRule.items).toHaveLength(12_000);
    expect(itemRule.calls).toBe(Math.floor(12_000 / YIELD_ITEMS));
    expect(itemRule.maxDelivered).toBeLessThanOrEqual(YIELD_ITEMS);

    // The thresholds are options.
    const counted = { calls: 0 };
    const small = await openJson(source([tiny]).iterable, {
      yieldEveryItems: 1_000,
      yieldNow: () => {
        counted.calls += 1;
        return Promise.resolve();
      },
    });
    expect(await drain(small.array(WIDE))).toHaveLength(12_000);
    expect(counted.calls).toBe(12);
  });
});
