import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ObjectKeySchema } from './brands.ts';
import { decodeObjectKey, encodeObjectKey } from './object-key.ts';

// Any well-formed text, with '/' and unicode well represented; NUL is excluded from the vhost
// because it is the separator (the encoder rejects it).
const text = fc.oneof(
  fc.string({ unit: 'binary' }),
  fc.stringMatching(/^[/a-z%+ ]{0,12}$/),
);
const vhost = text.map((value) => value.replaceAll('\u0000', ''));

describe('ObjectKey', () => {
  it('AC-2 decodeObjectKey(encodeObjectKey(x)) equals x for arbitrary vhost and name', () => {
    fc.assert(
      fc.property(vhost, text, (v, n) => {
        expect(decodeObjectKey(encodeObjectKey(v, n))).toEqual({
          vhost: v,
          name: n,
        });
      }),
      { numRuns: 500 },
    );
  });

  it('AC-2 round-trips the default vhost, slashes and unicode', () => {
    for (const [v, n] of [
      ['/', 'orders'],
      ['/', ''],
      ['', ''],
      ['team/a', 'q/with/slashes%2F'],
      ['vhost-日本', 'キュー-🐇'],
      ['a', 'name\u0000with-nul'],
    ] as const) {
      expect(decodeObjectKey(encodeObjectKey(v, n))).toEqual({
        vhost: v,
        name: n,
      });
    }
  });

  it('AC-2 keeps a leading byte order mark in the vhost or the name', () => {
    // The fast-check counterexample from CI: a name that is just U+FEFF lost it when the decoder
    // stripped the BOM, so the key did not round-trip.
    for (const [v, n] of [
      ['', '﻿'],
      ['﻿', ''],
      ['﻿v', '﻿n'],
      ['/', '﻿﻿'],
    ] as const) {
      expect(decodeObjectKey(encodeObjectKey(v, n))).toEqual({
        vhost: v,
        name: n,
      });
    }
  });

  it('AC-2 a key is one path segment: only URL-safe characters, no padding', () => {
    fc.assert(
      fc.property(vhost, text, (v, n) => {
        expect(encodeObjectKey(v, n)).toMatch(/^[A-Za-z0-9_-]+$/);
      }),
    );
  });

  it('AC-2 encodes the documented layout: base64url(utf8(vhost) 0x00 utf8(name))', () => {
    // "/" 0x00 "q" => 2f 00 71 => LwBx
    expect(encodeObjectKey('/', 'q')).toBe('LwBx');
  });

  it('AC-2 rejects what cannot round-trip', () => {
    expect(() => encodeObjectKey('a\u0000b', 'q')).toThrow(/NUL/);
    expect(() => encodeObjectKey('a', 'lone\ud800surrogate')).toThrow(
      /well-formed/,
    );
  });

  it('AC-2 decode rejects keys that are not ours', () => {
    const decode = (key: string) => decodeObjectKey(ObjectKeySchema.parse(key));
    expect(() => decode('YWJj')).toThrow(/separator/); // "abc", no NUL
    expect(() => decode('/+')).toThrow(); // not base64url
    expect(() => decode('AP8')).toThrow(/utf-8/); // 00 ff
    expect(() => decode('A')).toThrow(); // truncated
  });
});
