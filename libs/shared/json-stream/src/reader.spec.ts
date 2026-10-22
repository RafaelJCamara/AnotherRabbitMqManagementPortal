import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { JsonStreamError, REASON_TEXT } from './errors';
import { openJson } from './index';
import type { ArrayEnd, ArrayLimits } from './index';
// A byte-for-byte copy of testing/fixtures/mgmt/4.2.9/stats-off/bindings.inVhost.json (the recorded
// bare answer): this isomorphic project may not import a file from outside itself.
import recorded from './testing/bindings.in-vhost.4.2.9.json?raw';

const encoder = new TextEncoder();
const NO_LIMIT = Number.MAX_SAFE_INTEGER;
const WIDE: ArrayLimits = {
  maxItems: NO_LIMIT,
  maxBytes: NO_LIMIT,
  maxItemBytes: NO_LIMIT,
};

/** A source that counts what is asked of it. `make(i)` builds chunk i, or undefined at the end. */
function probe(make: (index: number) => Uint8Array | undefined) {
  const state = { pulled: 0, produced: 0, returned: 0, ended: false };
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          const chunk = make(state.pulled);
          if (chunk === undefined) {
            state.ended = true;
            return Promise.resolve({ done: true as const, value: undefined });
          }
          state.pulled += 1;
          state.produced += chunk.length;
          return Promise.resolve({ done: false as const, value: chunk });
        },
        return: () => {
          state.returned += 1;
          return Promise.resolve({ done: true as const, value: undefined });
        },
      };
    },
  };
  return { source, state };
}

function cut(
  bytes: Uint8Array,
  sizeOrCuts: number | readonly number[],
): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  if (typeof sizeOrCuts === 'number') {
    for (let at = 0; at < bytes.length; at += sizeOrCuts)
      chunks.push(bytes.subarray(at, at + sizeOrCuts));
    return chunks;
  }
  let from = 0;
  for (const to of [...sizeOrCuts, bytes.length]) {
    chunks.push(bytes.subarray(from, to));
    from = to;
  }
  return chunks;
}

function fromChunks(chunks: readonly Uint8Array[]) {
  return probe((index) => chunks[index]);
}

/** Reads the whole array and keeps what a `for await` would hide: the end of the generator. */
async function readAll(
  source: AsyncIterable<Uint8Array>,
  limits: ArrayLimits = WIDE,
) {
  const stream = await openJson(source);
  const generator = stream.array(limits);
  const items: unknown[] = [];
  for (;;) {
    const step = await generator.next();
    if (step.done === true) return { items, end: step.value };
    items.push(step.value);
  }
}

/** Reads until the array fails; returns the items delivered and the error. */
async function readFailing(
  source: AsyncIterable<Uint8Array>,
  limits: ArrayLimits = WIDE,
) {
  const items: unknown[] = [];
  try {
    const stream = await openJson(source);
    for await (const item of stream.array(limits)) items.push(item);
  } catch (error) {
    if (error instanceof JsonStreamError) return { items, error };
    throw error;
  }
  throw new Error('The read was expected to fail.');
}

/** Everything an error shows to a log: its own fields and its text. */
function visibleParts(error: JsonStreamError): string {
  return JSON.stringify(error, Object.getOwnPropertyNames(error));
}

const text = fc.oneof(
  fc.string({ unit: 'grapheme' }),
  fc.string({ unit: 'binary' }),
  fc.constantFrom(
    '\\',
    '"',
    '\\"',
    '"\\"',
    '😀',
    'é',
    '日本語',
    ' ',
    '[',
    '{',
    ']',
    '}',
    ',',
  ),
);
const jsonValue = fc.letrec<{
  value: unknown;
  array: unknown[];
  object: Record<string, unknown>;
}>((tie) => ({
  value: fc.oneof(
    { maxDepth: 3 },
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean(),
    fc.constant(null),
    text,
    tie('array'),
    tie('object'),
  ),
  array: fc.array(tie('value'), { maxLength: 4 }),
  object: fc.dictionary(
    text.filter((key) => key !== '__proto__'),
    tie('value'),
    { maxKeys: 4 },
  ),
}));

/** The array as text with blanks between tokens (or none), and blanks before and after. */
const arrayText = fc
  .tuple(
    fc.array(jsonValue.value, { maxLength: 8 }),
    fc.constantFrom<string | number | undefined>(undefined, 1, 2, '\t'),
    fc.constantFrom('', ' ', '\n\t ', '\r\n'),
  )
  .map(
    ([values, indent, pad]) =>
      `${pad}${JSON.stringify(values, null, indent)}${pad}`,
  );

