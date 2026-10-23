import * as zlib from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { decodePayload } from '../payload/decode-payload.ts';
import { TRANSFORM_CODECS } from './registry.ts';
import type { TransformCodecId } from './types.ts';

const MIB = 1024 * 1024;
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

function compress(id: TransformCodecId, bytes: Uint8Array): Uint8Array {
  const codec = TRANSFORM_CODECS.find((c) => c.id === id);
  if (codec?.encode === undefined) throw new Error('no encoder');
  return codec.encode(bytes);
}

const HEADERS: Record<'gzip' | 'deflate' | 'brotli' | 'zstd', string> = {
  gzip: 'gzip',
  deflate: 'deflate',
  brotli: 'br',
  zstd: 'zstd',
};

describe('compression codecs', () => {
  for (const id of ['gzip', 'deflate', 'brotli', 'zstd'] as const) {
    it(`M1-10 AC-7 ${id}: a bomb never inflates past the cap and is shown as the compressed bytes`, () => {
      const bomb = compress(id, new Uint8Array(40 * MIB));
      expect(bomb.length).toBeLessThan(200 * 1024);
      const result = decodePayload({
        body: bomb,
        contentEncoding: HEADERS[id],
      });
      expect(['OUTPUT_LIMIT', 'RATIO_LIMIT']).toContain(result.error?.code);
      expect(result.view.kind).toBe('hex');
      // The bytes that could not be inflated are the bytes shown: nothing was inflated.
      expect(result.counters.decodedBytes).toBe(bomb.length);
      expect(result.layers).toEqual([]);
      expect(result.counters.viewBytes).toBeLessThan(4 * MIB);
    });

    it(`M1-10 AC-7 ${id}: the ratio cap refuses what inflates far beyond its size`, () => {
      const body = compress(id, new Uint8Array(2 * MIB));
      const result = decodePayload({
        body,
        contentEncoding: HEADERS[id],
        limits: { maxRatio: 20 },
      });
      expect(result.error?.code).toBe('RATIO_LIMIT');
      // The floor lets a tiny document through whatever its ratio.
      const small = compress(id, enc('{"a":"' + 'x'.repeat(5000) + '"}'));
      const ok = decodePayload({
        body: small,
        contentEncoding: HEADERS[id],
        limits: { maxRatio: 2 },
      });
      expect(ok.error).toBeUndefined();
      expect(ok.view.kind).toBe('tree');
    });

    it(`M1-10 AC-9 ${id}: a document round trips through the header and the encoder`, () => {
      const text = JSON.stringify({
        id,
        items: Array.from({ length: 50 }, (_, i) => i),
      });
      const result = decodePayload({
        body: compress(id, enc(text)),
        contentEncoding: HEADERS[id],
        contentType: 'application/json',
      });
      expect(result.layers).toHaveLength(1);
      expect(result.layers[0]).toMatchObject({
        encoding: id,
        source: 'header',
        outBytes: text.length,
      });
      expect(result.view).toMatchObject({ kind: 'tree' });
    });
  }

  it('M1-10 AC-7 allows a legitimate compressible document under the ratio cap', () => {
    const text = JSON.stringify({
      rows: Array.from({ length: 20000 }, () => 'same row'),
    });
    const body = zlib.gzipSync(text);
    expect(text.length / body.length).toBeGreaterThan(20);
    const result = decodePayload({ body, contentEncoding: 'gzip' });
    expect(result.error).toBeUndefined();
    expect(result.view.kind).toBe('tree');
  });

  it('M1-10 AC-7 sniffs gzip and zstd by their magic numbers, and nothing else', () => {
    const json = enc('{"a":1}');
    for (const id of ['gzip', 'zstd'] as const) {
      const result = decodePayload({ body: compress(id, json) });
      expect(result.layers[0]).toMatchObject({ encoding: id, source: 'sniff' });
      expect(result.view.kind).toBe('tree');
    }
    // Raw deflate and brotli have no magic number: without a header they are only bytes.
    for (const id of ['deflate', 'brotli'] as const) {
      const result = decodePayload({ body: compress(id, json) });
      expect(result.layers).toEqual([]);
      expect(result.view.kind).toBe('hex');
    }
  });

  it('M1-10 AC-7 refuses more layers than the limit, declared or found by magic number', () => {
    let body: Uint8Array = enc('{"a":1}');
    for (let i = 0; i < 4; i++) body = compress('gzip', body);
    const declared = decodePayload({
      body,
      contentEncoding: 'gzip, gzip, gzip, gzip',
    });
    expect(declared.error?.code).toBe('LAYER_LIMIT');
    expect(declared.layers).toHaveLength(3);
    expect(declared.view.kind).toBe('hex');

    const sniffed = decodePayload({ body });
    expect(sniffed.error?.code).toBe('LAYER_LIMIT');
    expect(sniffed.layers).toHaveLength(3);

    const threeBody = compress(
      'gzip',
      compress('gzip', compress('gzip', enc('{"a":1}'))),
    );
    const three = decodePayload({ body: threeBody });
    expect(three.error).toBeUndefined();
    expect(three.layers).toHaveLength(3);
    expect(
      decodePayload({ body: threeBody, limits: { maxLayers: 1 } }).error?.code,
    ).toBe('LAYER_LIMIT');
  });
  it('M1-10 AC-7 reads zlib and raw deflate under the deflate header', () => {
    const json = enc('{"a":1}');
    for (const body of [zlib.deflateSync(json), zlib.deflateRawSync(json)]) {
      const result = decodePayload({ body, contentEncoding: 'deflate' });
      expect(result.view.kind).toBe('tree');
    }
  });

  it('M1-10 AC-7 shows a corrupt or cut-off stream as hex with a coded error', () => {
    const good = zlib.gzipSync(enc('{"a":"' + 'y'.repeat(1000) + '"}'));
    for (const body of [
      good.subarray(0, good.length - 8),
      new Uint8Array([0x1f, 0x8b, 0x08, 0, 1, 2, 3]),
    ]) {
      const result = decodePayload({ body, contentEncoding: 'gzip' });
      expect(result.error?.code).toBe('MALFORMED_COMPRESSED');
      expect(result.view.kind).toBe('hex');
    }
    const garbage = decodePayload({
      body: new Uint8Array(50).fill(7),
      contentEncoding: 'br',
    });
    expect(garbage.error?.code).toBe('MALFORMED_COMPRESSED');
    const zstdBad = decodePayload({
      body: new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3]),
    });
    expect(zstdBad.error?.code).toBe('MALFORMED_COMPRESSED');
  });

  it('M1-10 AC-7 stacks encodings: gzip inside base64', () => {
    const body = enc(zlib.gzipSync(enc('{"a":1}')).toString('base64'));
    const result = decodePayload({ body, contentEncoding: 'base64, gzip' });
    // The header lists gzip last, so it is undone first: it fails on text; the order is the header's.
    expect(result.error?.code).toBe('MALFORMED_COMPRESSED');
    const right = decodePayload({ body, contentEncoding: 'gzip, base64' });
    expect(right.layers.map((l) => l.encoding)).toEqual(['base64', 'gzip']);
    expect(right.view.kind).toBe('tree');
  });
});
