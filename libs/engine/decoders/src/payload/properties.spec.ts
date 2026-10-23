import * as zlib from 'node:zlib';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { CODEC_MESSAGES } from '../codecs/errors.ts';
import type { CodecLimits } from '../codecs/limits.ts';
import { TRANSFORM_CODECS } from '../codecs/registry.ts';
import { decodePayload, encodePayload } from './decode-payload.ts';
import type { PayloadInput } from './result.ts';

const MESSAGES = new Set<string>(Object.values(CODEC_MESSAGES));

// Bytes that mostly look like something: the magic numbers and openings the sniffs look for,
// followed by noise, so that the deeper paths of every codec are reached.
const OPENINGS: number[][] = [
  [0x1f, 0x8b, 0x08],
  [0x28, 0xb5, 0x2f, 0xfd],
  [0x80, 0x02],
  [0x7b, 0x22],
  [0x5b],
  [0x3c, 0x61, 0x3e],
  [0x3c, 0x3f, 0x78, 0x6d, 0x6c],
  [0x82, 0xa1],
  [0x9f],
  [0xbf],
  [0xd9, 0xd9, 0xf7],
  [0x61, 0x3a, 0x32, 0x3a, 0x7b],
  [0x4f, 0x3a],
  [0xef, 0xbb, 0xbf],
  [0xff, 0xfe],
];

const noise = fc.uint8Array({ maxLength: 600 });
const bodies = fc.oneof(
  noise,
  fc
    .tuple(fc.constantFrom(...OPENINGS), noise)
    .map(([head, tail]) => Uint8Array.from([...head, ...tail])),
  fc.string({ maxLength: 300 }).map((text) => new TextEncoder().encode(text)),
  fc.json().map((text) => new TextEncoder().encode(text)),
  fc
    .tuple(fc.json(), fc.integer({ min: 0, max: 40 }))
    .map(([text, cut]) =>
      new TextEncoder().encode(text.slice(0, -cut || undefined)),
    ),
);

const contentTypes = fc.option(
  fc.oneof(
    fc.constantFrom(
      'application/json',
      'application/msgpack',
      'application/cbor',
      'application/xml',
      'text/plain; charset=utf-8',
      'text/plain; charset=utf-16le',
      'application/octet-stream',
      'application/x-python-pickle',
      'application/vnd.php.serialized',
      'application/cloudevents+json',
      'application/problem+json',
      'application/nonsense',
    ),
    fc.string({ maxLength: 40 }),
  ),
  { nil: undefined },
);

const encodings = fc.option(
  fc.oneof(
    fc.constantFrom(
      'gzip',
      'deflate',
      'br',
      'zstd',
      'base64',
      'hex',
      'utf-8',
      'identity',
      'gzip, base64',
      'base64, gzip',
      'snappy',
    ),
    fc.string({ maxLength: 20 }),
  ),
  { nil: undefined },
);

const tightLimits: Partial<CodecLimits> = {
  maxInputBytes: 500,
  maxViewBytes: 300,
  maxDecodedBytes: 2000,
  maxRatio: 20,
  ratioFloorBytes: 100,
  maxLayers: 2,
  maxDepth: 4,
  maxNodes: 30,
  previewBytes: 100,
};

const limitChoices = fc.constantFrom<Partial<CodecLimits> | undefined>(
  undefined,
  tightLimits,
  { maxViewBytes: 80, previewBytes: 7 },
  { maxViewBytes: 0 },
);

