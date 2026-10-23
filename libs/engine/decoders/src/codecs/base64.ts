// A body that is base64 text (standard or URL-safe alphabet, padded or not, with line breaks) is
// turned into the bytes it stands for; the pipeline then runs the result through the codecs again.
import { fail } from './errors.ts';
import type { TransformCodec } from './types.ts';

const INVALID = 255;
const SKIP = 254;
const PAD = 253;
const TABLE = new Uint8Array(256).fill(INVALID);
const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
for (let i = 0; i < 64; i++) TABLE[ALPHABET.charCodeAt(i)] = i;
TABLE['-'.charCodeAt(0)] = 62;
TABLE['_'.charCodeAt(0)] = 63;
for (const white of [0x20, 0x09, 0x0a, 0x0d]) TABLE[white] = SKIP;
TABLE['='.charCodeAt(0)] = PAD;

export function decodeBase64Text(
  bytes: Uint8Array,
  maxBytes: number,
): Uint8Array {
  const n = bytes.length;
  const out = new Uint8Array(Math.min(Math.ceil((n * 3) / 4), maxBytes + 3));
  let written = 0;
  let accumulator = 0;
  let bits = 0;
  let digits = 0;
  let pads = 0;
  for (let at = 0; at < n; at++) {
    const value = TABLE[bytes[at] ?? 0] ?? INVALID;
    if (value === SKIP) continue;
    if (value === INVALID) return fail('MALFORMED_BASE64', at);
    if (value === PAD) {
      pads++;
      if (pads > 2) return fail('MALFORMED_BASE64', at);
      continue;
    }
    if (pads > 0) return fail('MALFORMED_BASE64', at);
    accumulator = (accumulator << 6) | value;
    digits++;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (written >= maxBytes) return fail('OUTPUT_LIMIT');
      out[written++] = (accumulator >> bits) & 0xff;
      accumulator &= (1 << bits) - 1;
    }
  }
  if (digits === 0 || digits % 4 === 1) return fail('MALFORMED_BASE64', n);
  if (pads > 0 && (digits + pads) % 4 !== 0) return fail('MALFORMED_BASE64', n);
  return out.subarray(0, written);
}

export const base64Codec: TransformCodec = {
  kind: 'transform',
  id: 'base64',
  encodings: ['base64'],
  detect: () => 0,
  decode(bytes, context) {
    return { bytes: decodeBase64Text(bytes, context.limits.maxDecodedBytes) };
  },
  encode(bytes) {
    return new TextEncoder().encode(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString(
        'base64',
      ),
    );
  },
};
