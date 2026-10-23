import { describe, expect, it } from 'vitest';

import { decodePayload } from '../payload/decode-payload.ts';
import type { JsonValue } from './types.ts';

const bytesOf = (hex: string): Uint8Array =>
  Uint8Array.from(Buffer.from(hex.replace(/\s/g, ''), 'hex'));

function cbor(hex: string, limits = {}): JsonValue | undefined {
  const result = decodePayload({
    body: bytesOf(hex),
    contentType: 'application/cbor',
    limits,
  });
  return result.view.kind === 'tree' ? result.view.value : undefined;
}

describe('CBOR codec', () => {
  // The examples of RFC 8949 appendix A.
  const vectors: [string, string, JsonValue][] = [
    ['0', '00', 0],
    ['1', '01', 1],
    ['10', '0a', 10],
    ['23', '17', 23],
    ['24', '1818', 24],
    ['100', '1864', 100],
    ['1000', '1903e8', 1000],
    ['1000000', '1a000f4240', 1000000],
    ['1000000000000', '1b000000e8d4a51000', 1000000000000],
    ['2^64-1', '1bffffffffffffffff', '18446744073709551615'],
    ['2^64 (bignum)', 'c249010000000000000000', '18446744073709551616'],
    ['-2^64', '3bffffffffffffffff', '-18446744073709551616'],
    ['-2^64-1 (bignum)', 'c349010000000000000000', '-18446744073709551617'],
    ['-1', '20', -1],
    ['-10', '29', -10],
    ['-100', '3863', -100],
    ['-1000', '3903e7', -1000],
    ['0.0', 'f90000', 0],
    ['1.0', 'f93c00', 1],
    ['1.1', 'fb3ff199999999999a', 1.1],
    ['1.5', 'f93e00', 1.5],
    ['65504.0', 'f97bff', 65504],
    ['100000.0', 'fa47c35000', 100000],
    ['3.4028234663852886e+38', 'fa7f7fffff', 3.4028234663852886e38],
    ['1.0e+300', 'fb7e37e43c8800759c', 1e300],
    ['5.960464477539063e-8', 'f90001', 5.960464477539063e-8],
    ['0.00006103515625', 'f90400', 0.00006103515625],
    ['-4.0', 'f9c400', -4],
    ['-4.1', 'fbc010666666666666', -4.1],
    ['Infinity', 'f97c00', 'Infinity'],
    ['NaN', 'f97e00', 'NaN'],
    ['-Infinity', 'f9fc00', '-Infinity'],
    ['false', 'f4', false],
    ['true', 'f5', true],
    ['null', 'f6', null],
    ['undefined', 'f7', { $simple: 23 }],
    ['simple(16)', 'f0', { $simple: 16 }],
    ['simple(255)', 'f8ff', { $simple: 255 }],
    [
      'tag 0 date',
      'c074323031332d30332d32315432303a30343a30305a',
      { $tag: 0, $value: '2013-03-21T20:04:00Z' },
    ],
    ['tag 1 epoch', 'c11a514b67b0', { $tag: 1, $value: 1363896240 }],
    ['tag 23', 'd74401020304', { $tag: 23, $value: { $bytes: 'AQIDBA==' } }],
    ["h''", '40', { $bytes: '' }],
    ["h'01020304'", '4401020304', { $bytes: 'AQIDBA==' }],
    ['""', '60', ''],
    ['"a"', '6161', 'a'],
    ['"IETF"', '6449455446', 'IETF'],
    ['"\\""', '62225c', '"\\'],
    ['"ü"', '62c3bc', 'ü'],
    ['"水"', '63e6b0b4', '水'],
    ['"𐅑"', '64f0908591', '𐅑'],
    ['[]', '80', []],
    ['[1,2,3]', '83010203', [1, 2, 3]],
    ['nested', '8301820203820405', [1, [2, 3], [4, 5]]],
    ['{}', 'a0', {}],
    ['{1:2,3:4}', 'a201020304', { '1': 2, '3': 4 }],
    ['{a:1,b:[2,3]}', 'a26161016162820203', { a: 1, b: [2, 3] }],
    ['["a",{"b":"c"}]', '826161a161626163', ['a', { b: 'c' }]],
    [
      'indefinite bytes',
      '5f42010243030405ff',
      { $bytes: Buffer.from([1, 2, 3, 4, 5]).toString('base64') },
    ],
    ['indefinite text', '7f657374726561646d696e67ff', 'streaming'],
    ['[_ ]', '9fff', []],
    ['[_ 1,[2,3],[_ 4,5]]', '9f018202039f0405ffff', [1, [2, 3], [4, 5]]],
    ['[1,[2,3],[_ 4,5]]', '83018202039f0405ff', [1, [2, 3], [4, 5]]],
    ['{_ "a":1,"b":[_ 2,3]}', 'bf61610161629f0203ffff', { a: 1, b: [2, 3] }],
    [
      '{_ "Fun":true,"Amt":-2}',
      'bf6346756ef563416d7421ff',
      { Fun: true, Amt: -2 },
    ],
    ['self-described', 'd9d9f7 83010203', [1, 2, 3]],
  ];

  for (const [name, hex, expected] of vectors) {
    it(`M1-10 AC-1 decodes the RFC 8949 example ${name}`, () => {
      expect(cbor(hex)).toEqual(expected);
    });
  }

  it('M1-10 AC-1 sniffs the self-describe tag and decodes a map without a content type', () => {
    const tagged = decodePayload({ body: bytesOf('d9d9f7a1616101') });
    expect(tagged.detected).toMatchObject({ type: 'cbor', source: 'sniff' });
    expect(tagged.view).toMatchObject({ kind: 'tree', value: { a: 1 } });
  });

  it('M1-10 AC-1 refuses a CBOR item that lies about its size, without allocating for it', () => {
    const bad = [
      '5affffffff01', // 4 GiB of bytes, one present
      '7aff000000',
      '9bffffffffffffffff', // 2^64 items
      'bbffffffffffffffff',
      '83 01 02', // three items, two present
      'a1 01', // a pair without its value
      '1c', // reserved additional information
      'ff', // a stray break
      '5f 01 ff', // indefinite bytes with a non-bytes chunk
      '7f 4101 ff',
      '62 ffff', // invalid UTF-8
      'f8 10', // simple value that must use the short form
      '00 00', // trailing bytes
      '1b ff',
      '',
    ];
    for (const hex of bad) {
      if (hex === '') continue;
      const result = decodePayload({
        body: bytesOf(hex),
        contentType: 'application/cbor',
      });
      expect(result.error?.code, hex).toBe('MALFORMED_CBOR');
      expect(result.view.kind).toBe('hex');
    }
  });

  it('M1-10 AC-8 limits the depth and the number of values of a CBOR document', () => {
    const deep = `${'81'.repeat(500)}00`;
    expect(
      decodePayload({ body: bytesOf(deep), contentType: 'application/cbor' })
        .error?.code,
    ).toBe('DEPTH_LIMIT');
    const wide = `99ffff${'00'.repeat(65535)}`;
    const result = decodePayload({
      body: bytesOf(wide),
      contentType: 'application/cbor',
      limits: { maxNodes: 1000 },
    });
    expect(result.error?.code).toBe('NODE_LIMIT');
    expect((cbor(wide) as unknown[]).length).toBe(65535);
  });

  it('M1-10 AC-8 treats a __proto__ key as an ordinary key', () => {
    // {"__proto__": 1}
    const value = cbor('a1 69 5f5f70726f746f5f5f 01') as Record<
      string,
      unknown
    >;
    expect(Object.keys(value)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });
});
