import * as zlib from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { decodePayload, encodePayload } from '../payload/decode-payload.ts';
import type { JsonValue } from './types.ts';

const bytesOf = (hex: string): Uint8Array =>
  Uint8Array.from(Buffer.from(hex.replace(/\s/g, ''), 'hex'));

function msgpack(hex: string, limits = {}): JsonValue | undefined {
  const result = decodePayload({
    body: bytesOf(hex),
    contentType: 'application/msgpack',
    limits,
  });
  return result.view.kind === 'tree' ? result.view.value : undefined;
}

describe('MessagePack codec', () => {
  // The examples of the MessagePack specification and one of each format family.
  const vectors: [string, string, JsonValue][] = [
    ['nil', 'c0', null],
    ['false', 'c2', false],
    ['true', 'c3', true],
    ['positive fixint', '7f', 127],
    ['negative fixint', 'e0', -32],
    ['uint8', 'cc ff', 255],
    ['uint16', 'cd 01 00', 256],
    ['uint32', 'ce 00 01 00 00', 65536],
    ['uint64 in range', 'cf 00 00 00 00 ff ff ff ff', 4294967295],
    [
      'uint64 beyond 2^53',
      'cf ff ff ff ff ff ff ff ff',
      '18446744073709551615',
    ],
    ['int8', 'd0 80', -128],
    ['int16', 'd1 80 00', -32768],
    ['int32', 'd2 80 00 00 00', -2147483648],
    ['int64 beyond 2^53', 'd3 80 00 00 00 00 00 00 00', '-9223372036854775808'],
    ['float32', 'ca 3f c0 00 00', 1.5],
    ['float64', 'cb 3f f1 99 99 99 99 99 9a', 1.1],
    ['float64 NaN', 'cb 7f f8 00 00 00 00 00 00', 'NaN'],
    ['float64 -Infinity', 'cb ff f0 00 00 00 00 00 00', '-Infinity'],
    ['fixstr', 'a5 68 65 6c 6c 6f', 'hello'],
    ['empty fixstr', 'a0', ''],
    ['str8', `d9 20 ${'61'.repeat(32)}`, 'a'.repeat(32)],
    ['str16', `da 01 00 ${'61'.repeat(256)}`, 'a'.repeat(256)],
    ['str32', 'db 00 00 00 02 c3 a9', 'é'],
    ['bin8', 'c4 03 01 02 03', { $bytes: 'AQID' }],
    ['bin16', 'c5 00 01 ff', { $bytes: '/w==' }],
    ['fixarray', '93 01 02 03', [1, 2, 3]],
    ['array16', 'dc 00 02 c3 c2', [true, false]],
    ['array32', 'dd 00 00 00 01 c0', [null]],
    [
      'fixmap (the compact schema example)',
      '82 a7 63 6f 6d 70 61 63 74 c3 a6 73 63 68 65 6d 61 00',
      { compact: true, schema: 0 },
    ],
    ['map16', 'de 00 01 a1 6b a1 76', { k: 'v' }],
    ['map32', 'df 00 00 00 01 01 02', { '1': 2 }],
    ['fixext 1', 'd4 05 ff', { $ext: 5, $bytes: '/w==' }],
    ['ext8', 'c7 03 7f 01 02 03', { $ext: 127, $bytes: 'AQID' }],
    [
      'timestamp 32',
      'd6 ff 00 00 00 01',
      { $timestamp: '1970-01-01T00:00:01.000Z' },
    ],
    [
      'timestamp 64 with nanoseconds',
      'd7 ff 00 3d 09 00 00 00 00 01',
      { $timestamp: '1970-01-01T00:00:01.001Z' },
    ],
    [
      'timestamp 96',
      'c7 0c ff 00 00 00 00 00 00 00 00 00 00 00 02',
      { $timestamp: '1970-01-01T00:00:02.000Z' },
    ],
    [
      'non-string keys become text',
      '82 01 a1 61 c3 c2',
      { '1': 'a', true: false },
    ],
  ];

  for (const [name, hex, expected] of vectors) {
    it(`M1-10 AC-1 decodes ${name}`, () => {
      expect(msgpack(hex)).toEqual(expected);
    });
  }

  it('M1-10 AC-1 renders the decoded tree of a gzip-encoded msgpack body', () => {
    const document = { order: 17, lines: [{ sku: 'A-1', qty: 2 }], paid: true };
    const body = zlib.gzipSync(encodePayload('msgpack', document));
    const result = decodePayload({
      body,
      contentEncoding: 'gzip',
      contentType: 'application/x-msgpack',
    });
    expect(result.layers).toEqual([
      {
        encoding: 'gzip',
        source: 'header',
        inBytes: body.length,
        outBytes: encodePayload('msgpack', document).length,
      },
    ]);
    expect(result.detected).toMatchObject({
      type: 'msgpack',
      source: 'header',
    });
    expect(result.view).toMatchObject({ kind: 'tree', value: document });
    expect(result.error).toBeUndefined();
    // The same body with no headers at all: the gzip magic and the map header are enough.
    const sniffed = decodePayload({ body });
    expect(sniffed.layers[0]).toMatchObject({
      encoding: 'gzip',
      source: 'sniff',
    });
    expect(sniffed.view).toMatchObject({ kind: 'tree', value: document });
  });

  it('M1-10 AC-1 refuses a MessagePack item that lies about its size, without allocating for it', () => {
    const bad = [
      'c1', // never used
      'dd ff ff ff ff c0', // four billion items
      'df ff ff ff ff 01 02',
      'db ff ff ff ff 61', // four billion bytes of text
      'c6 ff ff ff ff 01',
      'c9 ff ff ff ff 01 02',
      '93 01 02', // three items, two present
      '81 a1 6b', // a key without its value
      'a2 ff fe', // invalid UTF-8
      'cc', // cut off
      'c0 c0', // trailing bytes
    ];
    for (const hex of bad) {
      const result = decodePayload({
        body: bytesOf(hex),
        contentType: 'application/msgpack',
      });
      expect(result.error?.code, hex).toBe('MALFORMED_MSGPACK');
      expect(result.view.kind).toBe('hex');
    }
  });

  it('M1-10 AC-8 limits depth, values and string bytes', () => {
    const deep = `${'91'.repeat(500)}c0`;
    expect(
      decodePayload({ body: bytesOf(deep), contentType: 'application/msgpack' })
        .error?.code,
    ).toBe('DEPTH_LIMIT');
    const wide = `dc ffff ${'c0'.repeat(65535)}`;
    expect(
      decodePayload({
        body: bytesOf(wide),
        contentType: 'application/msgpack',
        limits: { maxNodes: 100 },
      }).error?.code,
    ).toBe('NODE_LIMIT');
    const big = decodePayload({
      body: bytesOf(`db 00 20 00 00 ${'61'.repeat(0x200000)}`),
      contentType: 'application/msgpack',
      limits: { maxViewBytes: 1000 },
    });
    expect(big.error?.code).toBe('OUTPUT_LIMIT');
  });

  it('M1-10 AC-8 treats a __proto__ key as an ordinary key', () => {
    const value = msgpack('81 a9 5f 5f 70 72 6f 74 6f 5f 5f 01') as Record<
      string,
      unknown
    >;
    expect(Object.keys(value)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });

  it('M1-10 AC-9 encodes the values it decodes', () => {
    const samples: JsonValue[] = [
      null,
      true,
      0,
      -1,
      -33,
      127,
      128,
      70000,
      -70000,
      1.5,
      'héllo',
      'x'.repeat(40),
      [],
      [1, [2, [3]]],
      { a: 1, b: { c: [true, null] } },
      Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => ['k' + String(i), i]),
      ),
    ];
    for (const sample of samples) {
      expect(
        msgpack(Buffer.from(encodePayload('msgpack', sample)).toString('hex')),
      ).toEqual(sample);
    }
  });
});
