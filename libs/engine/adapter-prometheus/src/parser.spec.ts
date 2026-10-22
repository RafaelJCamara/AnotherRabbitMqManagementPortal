import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { PromScrapeError } from './errors.ts';
import { parseExposition } from './parser.ts';
import { chunked, parseAll } from './test-support.ts';

const SAMPLE_PAGE = [
  '# HELP rabbitmq_queue_messages_ready Messages ready',
  '# TYPE rabbitmq_queue_messages_ready gauge',
  'rabbitmq_queue_messages_ready 9',
  'rabbitmq_detailed_queue_messages{vhost="/",queue="café-ü-日本"} 3.5e2',
  'rabbitmq_info{a="x\\"y\\\\z\\nw", b="spaced" ,} 1 1700000000000',
  'rabbitmq_nan NaN',
  'rabbitmq_inf +Inf',
  'rabbitmq_ninf -Inf',
  '',
  '  rabbitmq_indented{ queue = "q" } -4.25  ',
].join('\n');

describe('parseExposition grammar', () => {
  it('AC-5 reads names, labels, escapes, spaces, specials and timestamps', async () => {
    const types: [string, string][] = [];
    const { samples, summary } = await parseAll(chunked(SAMPLE_PAGE, [1000]), {
      onType: (name, type) => {
        types.push([name, type]);
      },
    });
    expect(types).toEqual([['rabbitmq_queue_messages_ready', 'gauge']]);
    expect(summary).toMatchObject({ samples: 7, malformed: 0, skipped: 0 });
    expect(samples[0]).toEqual({
      name: 'rabbitmq_queue_messages_ready',
      labels: {},
      value: 9,
    });
    expect(samples[1]).toEqual({
      name: 'rabbitmq_detailed_queue_messages',
      labels: { vhost: '/', queue: 'café-ü-日本' },
      value: 350,
    });
    // `\"` `\\` `\n` unescaped; a space before the comma and a trailing comma are accepted.
    expect(samples[2]).toEqual({
      name: 'rabbitmq_info',
      labels: { a: 'x"y\\z\nw', b: 'spaced' },
      value: 1,
      timestamp: 1_700_000_000_000,
    });
    expect(Number.isNaN(samples[3]?.value)).toBe(true);
    expect(samples[4]?.value).toBe(Number.POSITIVE_INFINITY);
    expect(samples[5]?.value).toBe(Number.NEGATIVE_INFINITY);
    expect(samples[6]).toEqual({
      name: 'rabbitmq_indented',
      labels: { queue: 'q' },
      value: -4.25,
    });
  });

  it('AC-5 drops the families nobody wants before reading their labels', async () => {
    const { samples, summary } = await parseAll(chunked(SAMPLE_PAGE, [64]), {
      wanted: (name) => name === 'rabbitmq_queue_messages_ready',
    });
    expect(samples.map((sample) => sample.name)).toEqual([
      'rabbitmq_queue_messages_ready',
    ]);
    expect(summary).toMatchObject({ samples: 1, skipped: 6, malformed: 0 });
  });

  it('AC-5 the same samples come out of any chunking, also inside a character', async () => {
    const whole = await parseAll(chunked(SAMPLE_PAGE, [1_000_000]));
    // Every two-way split of the bytes, including the ones inside a multibyte character.
    const bytes = new TextEncoder().encode(SAMPLE_PAGE);
    for (let cut = 1; cut < bytes.length; cut++) {
      const split = await parseAll(chunked(bytes, [cut, bytes.length]));
      expect(split.samples).toEqual(whole.samples);
    }
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 40 }), {
          minLength: 1,
          maxLength: 12,
        }),
        async (sizes) => {
          const split = await parseAll(chunked(bytes, sizes));
          expect(split.samples).toEqual(whole.samples);
          expect(split.summary.malformed).toBe(0);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('AC-5 a line without a final newline and a CRLF page are read', async () => {
    const { samples } = await parseAll(
      chunked('a 1\r\nb{x="1"} 2\r\nc 3', [3]),
    );
    expect(samples.map((s) => [s.name, s.value])).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
  });
});

