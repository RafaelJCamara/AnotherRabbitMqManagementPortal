import { describe, expect, it } from 'vitest';

import { createCanaryScanner, MIN_CANARY_LENGTH } from './canary.ts';

const CANARY = 'canary-Secret/9+x"q\\z';

const scan = (data: string | Uint8Array) =>
  createCanaryScanner([CANARY]).scan(data);

describe('createCanaryScanner', () => {
  it('finds the raw value anywhere in a text, once per encoding', () => {
    expect(scan(`before ${CANARY} after ${CANARY}`)).toEqual([
      { index: 0, encoding: 'raw' },
    ]);
  });

  it('finds the JSON-escaped, percent-encoded and hex forms', () => {
    expect(scan(JSON.stringify({ k: CANARY }))).toContainEqual({
      index: 0,
      encoding: 'json',
    });
    expect(scan(`?t=${encodeURIComponent(CANARY)}`)).toContainEqual({
      index: 0,
      encoding: 'url',
    });
    const hex = Buffer.from(CANARY).toString('hex');
    expect(scan(`x${hex.toUpperCase()}x`)).toContainEqual({
      index: 0,
      encoding: 'hex',
    });
  });

  it.each([0, 1, 2])(
    'finds the base64 and base64url forms after %i bytes of other data',
    (lead) => {
      const framed = Buffer.concat([
        Buffer.alloc(lead, 0x41),
        Buffer.from(CANARY),
        Buffer.from('tail'),
      ]);

      expect(scan(framed.toString('base64'))).toContainEqual({
        index: 0,
        encoding: 'base64',
      });
      expect(scan(framed.toString('base64url'))).toContainEqual({
        index: 0,
        encoding: 'base64url',
      });
    },
  );

  it('reads bytes as UTF-8 text', () => {
    expect(scan(Buffer.from(`x ${CANARY} y`))).toEqual([
      { index: 0, encoding: 'raw' },
    ]);
  });

  it('reports each canary by its position and finds nothing in clean text', () => {
    const scanner = createCanaryScanner(['first-canary-value', CANARY]);

    expect(scanner.scan(`...${CANARY}...`)).toEqual([
      { index: 1, encoding: 'raw' },
    ]);
    expect(scanner.scan('[REDACTED] and nothing else')).toEqual([]);
  });

  it('never returns the canary text itself', () => {
    expect(JSON.stringify(scan(CANARY))).not.toContain('canary-Secret');
  });

  it('refuses a canary short enough to match by chance', () => {
    expect(() =>
      createCanaryScanner(['x'.repeat(MIN_CANARY_LENGTH - 1)]),
    ).toThrow(RangeError);
    expect(() =>
      createCanaryScanner(['x'.repeat(MIN_CANARY_LENGTH)]),
    ).not.toThrow();
  });
});
