// A body that is hex text (either case, with spaces or line breaks) is turned into its bytes.
import { fail } from './errors.ts';
import type { TransformCodec } from './types.ts';

const INVALID = 255;
const SKIP = 254;
const TABLE = new Uint8Array(256).fill(INVALID);
for (let i = 0; i < 10; i++) TABLE[0x30 + i] = i;
for (let i = 0; i < 6; i++) {
  TABLE[0x61 + i] = 10 + i;
  TABLE[0x41 + i] = 10 + i;
}
for (const white of [0x20, 0x09, 0x0a, 0x0d]) TABLE[white] = SKIP;

export function decodeHexText(bytes: Uint8Array, maxBytes: number): Uint8Array {
  const out = new Uint8Array(Math.min(bytes.length >> 1, maxBytes + 1));
  let written = 0;
  let high = -1;
  for (let at = 0; at < bytes.length; at++) {
    const value = TABLE[bytes[at] ?? 0] ?? INVALID;
    if (value === SKIP) continue;
    if (value === INVALID) return fail('MALFORMED_HEX', at);
    if (high < 0) {
      high = value;
    } else {
      if (written >= maxBytes) return fail('OUTPUT_LIMIT');
      out[written++] = (high << 4) | value;
      high = -1;
    }
  }
  if (high >= 0 || written === 0) return fail('MALFORMED_HEX', bytes.length);
  return out.subarray(0, written);
}

export const hexCodec: TransformCodec = {
  kind: 'transform',
  id: 'hex',
  encodings: ['hex'],
  detect: () => 0,
  decode(bytes, context) {
    return { bytes: decodeHexText(bytes, context.limits.maxDecodedBytes) };
  },
  encode(bytes) {
    return new TextEncoder().encode(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString('hex'),
    );
  },
};
