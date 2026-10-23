// The codec registry: the first-party (tier 1) codecs, looked up by id, mime or content-encoding
// token. Order matters only for ties in a sniff.
import { base64Codec } from './base64.ts';
import { cborCodec } from './cbor.ts';
import { cloudeventsCodec } from './cloudevents.ts';
import { brotliCodec, deflateCodec, gzipCodec, zstdCodec } from './compress.ts';
import { hexCodec } from './hex.ts';
import { jsonCodec } from './json.ts';
import { msgpackCodec } from './msgpack.ts';
import { phpCodec } from './php.ts';
import { pickleCodec } from './pickle.ts';
import { textCodec } from './text.ts';
import { xmlCodec } from './xml.ts';
import type {
  FormatCodec,
  FormatCodecId,
  TransformCodec,
  TransformCodecId,
} from './types.ts';

export const FORMAT_CODECS: readonly FormatCodec[] = [
  cloudeventsCodec,
  jsonCodec,
  xmlCodec,
  msgpackCodec,
  cborCodec,
  pickleCodec,
  phpCodec,
  textCodec,
];

export const TRANSFORM_CODECS: readonly TransformCodec[] = [
  gzipCodec,
  deflateCodec,
  brotliCodec,
  zstdCodec,
  base64Codec,
  hexCodec,
];

/** Mimes that say nothing about the format: the bytes decide. */
const GENERIC_MIMES: ReadonlySet<string> = new Set([
  'application/octet-stream',
  'binary/octet-stream',
  'application/unknown',
  'text/plain',
]);

export function isGenericMime(mime: string): boolean {
  return GENERIC_MIMES.has(mime);
}

export function formatCodec(id: FormatCodecId): FormatCodec | undefined {
  return FORMAT_CODECS.find((codec) => codec.id === id);
}

export function transformCodec(
  id: TransformCodecId,
): TransformCodec | undefined {
  return TRANSFORM_CODECS.find((codec) => codec.id === id);
}

/** The format codecs a content-type mime selects: exact, then `+suffix`, then `text/*`. */
export function formatCodecsForMime(mime: string): readonly FormatCodec[] {
  const exact = FORMAT_CODECS.filter((codec) => codec.mimes.includes(mime));
  if (exact.length > 0) return exact;
  const plus = mime.lastIndexOf('+');
  if (plus !== -1) {
    const suffix = `+${mime.slice(plus + 1)}`;
    const bySuffix = FORMAT_CODECS.filter((codec) =>
      codec.mimes.includes(suffix),
    );
    if (bySuffix.length > 0) return bySuffix;
  }
  if (mime.startsWith('text/')) {
    const text = formatCodec('text');
    return text === undefined ? [] : [text];
  }
  return [];
}

/** The transform a `content-encoding` token selects. */
export function transformForEncoding(
  token: string,
): TransformCodec | undefined {
  return TRANSFORM_CODECS.find((codec) => codec.encodings.includes(token));
}

/** The transforms whose magic number the sample carries. */
export function sniffTransform(sample: Uint8Array): TransformCodec | undefined {
  let best: TransformCodec | undefined;
  let bestScore = 0;
  for (const codec of TRANSFORM_CODECS) {
    const score = codec.detect(sample);
    if (score > bestScore) {
      best = codec;
      bestScore = score;
    }
  }
  return best;
}

/** The format codecs that think the sample is theirs, most sure first (at most `limit`). */
export function sniffFormats(
  sample: Uint8Array,
  limit: number,
): { codec: FormatCodec; confidence: number }[] {
  const scored: { codec: FormatCodec; confidence: number }[] = [];
  for (const codec of FORMAT_CODECS) {
    const confidence = codec.detect(sample);
    if (confidence > 0) scored.push({ codec, confidence });
  }
  scored.sort((a, b) => b.confidence - a.confidence);
  return scored.slice(0, limit);
}
