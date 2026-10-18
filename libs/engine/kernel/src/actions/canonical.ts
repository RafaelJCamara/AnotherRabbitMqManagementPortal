// Canonical JSON for hashing and storing plan data (M0-29). Two properties matter:
//
//   - the same value always gives the same text (object keys are sorted), so a hash over it is a
//     stable digest;
//   - values JSON cannot carry (bigint, bytes) are tagged, not silently turned into strings or
//     lost, and `decodeValue` restores them.
//
// Anything else JSON would change without saying so (NaN, Infinity, undefined in an array, a Date,
// a class instance, a function) is refused with a TypeError instead.
import { createHash } from 'node:crypto';

const MAX_DEPTH = 64;
const BIGINT_TAG = '$bigint';
const BYTES_TAG = '$bytes';

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function write(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new TypeError('The value is nested too deeply.');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('NaN and Infinity cannot be stored.');
      }
      return JSON.stringify(value);
    case 'bigint':
      return `{"${BIGINT_TAG}":${JSON.stringify(value.toString())}}`;
    case 'object':
      break;
    default:
      throw new TypeError(`A ${typeof value} cannot be stored.`);
  }
  if (value instanceof Uint8Array) {
    const base64 = Buffer.from(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    ).toString('base64');
    return `{"${BYTES_TAG}":${JSON.stringify(base64)}}`;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return `[${items.map((item) => write(item, depth + 1)).join(',')}]`;
  }
  if (!isPlainObject(value)) {
    throw new TypeError('Only plain objects and arrays can be stored.');
  }
  const members: string[] = [];
  for (const key of Object.keys(value).sort()) {
    if (key === BIGINT_TAG || key === BYTES_TAG) {
      throw new TypeError(`The key ${key} is reserved.`);
    }
    const member = value[key];
    if (member === undefined) continue;
    members.push(`${JSON.stringify(key)}:${write(member, depth + 1)}`);
  }
  return `{${members.join(',')}}`;
}

/** Canonical JSON text of `value`; throws `TypeError` for what cannot be stored faithfully. */
export function encodeValue(value: unknown): string {
  return write(value, 0);
}

function revive(_key: string, value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const [only] = entries;
  if (entries.length !== 1 || only === undefined) return value;
  const [tag, payload] = only;
  if (typeof payload !== 'string') return value;
  if (tag === BIGINT_TAG) return BigInt(payload);
  if (tag === BYTES_TAG) return new Uint8Array(Buffer.from(payload, 'base64'));
  return value;
}

/** The inverse of `encodeValue`. */
export function decodeValue(text: string): unknown {
  return JSON.parse(text, revive) as unknown;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** sha256 of the canonical JSON of `value`. */
export function hashValue(value: unknown): string {
  return sha256Hex(encodeValue(value));
}
