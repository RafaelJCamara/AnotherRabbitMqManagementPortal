import { describe, expect, it } from 'vitest';

import { createPromReader } from './reader.ts';
import { chunked, CID } from './test-support.ts';

const request = {
  connectionId: CID,
  node: 'rabbit@n1',
  path: '/metrics',
  lane: 'background',
} as const;

describe('createPromReader', () => {
  it('AC-5 reads the wanted samples of a scrape and reports what it left out', async () => {
    const asked: unknown[] = [];
    const reader = createPromReader({
      scrape: (given) => {
        asked.push(given);
        return Promise.resolve(
          chunked('keep 1\ndrop 2\nkeep{a="b"} 3\n9bad 1\n', [7]),
        );
      },
    });
    const seen: [string, number][] = [];
    const summary = await reader.read(
      request,
      (sample) => {
        seen.push([sample.name, sample.value]);
      },
      { wanted: (name) => name === 'keep' },
      new AbortController().signal,
    );
    expect(asked).toEqual([request]);
    expect(seen).toEqual([
      ['keep', 1],
      ['keep', 3],
    ]);
    expect(summary).toEqual({
      bytes: 35,
      samples: 2,
      skipped: 1,
      malformed: 1,
      oversizedLines: 0,
    });
  });

  it('AC-6 the sample cap ends the read and is reported, and a failed scrape rejects', async () => {
    const reader = createPromReader({
      scrape: () => Promise.resolve(chunked('m 1\n'.repeat(50), [9])),
    });
    const summary = await reader.read(
      request,
      () => undefined,
      { maxSamples: 5 },
      new AbortController().signal,
    );
    expect(summary).toMatchObject({ samples: 5, truncated: 'samples' });

    const failing = createPromReader({
      scrape: () => Promise.reject(new Error('refused')),
    });
    await expect(
      failing.read(request, () => undefined, {}, new AbortController().signal),
    ).rejects.toThrow('refused');
  });
});
