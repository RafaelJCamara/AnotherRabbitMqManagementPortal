// MessagePack (https://github.com/msgpack/msgpack/blob/master/spec.md), first-party and bounded
// (OQ-961). Every declared length is checked against the bytes that are really left before
// anything is allocated, depth and value counts are limited, and the whole body must be one
// document. The tree is JSON-safe: binary is `{"$bytes": base64}`, an extension is
// `{"$ext": type, "$bytes": base64}`, the timestamp extension is `{"$timestamp": ISO}`, and a
// 64-bit integer beyond 2^53 is its decimal text.
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
      fail('MALFORMED_MSGPACK', this.bytes.length);
    }
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.at++);
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.at);
    this.at += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.at);
    this.at += 4;
    return v;
  }

  slice(count: number): Uint8Array {
    this.need(count);
    const out = this.bytes.subarray(this.at, this.at + count);
    this.at += count;
    return out;
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function text(reader: Reader, length: number): string {
  const raw = reader.slice(length);
  reader.budget.content(length, reader.at);
  try {
    return utf8.decode(raw);
  } catch {
    return fail('MALFORMED_MSGPACK', reader.at - length);
  }
}

function binary(reader: Reader, length: number): JsonValue {
  const raw = reader.slice(length);
  reader.budget.content(Math.ceil((length * 4) / 3), reader.at);
  return { $bytes: base64Of(raw) };
}

function extension(reader: Reader, length: number): JsonValue {
  reader.need(1 + length);
  const type = reader.view.getInt8(reader.at);
  reader.at++;
  const data = reader.slice(length);
  reader.budget.content(Math.ceil((length * 4) / 3), reader.at);
  if (type === -1 && (length === 4 || length === 8 || length === 12)) {
    const view = new DataView(data.buffer, data.byteOffset, data.length);
    let seconds: number;
    let nanos = 0;
    if (length === 4) {
      seconds = view.getUint32(0);
    } else if (length === 8) {
      const high = view.getUint32(0);
      nanos = high >>> 2;
      seconds = (high & 3) * 2 ** 32 + view.getUint32(4);
    } else {
      nanos = view.getUint32(0);
      seconds = Number(view.getBigInt64(4));
    }
    const date = new Date(seconds * 1000 + Math.floor(nanos / 1e6));
    if (nanos < 1e9 && !Number.isNaN(date.getTime())) {
      return { $timestamp: date.toISOString() };
    }
  }
  return { $ext: type, $bytes: base64Of(data) };
}

function array(reader: Reader, count: number, depth: number): JsonValue {
  // Every element takes at least one byte.
  if (count > reader.bytes.length - reader.at) {
    fail('MALFORMED_MSGPACK', reader.bytes.length);
  }
  const out: JsonValue[] = [];
  for (let i = 0; i < count; i++) out.push(value(reader, depth + 1));
  return out;
}

function map(reader: Reader, count: number, depth: number): JsonValue {
  if (count * 2 > reader.bytes.length - reader.at) {
    fail('MALFORMED_MSGPACK', reader.bytes.length);
  }
  const out: Record<string, JsonValue> = {};
  for (let i = 0; i < count; i++) {
    const key = keyText(value(reader, depth + 1));
    setOwn(out, key, value(reader, depth + 1));
  }
  return out;
}

function value(reader: Reader, depth: number): JsonValue {
  reader.budget.enter(depth, reader.at);
  reader.budget.node(reader.at);
  const start = reader.at;
  const tag = reader.u8();
  if (tag <= 0x7f) return tag;
  if (tag >= 0xe0) return tag - 0x100;
  if (tag >= 0xa0 && tag <= 0xbf) return text(reader, tag & 0x1f);
  if (tag >= 0x90 && tag <= 0x9f) return array(reader, tag & 0x0f, depth);
  if (tag >= 0x80 && tag <= 0x8f) return map(reader, tag & 0x0f, depth);
  switch (tag) {
    case 0xc0:
      return null;
    case 0xc2:
      return false;
    case 0xc3:
      return true;
    case 0xc4:
      return binary(reader, reader.u8());
    case 0xc5:
      return binary(reader, reader.u16());
    case 0xc6:
      return binary(reader, reader.u32());
    case 0xc7:
      return extension(reader, reader.u8());
    case 0xc8:
      return extension(reader, reader.u16());
    case 0xc9:
      return extension(reader, reader.u32());
    case 0xca: {
      reader.need(4);
      const v = reader.view.getFloat32(reader.at);
      reader.at += 4;
      return float(v);
    }
    case 0xcb: {
      reader.need(8);
      const v = reader.view.getFloat64(reader.at);
      reader.at += 8;
      return float(v);
    }
    case 0xcc:
      return reader.u8();
    case 0xcd:
      return reader.u16();
    case 0xce:
      return reader.u32();
    case 0xcf: {
      reader.need(8);
      const v = reader.view.getBigUint64(reader.at);
      reader.at += 8;
      return wide(v);
    }
    case 0xd0: {
      reader.need(1);
      return reader.view.getInt8(reader.at++);
    }
    case 0xd1: {
      reader.need(2);
      const v = reader.view.getInt16(reader.at);
      reader.at += 2;
      return v;
    }
    case 0xd2: {
      reader.need(4);
      const v = reader.view.getInt32(reader.at);
      reader.at += 4;
      return v;
    }
    case 0xd3: {
      reader.need(8);
      const v = reader.view.getBigInt64(reader.at);
      reader.at += 8;
      return wide(v);
    }
    case 0xd4:
      return extension(reader, 1);
    case 0xd5:
      return extension(reader, 2);
    case 0xd6:
      return extension(reader, 4);
    case 0xd7:
      return extension(reader, 8);
    case 0xd8:
      return extension(reader, 16);
    case 0xd9:
      return text(reader, reader.u8());
    case 0xda:
      return text(reader, reader.u16());
    case 0xdb:
      return text(reader, reader.u32());
    case 0xdc:
      return array(reader, reader.u16(), depth);
    case 0xdd:
      return array(reader, reader.u32(), depth);
    case 0xde:
      return map(reader, reader.u16(), depth);
    case 0xdf:
      return map(reader, reader.u32(), depth);
    default:
      // 0xc1 is never used.
      return fail('MALFORMED_MSGPACK', start);
  }
}

// ---- encoder (for the round-trip property and the replay editor) ----------------------------

function pushUint(
  out: number[],
  tag: number,
  size: 1 | 2 | 4,
  v: number,
): void {
  out.push(tag);
  for (let shift = (size - 1) * 8; shift >= 0; shift -= 8) {
    out.push(Math.floor(v / 2 ** shift) & 0xff);
  }
}

function pushValue(out: number[], v: unknown, depth: number): void {
  if (depth > 512) fail('DEPTH_LIMIT');
  if (v === null || v === undefined) {
    out.push(0xc0);
  } else if (typeof v === 'boolean') {
    out.push(v ? 0xc3 : 0xc2);
  } else if (typeof v === 'number') {
    if (Number.isInteger(v) && Math.abs(v) <= 0xffffffff) {
      if (v >= 0) {
        if (v <= 0x7f) out.push(v);
        else if (v <= 0xff) pushUint(out, 0xcc, 1, v);
        else if (v <= 0xffff) pushUint(out, 0xcd, 2, v);
        else pushUint(out, 0xce, 4, v);
      } else if (v >= -32) {
        out.push(v + 0x100);
      } else if (v >= -128) {
        out.push(0xd0, v + 0x100);
      } else if (v >= -32768) {
        pushUint(out, 0xd1, 2, v + 0x10000);
      } else {
        pushUint(out, 0xd2, 4, v + 0x100000000);
      }
    } else {
      const raw = new Uint8Array(8);
      new DataView(raw.buffer).setFloat64(0, v);
      out.push(0xcb, ...raw);
    }
  } else if (typeof v === 'string') {
    const raw = new TextEncoder().encode(v);
    if (raw.length < 32) out.push(0xa0 | raw.length);
    else if (raw.length <= 0xff) pushUint(out, 0xd9, 1, raw.length);
    else if (raw.length <= 0xffff) pushUint(out, 0xda, 2, raw.length);
    else pushUint(out, 0xdb, 4, raw.length);
    for (const byte of raw) out.push(byte);
  } else if (v instanceof Uint8Array) {
    if (v.length <= 0xff) pushUint(out, 0xc4, 1, v.length);
    else if (v.length <= 0xffff) pushUint(out, 0xc5, 2, v.length);
    else pushUint(out, 0xc6, 4, v.length);
    for (const byte of v) out.push(byte);
  } else if (Array.isArray(v)) {
    if (v.length < 16) out.push(0x90 | v.length);
    else if (v.length <= 0xffff) pushUint(out, 0xdc, 2, v.length);
    else pushUint(out, 0xdd, 4, v.length);
    for (const item of v) pushValue(out, item, depth + 1);
  } else if (typeof v === 'object') {
    const entries = Object.entries(v);
    if (entries.length < 16) out.push(0x80 | entries.length);
    else if (entries.length <= 0xffff) pushUint(out, 0xde, 2, entries.length);
    else pushUint(out, 0xdf, 4, entries.length);
    for (const [key, item] of entries) {
      pushValue(out, key, depth + 1);
      pushValue(out, item, depth + 1);
    }
  } else {
    fail('MALFORMED_MSGPACK');
  }
}

export function encodeMsgpack(v: unknown): Uint8Array {
  const out: number[] = [];
  pushValue(out, v, 0);
  return Uint8Array.from(out);
}

export const msgpackCodec: FormatCodec = {
  kind: 'format',
  id: 'msgpack',
  mimes: [
    'application/msgpack',
    'application/x-msgpack',
    'application/vnd.msgpack',
  ],
  detect(sample) {
    const first = sample[0];
    if (first === undefined) return 0;
    // fixmap, fixarray, and the 16- and 32-bit array and map headers. A fixstr (0xa0-0xbf) as a
    // whole document is too common in binary data to be a signal.
    if ((first >= 0x80 && first <= 0x9f) || (first >= 0xdc && first <= 0xdf)) {
      return 0.45;
    }
    return 0;
  },
  decode(bytes, context) {
    const budget = new TreeBudget(context.limits);
    const reader = new Reader(bytes, budget);
    const result = value(reader, 1);
    if (reader.at !== bytes.length) fail('MALFORMED_MSGPACK', reader.at);
    return documentOutput(
      result,
      'msgpack',
      'application/msgpack',
      context.limits,
    );
  },
  encode: encodeMsgpack,
};