describe('parseExposition bounds', () => {
  it('AC-6 oversized lines, bodies and sample counts are bounded and counted', async () => {
    // A line over the cap is skipped to its end, in one chunk and across many.
    const long = `x{l="${'a'.repeat(300)}"} 1`;
    const page = `a 1\n${long}\nb 2\n${long}`;
    for (const sizes of [[10_000], [7]]) {
      const { samples, summary } = await parseAll(chunked(page, sizes), {
        maxLineBytes: 100,
      });
      expect(samples.map((s) => s.name)).toEqual(['a', 'b']);
      expect(summary.oversizedLines).toBe(2);
    }

    // A body over the cap fails the read, and the source is cancelled.
    let cancelled = false;
    const endless: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          Promise.resolve({ done: false, value: new Uint8Array(1_000) }),
        return: () => {
          cancelled = true;
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    };
    const failure = await parseExposition(endless, () => undefined, {
      maxBodyBytes: 10_000,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PromScrapeError);
    expect((failure as PromScrapeError).reason).toBe('response-too-large');
    expect(cancelled).toBe(true);

    // More samples than the cap: the read stops, says so, and cancels the source.
    cancelled = false;
    const lines = 'm 1\n'.repeat(200);
    const capped = await parseAll(
      {
        [Symbol.asyncIterator]: () => {
          const inner = chunked(lines, [50])[Symbol.asyncIterator]();
          return {
            next: () => inner.next(),
            return: () => {
              cancelled = true;
              return Promise.resolve({ done: true, value: undefined });
            },
          };
        },
      },
      { maxSamples: 25 },
    );
    expect(capped.samples).toHaveLength(25);
    expect(capped.summary.truncated).toBe('samples');
    expect(cancelled).toBe(true);
  });

  it('AC-6 malformed lines are counted; a body that is not an exposition is refused', async () => {
    const mixed = await parseAll(
      chunked(
        'ok 1\n9bad 1\nok{ 2\nok{a="1} 3\nok 1 2 3\nok abc\nok2 5\n',
        [5],
      ),
    );
    expect(mixed.samples.map((s) => s.name)).toEqual(['ok', 'ok2']);
    expect(mixed.summary.malformed).toBe(5);

    const html = '<html>\n<body>Bad gateway</body>\n</html>\n';
    const failure = await parseAll(chunked(html, [100])).catch(
      (error: unknown) => error,
    );
    expect((failure as PromScrapeError).reason).toBe('unexpected-body');

    // A page of comments only, or an empty body, is an exposition with no samples.
    expect((await parseAll(chunked('# HELP a b\n', [3]))).summary.samples).toBe(
      0,
    );
    expect((await parseAll(chunked('', [3]))).summary.samples).toBe(0);
  });

  it('AC-6 a label count past the limit is malformed, not allocated', async () => {
    const many = Array.from({ length: 10 }, (_, i) => `l${String(i)}="v"`).join(
      ',',
    );
    const { samples, summary } = await parseAll(
      chunked(`m{${many}} 1\nn 2\n`, [100]),
      { maxLabels: 5 },
    );
    expect(samples.map((s) => s.name)).toEqual(['n']);
    expect(summary.malformed).toBe(1);
  });

  it('AC-6 an abort ends the read and cancels the source', async () => {
    const controller = new AbortController();
    let cancelled = false;
    let served = 0;
    const slow: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          served++;
          if (served === 3) controller.abort();
          return Promise.resolve({
            done: false,
            value: new TextEncoder().encode('m 1\n'),
          });
        },
        return: () => {
          cancelled = true;
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    };
    const failure = await parseExposition(slow, () => undefined, {
      signal: controller.signal,
    }).catch((error: unknown) => error);
    expect((failure as PromScrapeError).reason).toBe('aborted');
    expect(cancelled).toBe(true);
    // An already-aborted signal never pulls the source.
    served = 0;
    const done = await parseExposition(slow, () => undefined, {
      signal: controller.signal,
    }).catch((error: unknown) => error);
    expect((done as PromScrapeError).reason).toBe('aborted');
    expect(served).toBe(0);
  });
});

describe('parseExposition yields', () => {
  it('AC-7 the parser yields to the event loop', async () => {
    const line =
      'rabbitmq_detailed_queue_messages_ready{vhost="/",queue="queue-000000"} 12345\n';
    const target = 20 * 1024 * 1024;
    const count = Math.ceil(target / line.length);
    const chunk = new TextEncoder().encode(line.repeat(500));
    let remaining = Math.ceil(count / 500);
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          remaining-- > 0
            ? Promise.resolve({ done: false, value: chunk })
            : Promise.resolve({ done: true, value: undefined }),
      }),
    };
    let turns = 0;
    const { summary } = await parseAll(source, {
      yieldNow: () => {
        turns++;
        return Promise.resolve();
      },
    });
    expect(summary.bytes).toBeGreaterThanOrEqual(target);
    expect(summary.samples).toBeGreaterThanOrEqual(count);
    expect(turns).toBe(summary.yields);
    // At most 256 KiB of text and 5,000 lines between two turns (plus the line that crossed it).
    expect(summary.maxCharsBetweenYields).toBeLessThanOrEqual(
      256 * 1024 + line.length,
    );
    expect(summary.maxLinesBetweenYields).toBeLessThanOrEqual(5_000);
    // And the turns are really taken: one per 256 KiB at least.
    expect(turns).toBeGreaterThanOrEqual(
      Math.floor(summary.bytes / (256 * 1024)) - 1,
    );
  });

  it('AC-7 one huge chunk is cut into turns too', async () => {
    const big = new TextEncoder().encode('m 1\n'.repeat(60_000));
    let turns = 0;
    const { summary } = await parseAll(chunked(big, [big.length]), {
      yieldNow: () => {
        turns++;
        return Promise.resolve();
      },
    });
    expect(summary.samples).toBe(60_000);
    expect(summary.maxLinesBetweenYields).toBeLessThanOrEqual(5_000);
    expect(turns).toBeGreaterThanOrEqual(11);
  });
});