function check(input: PayloadInput): void {
  const result = decodePayload(input);
  const max = Math.min(
    input.limits?.maxViewBytes ?? 4 * 1024 * 1024,
    4 * 1024 * 1024,
  );
  // The output cap holds, whatever the codec did.
  expect(result.counters.viewBytes).toBeLessThanOrEqual(max);
  expect(Buffer.byteLength(result.view.text, 'utf8')).toBe(
    result.counters.viewBytes,
  );
  // Errors are fixed phrases (I-10); confidence is a confidence.
  if (result.error !== undefined) {
    expect(MESSAGES.has(result.error.message)).toBe(true);
    expect(result.error.message).toBe(CODEC_MESSAGES[result.error.code]);
  }
  expect(result.detected.confidence).toBeGreaterThanOrEqual(0);
  expect(result.detected.confidence).toBeLessThanOrEqual(1);
  expect(result.layers.length).toBeLessThanOrEqual(
    input.limits?.maxLayers ?? 3,
  );
  expect(result.counters.decodedBytes).toBeLessThanOrEqual(
    Math.max(
      input.limits?.maxDecodedBytes ?? 16 * 1024 * 1024,
      input.body.length,
    ),
  );
  for (const cut of result.truncations) {
    expect(cut.max).toBeGreaterThanOrEqual(0);
    if (cut.dropped !== null) expect(cut.dropped).toBeGreaterThanOrEqual(0);
  }
  if (result.view.kind === 'hex' || result.view.kind === 'base64') {
    expect(result.view.shownBytes).toBeLessThanOrEqual(result.view.totalBytes);
    expect(result.view.shownBytes).toBeLessThanOrEqual(
      input.limits?.previewBytes ?? 65536,
    );
  }
  // The result is plain data: it survives structured clone and JSON.
  expect(structuredClone(result)).toEqual(result);
  JSON.stringify(result);
}

describe('decodePayload properties', () => {
  it('M1-10 AC-8 never throws and keeps every cap, whatever the bytes, headers and rules', () => {
    fc.assert(
      fc.property(
        bodies,
        contentTypes,
        encodings,
        limitChoices,
        fc.constantFrom<PayloadInput['view']>(undefined, 'hex', 'base64'),
        fc.boolean(),
        (body, contentType, contentEncoding, limits, view, truncated) => {
          check({
            body,
            ...(contentType === undefined ? {} : { contentType }),
            ...(contentEncoding === undefined ? {} : { contentEncoding }),
            ...(limits === undefined ? {} : { limits }),
            ...(view === undefined ? {} : { view }),
            bodyTruncated: truncated,
            queue: 'orders.new',
            rules: [
              { queue: 'orders.*', codec: 'msgpack' },
              { queue: 'x', charset: 'latin1' },
            ],
          });
          check({
            body,
            ...(contentType === undefined ? {} : { contentType }),
            ...(contentEncoding === undefined ? {} : { contentEncoding }),
            ...(limits === undefined ? {} : { limits }),
          });
        },
      ),
      { numRuns: 1500 },
    );
  });

  it('M1-10 AC-8 holds the caps for compressed hostile input as well', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('gzip', 'deflate', 'brotli', 'zstd'),
        fc.integer({ min: 0, max: 200_000 }),
        fc.constantFrom<Partial<CodecLimits> | undefined>(
          undefined,
          tightLimits,
        ),
        (id, size, limits) => {
          const codec = TRANSFORM_CODECS.find((c) => c.id === id);
          const body =
            codec?.encode?.(new Uint8Array(size)) ?? new Uint8Array(0);
          check({
            body,
            contentEncoding: id === 'brotli' ? 'br' : id,
            ...(limits === undefined ? {} : { limits }),
          });
        },
      ),
      { numRuns: 60 },
    );
  });

  it('M1-10 AC-8 never lets a deeply nested document through the depth limit', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 400 }),
        fc.constantFrom('[', '{"a":', '<a>'),
        (depth, open) => {
          const close = open === '[' ? ']' : open === '<a>' ? '</a>' : '}';
          const text = `${open.repeat(depth)}${open === '<a>' ? 'x' : '1'}${close.repeat(depth)}`;
          const result = decodePayload({
            body: new TextEncoder().encode(text),
          });
          if (result.view.kind === 'tree') {
            // A tree exists only within the depth limit.
            expect(depth).toBeLessThanOrEqual(64);
          }
          check({ body: new TextEncoder().encode(text) });
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('codec round trips', () => {
  const normalise = (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value)) as unknown;

  it('M1-10 AC-9 text round trips through the text codec with its charset declared', () => {
    fc.assert(
      fc.property(
        fc
          .string({ unit: 'grapheme', maxLength: 200 })
          .filter((text) => !text.startsWith('﻿')),
        (text) => {
          const result = decodePayload({
            body: encodePayload('text', text),
            contentType: 'text/plain; charset=utf-8',
          });
          expect(result.view).toMatchObject({ kind: 'text', text });
        },
      ),
    );
  });

  it('M1-10 AC-9 JSON round trips, and so does msgpack', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const expected = normalise(value);
        const json = decodePayload({
          body: encodePayload('json', value),
          contentType: 'application/json',
        });
        expect(json.error).toBeUndefined();
        expect(json.view).toMatchObject({ kind: 'tree', value: expected });
        const pack = decodePayload({
          body: encodePayload('msgpack', value),
          contentType: 'application/msgpack',
        });
        expect(pack.error).toBeUndefined();
        expect(pack.view).toMatchObject({ kind: 'tree', value: expected });
      }),
    );
  });

  it('M1-10 AC-9 the pretty text of a JSON document parses back to the same document', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const result = decodePayload({
          body: encodePayload('json', value),
          contentType: 'application/json',
        });
        if (result.view.kind !== 'tree') throw new Error('expected a tree');
        expect(JSON.parse(result.view.text)).toEqual(normalise(value));
      }),
    );
  });

  it('M1-10 AC-9 every transform undoes its encoder', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 2000 }), (bytes) => {
        for (const codec of TRANSFORM_CODECS) {
          if (codec.encode === undefined) throw new Error(codec.id);
          // Text encodings of nothing are not text: an empty body is empty, not base64.
          if (
            bytes.length === 0 &&
            (codec.id === 'base64' || codec.id === 'hex')
          ) {
            continue;
          }
          const decoded = codec.decode(codec.encode(bytes), {
            limits: {
              maxInputBytes: 1 << 24,
              maxViewBytes: 1 << 22,
              maxDecodedBytes: 1 << 24,
              maxRatio: 1000,
              ratioFloorBytes: 65536,
              maxLayers: 3,
              maxDepth: 64,
              maxNodes: 200000,
              previewBytes: 65536,
            },
          });
          expect(
            Buffer.from(decoded.bytes).equals(Buffer.from(bytes)),
            codec.id,
          ).toBe(true);
        }
      }),
    );
  });

  it('M1-10 AC-9 a pipeline layer returns exactly the bytes that were encoded', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 1000 }),
        fc.constantFrom('gzip', 'deflate', 'brotli', 'zstd', 'base64', 'hex'),
        (bytes, id) => {
          const codec = TRANSFORM_CODECS.find((c) => c.id === id);
          const encoded = codec?.encode?.(bytes) ?? new Uint8Array(0);
          const result = decodePayload({
            body: encoded,
            contentEncoding: id === 'brotli' ? 'br' : id,
            view: 'hex',
          });
          expect(result.layers[0]?.outBytes).toBe(bytes.length);
          expect(result.counters.decodedBytes).toBe(bytes.length);
        },
      ),
    );
    expect(zlib.gunzipSync(zlib.gzipSync(Buffer.from('x'))).toString()).toBe(
      'x',
    );
  });
});

