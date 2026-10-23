// CBOR (RFC 8949), decode only, first-party and bounded (OQ-961). Definite and indefinite
// lengths, tags, half, single and double floats. Every declared length is checked against the
// bytes that are really left, depth and value counts are limited, and the body must be one
// item. The tree is JSON-safe: a byte string is `{"$bytes": base64}`, a tag is
// `{"$tag": n, "$value": item}` (bignums become decimal text), `undefined` and an unassigned
// simple value are `{"$simple": n}`, and an integer beyond 2^53 is its decimal text.
import { fail } from './errors.ts';
import {
  base64Of,
  documentOutput,
  float,
  keyText,
  setOwn,
  TreeBudget,
  wide,
} from './tree.ts';
import type { FormatCodec, JsonValue } from './types.ts';

const BREAK = Symbol('break');
const utf8 = new TextDecoder('utf-8', { fatal: true });

class Reader {
  at = 0;
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly budget: TreeBudget;

  constructor(bytes: Uint8Array, budget: TreeBudget) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    this.budget = budget;
  }

  need(count: number): void {
    if (count > this.bytes.length - this.at) {
      fail('MALFORMED_CBOR', this.bytes.length);
    }
  }

  slice(count: number): Uint8Array {
    this.need(count);
    const out = this.bytes.subarray(this.at, this.at + count);
    this.at += count;
    return out;
  }
}

/** The argument of an item head: a number, or a bigint above 2^53; null for indefinite. */
function argument(reader: Reader, info: number): bigint | null {
  if (info < 24) return BigInt(info);
  if (info === 31) return null;
  if (info > 27) return fail('MALFORMED_CBOR', reader.at - 1);
  reader.need(info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : 8);
  if (info === 24) return BigInt(reader.view.getUint8(reader.at++));
  if (info === 25) {
    const v = reader.view.getUint16(reader.at);
    reader.at += 2;
    return BigInt(v);
  }
  if (info === 26) {
    const v = reader.view.getUint32(reader.at);
    reader.at += 4;
    return BigInt(v);
  }
  if (info === 27) {
    const v = reader.view.getBigUint64(reader.at);
    reader.at += 8;
    return v;
  }
  if (info === 31) return null;
  return fail('MALFORMED_CBOR', reader.at - 1);
}

function length(reader: Reader, arg: bigint): number {
  if (arg > BigInt(reader.bytes.length - reader.at)) {
    fail('MALFORMED_CBOR', reader.bytes.length);
  }
  return Number(arg);
}

function half(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function bigintOf(bytes: Uint8Array): bigint {
  let out = 0n;
  for (const byte of bytes) out = (out << 8n) | BigInt(byte);
  return out;
}

function chunks(reader: Reader, major: 2 | 3): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    reader.budget.node(reader.at);
    reader.need(1);
    const head = reader.view.getUint8(reader.at++);
    if (head === 0xff) break;
    if (head >> 5 !== major || (head & 31) === 31) {
      fail('MALFORMED_CBOR', reader.at - 1);
    }
    const arg = argument(reader, head & 31);
    if (arg === null) fail('MALFORMED_CBOR', reader.at - 1);
    const size = length(reader, arg);
    total += size;
    reader.budget.content(size, reader.at);
    parts.push(reader.slice(size));
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}

