// Bomb-safe decompression with Node's own zlib. The output of every layer is capped three ways
// and the cap is enforced while inflating (`maxOutputLength`), so a few hundred bytes that
// inflate to gigabytes never allocate more than the allowance:
//   * the absolute cap `maxDecodedBytes`;
//   * the ratio cap: output at most `maxRatio` times the input, but never less than
//     `ratioFloorBytes` (a tiny input may inflate to a small document);
//   * the number of layers is counted by the pipeline.
import * as zlib from 'node:zlib';

import { fail } from './errors.ts';
import type { CodecLimits } from './limits.ts';
import type { DecodeContext, TransformCodec } from './types.ts';

type Inflate = (
  input: Uint8Array,
  options: { maxOutputLength: number },
) => Uint8Array;

/** The most a layer may produce, and whether the ratio (not the absolute cap) set it. */
function allowance(
  inputBytes: number,
  limits: CodecLimits,
): { max: number; byRatio: boolean } {
  const byRatio = Math.max(
    limits.ratioFloorBytes,
    inputBytes * limits.maxRatio,
  );
  return byRatio < limits.maxDecodedBytes
    ? { max: byRatio, byRatio: true }
    : { max: limits.maxDecodedBytes, byRatio: false };
}

export function inflateCapped(
  inflate: Inflate,
  bytes: Uint8Array,
  context: DecodeContext,
): Uint8Array {
  const { max, byRatio } = allowance(bytes.length, context.limits);
  try {
    return inflate(bytes, { maxOutputLength: max });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      return fail(byRatio ? 'RATIO_LIMIT' : 'OUTPUT_LIMIT');
    }
    return fail('MALFORMED_COMPRESSED');
  }
}

const GZIP_MAGIC = [0x1f, 0x8b, 0x08] as const;
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;

function hasMagic(sample: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((byte, i) => sample[i] === byte);
}

function toBytes(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
}

export const gzipCodec: TransformCodec = {
  kind: 'transform',
  id: 'gzip',
  encodings: ['gzip', 'x-gzip'],
  detect: (sample) => (hasMagic(sample, GZIP_MAGIC) ? 0.99 : 0),
  decode: (bytes, context) => ({
    bytes: inflateCapped(zlib.gunzipSync, bytes, context),
  }),
  encode: (bytes) => toBytes(zlib.gzipSync(bytes)),
};

/** HTTP's "deflate" is the zlib format, but some senders write raw deflate. */
const inflateEither: Inflate = (input, options) => {
  try {
    return zlib.inflateSync(input, options);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ERR_BUFFER_TOO_LARGE') {
      throw error;
    }
    return zlib.inflateRawSync(input, options);
  }
};

export const deflateCodec: TransformCodec = {
  kind: 'transform',
  id: 'deflate',
  encodings: ['deflate'],
  detect: () => 0,
  decode: (bytes, context) => ({
    bytes: inflateCapped(inflateEither, bytes, context),
  }),
  encode: (bytes) => toBytes(zlib.deflateSync(bytes)),
};

export const brotliCodec: TransformCodec = {
  kind: 'transform',
  id: 'brotli',
  encodings: ['br', 'brotli'],
  detect: () => 0,
  decode: (bytes, context) => ({
    bytes: inflateCapped(zlib.brotliDecompressSync, bytes, context),
  }),
  encode: (bytes) => toBytes(zlib.brotliCompressSync(bytes)),
};

export const zstdCodec: TransformCodec = {
  kind: 'transform',
  id: 'zstd',
  encodings: ['zstd', 'zst'],
  detect: (sample) => (hasMagic(sample, ZSTD_MAGIC) ? 0.99 : 0),
  decode: (bytes, context) => ({
    bytes: inflateCapped(zlib.zstdDecompressSync, bytes, context),
  }),
  encode: (bytes) => toBytes(zlib.zstdCompressSync(bytes)),
};