describe('no payload byte outside the view', () => {
  const MARKER = 'CANARY-7f3a91c2';

  it('M1-10 AC-13 keeps payload text out of errors, notes, counters and layers', () => {
    const marker = new TextEncoder().encode(MARKER);
    fc.assert(
      fc.property(
        bodies,
        bodies,
        contentTypes,
        encodings,
        (head, tail, contentType, contentEncoding) => {
          const body = Uint8Array.from([...head, ...marker, ...tail]);
          const result = decodePayload({
            body,
            ...(contentType === undefined ? {} : { contentType }),
            ...(contentEncoding === undefined ? {} : { contentEncoding }),
          });
          expect(JSON.stringify({ ...result, view: undefined })).not.toContain(
            'CANARY',
          );
        },
      ),
      { numRuns: 400 },
    );
  });

  it('M1-10 AC-13 keeps the marker out of the error of every malformed format', () => {
    const attempts: [string, string][] = [
      ['application/json', `{"k":"${MARKER}`],
      ['application/xml', `<${MARKER}>`],
      ['application/msgpack', `\x81\xa8${MARKER}`],
      ['application/cbor', `\xa1x\x0f${MARKER}`],
      ['application/x-python-pickle', `c${MARKER}\n`],
      ['application/vnd.php.serialized', `s:99:"${MARKER}";`],
      ['text/plain; charset=utf-8', MARKER],
    ];
    for (const [contentType, text] of attempts) {
      const result = decodePayload({
        body: Uint8Array.from(Buffer.from(text, 'latin1')),
        contentType,
      });
      expect(
        JSON.stringify({ ...result, view: undefined }),
        contentType,
      ).not.toContain('CANARY');
    }
  });
});