function item(reader: Reader, depth: number): JsonValue | typeof BREAK {
  reader.budget.enter(depth, reader.at);
  reader.need(1);
  const start = reader.at;
  const head = reader.view.getUint8(reader.at++);
  if (head === 0xff) return BREAK;
  reader.budget.node(start);
  const major = head >> 5;
  const info = head & 31;
  const arg = major === 7 ? null : argument(reader, info);
  switch (major) {
    case 0:
      if (arg === null) return fail('MALFORMED_CBOR', start);
      return wide(arg);
    case 1:
      if (arg === null) return fail('MALFORMED_CBOR', start);
      return wide(-1n - arg);
    case 2: {
      if (arg === null) {
        return { $bytes: base64Of(chunks(reader, 2)) };
      }
      const size = length(reader, arg);
      const raw = reader.slice(size);
      reader.budget.content(Math.ceil((size * 4) / 3), start);
      return { $bytes: base64Of(raw) };
    }
    case 3: {
      let raw: Uint8Array;
      if (arg === null) {
        raw = chunks(reader, 3);
      } else {
        const size = length(reader, arg);
        raw = reader.slice(size);
        reader.budget.content(size, start);
      }
      try {
        return utf8.decode(raw);
      } catch {
        return fail('MALFORMED_CBOR', start);
      }
    }
    case 4: {
      const out: JsonValue[] = [];
      if (arg === null) {
        for (;;) {
          const next = item(reader, depth + 1);
          if (next === BREAK) break;
          out.push(next);
        }
        return out;
      }
      const count = length(reader, arg);
      for (let i = 0; i < count; i++) {
        const next = item(reader, depth + 1);
        if (next === BREAK) return fail('MALFORMED_CBOR', reader.at - 1);
        out.push(next);
      }
      return out;
    }
    case 5: {
      const out: Record<string, JsonValue> = {};
      const read = (): boolean => {
        const key = item(reader, depth + 1);
        if (key === BREAK) return false;
        const next = item(reader, depth + 1);
        if (next === BREAK) return fail('MALFORMED_CBOR', reader.at - 1);
        setOwn(out, keyText(key), next);
        return true;
      };
      if (arg === null) {
        while (read()) {
          // until the break
        }
        return out;
      }
      // Every pair takes at least two bytes.
      if (arg * 2n > BigInt(reader.bytes.length - reader.at)) {
        fail('MALFORMED_CBOR', reader.bytes.length);
      }
      for (let i = 0n; i < arg; i++) {
        if (!read()) return fail('MALFORMED_CBOR', reader.at - 1);
      }
      return out;
    }
    case 6: {
      if (arg === null) return fail('MALFORMED_CBOR', start);
      const inner = item(reader, depth + 1);
      if (inner === BREAK) return fail('MALFORMED_CBOR', reader.at - 1);
      if (arg === 55799n) return inner; // self-described CBOR
      if (
        (arg === 2n || arg === 3n) &&
        typeof inner === 'object' &&
        inner !== null &&
        !Array.isArray(inner) &&
        typeof (inner as { $bytes?: unknown }).$bytes === 'string'
      ) {
        const magnitude = bigintOf(
          Buffer.from((inner as { $bytes: string }).$bytes, 'base64'),
        );
        return (arg === 2n ? magnitude : -1n - magnitude).toString();
      }
      return { $tag: wide(arg), $value: inner };
    }
    default: {
      // Major type 7: simple values and floats.
      if (info < 20) return { $simple: info };
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      if (info === 23) return { $simple: 23 };
      if (info === 24) {
        reader.need(1);
        const simple = reader.view.getUint8(reader.at++);
        if (simple < 32) return fail('MALFORMED_CBOR', start);
        return { $simple: simple };
      }
      if (info === 25) {
        reader.need(2);
        const bits = reader.view.getUint16(reader.at);
        reader.at += 2;
        return float(half(bits));
      }
      if (info === 26) {
        reader.need(4);
        const v = reader.view.getFloat32(reader.at);
        reader.at += 4;
        return float(v);
      }
      if (info === 27) {
        reader.need(8);
        const v = reader.view.getFloat64(reader.at);
        reader.at += 8;
        return float(v);
      }
      return fail('MALFORMED_CBOR', start);
    }
  }
}

export const cborCodec: FormatCodec = {
  kind: 'format',
  id: 'cbor',
  mimes: ['application/cbor', '+cbor'],
  detect(sample) {
    if (sample[0] === 0xd9 && sample[1] === 0xd9 && sample[2] === 0xf7) {
      return 0.95; // the self-describe tag
    }
    const first = sample[0];
    if (first === undefined) return 0;
    // A map (major 5) or an array (major 4); a definite-length text string would be too common
    // in other data to be a signal.
    if ((first >= 0xa0 && first <= 0xbf) || (first >= 0x80 && first <= 0x9f)) {
      return 0.4;
    }
    return 0;
  },
  decode(bytes, context) {
    const budget = new TreeBudget(context.limits);
    const reader = new Reader(bytes, budget);
    const result = item(reader, 1);
    if (result === BREAK) return fail('MALFORMED_CBOR', 0);
    if (reader.at !== bytes.length) fail('MALFORMED_CBOR', reader.at);
    return documentOutput(result, 'cbor', 'application/cbor', context.limits);
  },
};