describe('json-stream array reader', () => {
  it('M0-48l AC-1 json-stream yields the same items as JSON.parse for every chunking', async () => {
    const check = async (
      body: string,
      cutPoints: readonly number[],
    ): Promise<void> => {
      const bytes = encoder.encode(body);
      const expected = JSON.parse(body) as unknown[];
      for (const chunks of [cut(bytes, cutPoints), cut(bytes, 1), [bytes]]) {
        const { items, end } = await readAll(fromChunks(chunks).source);
        expect(items).toEqual(expected);
        expect(end).toEqual({
          kind: 'complete',
          items: expected.length,
          bytes: bytes.length,
        });
      }
    };

    await fc.assert(
      fc.asyncProperty(
        arrayText,
        fc.array(fc.nat(), { maxLength: 12 }),
        async (body, raw) => {
          const length = encoder.encode(body).length;
          const points = [...new Set(raw.map((n) => n % (length + 1)))].sort(
            (a, b) => a - b,
          );
          await check(body, points);
        },
      ),
      { numRuns: 300 },
    );

    expect((JSON.parse(recorded) as unknown[]).length).toBeGreaterThan(0);
    await check(recorded, [3, 40, 41, 700, 1000]);
  });

  it('M0-48l AC-2 json-stream stops at the item limit, cancels the source and says the total is not known', async () => {
    const limits = { ...WIDE, maxItems: 100 };

    // 1,000 items in 64-byte chunks: the 100th is followed by `,` and the start of the 101st.
    const many = encoder.encode(
      JSON.stringify(Array.from({ length: 1000 }, (_, i) => i)),
    );
    let commas = 0;
    let afterHundredth = 0;
    for (let at = 0; at < many.length; at += 1) {
      if (many[at] === 0x2c && (commas += 1) === 100) {
        afterHundredth = at + 1; // the first byte of item 101
        break;
      }
    }
    const first = fromChunks(cut(many, 64));
    const cutRead = await readAll(first.source, limits);
    expect(cutRead.items).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(cutRead.end.kind).toBe('item-limit');
    expect(cutRead.end.items).toBe(100);
    expect(first.state.returned).toBe(1);
    expect(first.state.pulled).toBe(Math.floor(afterHundredth / 64) + 1); // not one chunk further

    // Exactly 100 items: complete, not cut.
    const exact = encoder.encode(
      JSON.stringify(Array.from({ length: 100 }, (_, i) => i)),
    );
    const second = fromChunks(cut(exact, 64));
    const exactRead = await readAll(second.source, limits);
    expect(exactRead.items).toHaveLength(100);
    expect(exactRead.end).toEqual<ArrayEnd>({
      kind: 'complete',
      items: 100,
      bytes: exact.length,
    });

    // 100 items and a trailing comma: malformed after the 100 items.
    const trailing = encoder.encode(
      `${JSON.stringify(Array.from({ length: 100 }, (_, i) => i)).slice(0, -1)},]`,
    );
    const third = fromChunks(cut(trailing, 64));
    const failed = await readFailing(third.source, limits);
    expect(failed.items).toHaveLength(100);
    expect(failed.error.reason).toBe('malformed');
    expect(failed.error.delivered).toBe(100);
    expect(third.state.returned).toBe(1);
  });

  it('M0-48l AC-3 json-stream is bounded in bytes, in item size and in nesting', async () => {
    const CHUNK = 64 * 1024;
    const settled = (state: { ended: boolean; returned: number }): void => {
      expect(state.ended || state.returned === 1).toBe(true);
      expect(state.returned).toBeLessThanOrEqual(1);
    };
    const shows = (
      error: JsonStreamError,
      reason: JsonStreamError['reason'],
    ): void => {
      expect(error.reason).toBe(reason);
      expect(error.message).toBe(REASON_TEXT[reason]);
      expect(Number.isInteger(error.offset)).toBe(true);
      expect(Number.isInteger(error.delivered)).toBe(true);
    };

    // A 10 MB body of numbers, produced one chunk at a time, against maxBytes 1 MiB.
    const numbers = encoder.encode('1234567,'.repeat(CHUNK / 8));
    const big = probe((i) => {
      if (i >= 160) return undefined;
      return i === 0 ? new Uint8Array([0x5b, ...numbers.subarray(1)]) : numbers;
    });
    const maxBytes = 1024 * 1024;
    const bytesFailed = await readFailing(big.source, { ...WIDE, maxBytes });
    shows(bytesFailed.error, 'too-large');
    expect(big.state.produced).toBeLessThanOrEqual(maxBytes + CHUNK);
    expect(bytesFailed.error.offset).toBeLessThanOrEqual(maxBytes);
    expect(bytesFailed.items.length).toBe(bytesFailed.error.delivered);
    expect(bytesFailed.items.length * 8).toBeLessThanOrEqual(maxBytes);
    settled(big.state);

    // One 5 MB string item against maxItemBytes 64 KiB.
    const filler = new Uint8Array(CHUNK).fill(0x61);
    const long = probe((i) => {
      if (i >= 80) return undefined;
      return i === 0
        ? new Uint8Array([0x5b, 0x22, ...filler.subarray(2)])
        : filler;
    });
    const itemFailed = await readFailing(long.source, {
      ...WIDE,
      maxItemBytes: 64 * 1024,
    });
    shows(itemFailed.error, 'too-large');
    expect(itemFailed.items).toEqual([]);
    expect(long.state.produced).toBeLessThanOrEqual(64 * 1024 + CHUNK + 1);
    settled(long.state);

    // 100,000 nested `[`: counted before JSON.parse runs, so no RangeError.
    const nested = fromChunks(cut(new Uint8Array(100_000).fill(0x5b), CHUNK));
    const deep = await readFailing(nested.source, { ...WIDE, maxDepth: 64 });
    shows(deep.error, 'too-deep');
    expect(deep.items).toEqual([]);
    settled(nested.state);
  });

  it('M0-48l AC-3b json-stream measures an item that lies whole inside one chunk against maxItemBytes', async () => {
    // The check at the end of an item (the item never crossed a chunk) is its own line of the
    // scanner: no earlier part was held, so only the length of the last piece decides.
    const item = `"${'a'.repeat(20)}"`; // 22 bytes
    for (const terminator of [',"b"]', ']']) {
      const body = encoder.encode(`[${item}${terminator}`);
      const make = () => fromChunks([body]);

      // Exactly at the limit passes, one byte under fails; the same body is read both ways.
      const atLimit = await readAll(make().source, {
        ...WIDE,
        maxItemBytes: 22,
      });
      expect(atLimit.items[0], terminator).toBe('a'.repeat(20));

      const over = make();
      const failed = await readFailing(over.source, {
        ...WIDE,
        maxItemBytes: 21,
      });
      expect(failed.error.reason, terminator).toBe('too-large');
      expect(failed.error.message).toBe(REASON_TEXT['too-large']);
      expect(failed.items).toEqual([]);
      expect(failed.error.delivered).toBe(0);
      // The source is settled even though the whole body was in one chunk.
      expect(over.state.returned + Number(over.state.ended)).toBeGreaterThan(0);
    }
  });

  it('M0-48l AC-4 json-stream fails closed on malformed or truncated input with a fixed text', async () => {
    const bytesOf = (...parts: (string | number)[]): Uint8Array =>
      Uint8Array.from(
        parts.flatMap((p) =>
          typeof p === 'number' ? [p] : [...encoder.encode(p)],
        ),
      );
    const cases: readonly {
      body: Uint8Array;
      reason: JsonStreamError['reason'];
      items: unknown[];
    }[] = [
      { body: bytesOf('[1,2'), reason: 'truncated', items: [1] },
      { body: bytesOf('[1,,2]'), reason: 'malformed', items: [1] },
      { body: bytesOf('[1 2]'), reason: 'malformed', items: [] },
      { body: bytesOf('[1,]'), reason: 'malformed', items: [1] },
      { body: bytesOf('[tru]'), reason: 'malformed', items: [] },
      { body: bytesOf('[1]x'), reason: 'trailing-data', items: [1] },
      { body: bytesOf('["', 0xff, '"]'), reason: 'malformed', items: [] },
      { body: bytesOf('{"a":1}'), reason: 'not-an-array', items: [] },
      { body: bytesOf('[{"canary-text":}]'), reason: 'malformed', items: [] },
    ];

    for (const { body, reason, items } of cases) {
      for (const chunks of [[body], cut(body, 1)]) {
        const run = fromChunks(chunks);
        const failed = await readFailing(run.source);
        expect(failed.error.reason).toBe(reason);
        expect(failed.error.message).toBe(REASON_TEXT[reason]);
        expect(failed.items).toEqual(items);
        expect(failed.error.delivered).toBe(items.length);
        expect(failed.error.offset).toBeLessThanOrEqual(body.length);
        expect(failed.error.cause).toBeUndefined();
        expect(visibleParts(failed.error)).not.toContain('canary');
        // The source is settled: read to its end or cancelled, never left open.
        expect(run.state.ended || run.state.returned === 1).toBe(true);
        expect(run.state.returned).toBeLessThanOrEqual(1);
      }
    }
  });
});
