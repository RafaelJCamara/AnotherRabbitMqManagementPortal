import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { codecPoolOptions, codecWorkerUrl } from './worker-url.ts';

describe('the codec pool settings', () => {
  it('M1-10 AC-2 asks for the tier-1 limits of the blueprint: 250 ms, 64 MB, 16 MiB in, 4 MiB out', () => {
    const options = codecPoolOptions();
    expect(options.timeoutMs).toBe(250);
    expect(options.resourceLimits.maxOldGenerationSizeMb).toBe(64);
    expect(options.maxInputBytes).toBe(16 * 1024 * 1024);
    expect(options.maxOutputBytes).toBe(4 * 1024 * 1024);
    expect(options.workerUrl).toBe(codecWorkerUrl);
  });

  it('M1-10 AC-2 measures the input and the output the way the codecs bound them', () => {
    const options = codecPoolOptions();
    expect(options.sizeOfInput({ body: new Uint8Array(123) })).toBe(123);
    expect(options.sizeOfInput({ body: 'not bytes' as never })).toBe(0);
    expect(
      options.sizeOfOutput({
        counters: { inputBytes: 1, decodedBytes: 1, viewBytes: 77 },
      } as never),
    ).toBe(77);
  });

  it('M1-10 AC-2 points at a worker module that exists', () => {
    expect(existsSync(fileURLToPath(codecWorkerUrl))).toBe(true);
  });
});
