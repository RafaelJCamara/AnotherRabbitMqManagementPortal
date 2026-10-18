// Message headers and properties between amqplib's JavaScript values and the port's
// `TypedHeaderValue`.
//
// amqplib decodes a field table into plain values and keeps the AMQP type only for timestamps and
// decimals. Every integer type (byte, short, int, long and their unsigned forms) arrives as a JS
// number, and so do float and double. The port wants a type for each header value, so integers are
// reported as `long` (the type RabbitMQ itself uses for counters such as `x-delivery-count`) and
// the rest as `double`. This is inference, not the wire type (OQ-211). Going the other way
// (`fromTypedHeaders`) encodes exactly the type that was asked for.
import type { Delivery, TypedHeaderValue } from '@app/ports';

import { Amqp091Error } from './errors.ts';
import type { AmqpMessage } from './driver.ts';

/** Nesting deeper than this is cut off on the way in and refused on the way out. */
export const MAX_HEADER_DEPTH = 32;
const TRUNCATED: TypedHeaderValue = {
  t: 'string',
  v: `<nested deeper than ${String(MAX_HEADER_DEPTH)} levels>`,
};

type TypedTable = Record<string, TypedHeaderValue>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** A record that has no prototype, so a header called `__proto__` is a plain own key. */
function emptyTable(): TypedTable {
  return Object.create(null) as TypedTable;
}

function toTypedValue(value: unknown, depth: number): TypedHeaderValue {
  switch (typeof value) {
    case 'string':
      return { t: 'string', v: value };
    case 'boolean':
      return { t: 'bool', v: value };
    case 'number':
      return Number.isInteger(value)
        ? { t: 'long', v: value }
        : { t: 'double', v: value };
    case 'bigint':
      return { t: 'long', v: value };
    default:
      break;
  }
  if (value === null || value === undefined) return { t: 'void', v: null };
  if (depth >= MAX_HEADER_DEPTH) return TRUNCATED;
  if (value instanceof Uint8Array) {
    return { t: 'bytes', v: new Uint8Array(value) };
  }
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return {
      t: 'array',
      v: items.map((item) => toTypedValue(item, depth + 1)),
    };
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    // amqplib's own notation for the two types it keeps: {'!': 'timestamp', value}.
    if (keys.length === 2 && keys.includes('!') && keys.includes('value')) {
      if (value['!'] === 'timestamp' && typeof value.value === 'number') {
        return { t: 'timestamp', v: value.value };
      }
      if (value['!'] === 'decimal' && isObject(value.value)) {
        return { t: 'decimal', v: { ...value.value } };
      }
    }
    return { t: 'table', v: toTypedTable(value, depth + 1) };
  }
  return { t: 'void', v: null };
}

function toTypedTable(
  table: Record<string, unknown>,
  depth: number,
): TypedTable {
  const out = emptyTable();
  for (const key of Object.keys(table)) {
    out[key] = toTypedValue(table[key], depth);
  }
  // amqplib builds a table with `fields[key] = value`; a header named `__proto__` therefore
  // replaced the table's prototype instead of becoming a key. Report it as the header it was.
  const proto: unknown = Object.getPrototypeOf(table);
  if (proto !== null && proto !== Object.prototype && isObject(proto)) {
    out.__proto__ = toTypedValue(proto, depth);
  }
  return out;
}

/** The headers of a delivery, typed. `undefined` (no headers) is an empty table. */
export function toTypedHeaders(
  table: unknown,
): Readonly<Record<string, TypedHeaderValue>> {
  return isObject(table) ? toTypedTable(table, 0) : emptyTable();
}

/** The basic properties of a delivery without `headers`, and without the ones that are absent. */
export function toDeliveryProperties(
  properties: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(properties)) {
    if (key !== 'headers' && properties[key] !== undefined) {
      out[key] = properties[key];
    }
  }
  return out;
}

/**
 * A `Delivery` for the port. The body is copied: the buffers amqplib hands out may be slices of
 * a larger read, and a delivery that is kept (a peek's copy, a tap's frame) must not pin them.
 */
export function toDelivery(message: AmqpMessage, tag: bigint): Delivery {
  return {
    tag,
    redelivered: message.fields.redelivered,
    exchange: message.fields.exchange,
    routingKey: message.fields.routingKey,
    properties: toDeliveryProperties(message.properties),
    headers: toTypedHeaders(message.properties.headers),
    body: new Uint8Array(message.content),
  };
}

function invalid(detail: string): Amqp091Error {
  return new Amqp091Error('invalid-argument', detail);
}

function integerIn(
  value: unknown,
  min: bigint,
  max: bigint,
  type: string,
): number | bigint {
  if (
    (typeof value !== 'number' || !Number.isInteger(value)) &&
    typeof value !== 'bigint'
  ) {
    throw invalid(`a ${type} header needs an integer`);
  }
  if (BigInt(value) < min || BigInt(value) > max) {
    throw invalid(`a ${type} header is out of range`);
  }
  return value;
}

function fromTypedValue(header: TypedHeaderValue, depth: number): unknown {
  if (depth > MAX_HEADER_DEPTH)
    throw invalid('the headers are nested too deep');
  if (!isObject(header) || typeof header.t !== 'string') {
    throw invalid('a header value must be a typed value {t, v}');
  }
  const { v } = header as { v: unknown };
  switch (header.t) {
    case 'string':
      if (typeof v !== 'string')
        throw invalid('a string header needs a string');
      return v;
    case 'bool':
      if (typeof v !== 'boolean')
        throw invalid('a bool header needs a boolean');
      return v;
    case 'void':
      return null;
    case 'byte':
      return {
        '!': 'byte',
        value: integerIn(v, -(2n ** 7n), 2n ** 7n - 1n, 'byte'),
      };
    case 'short':
      return {
        '!': 'short',
        value: integerIn(v, -(2n ** 15n), 2n ** 15n - 1n, 'short'),
      };
    case 'int':
      return {
        '!': 'int',
        value: integerIn(v, -(2n ** 31n), 2n ** 31n - 1n, 'int'),
      };
    case 'long':
      return {
        '!': 'long',
        value: integerIn(v, -(2n ** 63n), 2n ** 63n - 1n, 'long'),
      };
    case 'timestamp':
      return {
        '!': 'timestamp',
        value: integerIn(v, 0n, 2n ** 64n - 1n, 'timestamp'),
      };
    case 'double':
    case 'float':
      if (typeof v !== 'number')
        throw invalid(`a ${header.t} header needs a number`);
      return { '!': header.t, value: v };
    case 'decimal': {
      if (!isObject(v))
        throw invalid('a decimal header needs {places, digits}');
      return { '!': 'decimal', value: { places: v.places, digits: v.digits } };
    }
    case 'bytes':
      if (!(v instanceof Uint8Array)) {
        throw invalid('a bytes header needs a Uint8Array');
      }
      return Buffer.from(v);
    case 'array': {
      if (!Array.isArray(v)) throw invalid('an array header needs an array');
      // Each element is validated by the recursive call.
      const items = v as TypedHeaderValue[];
      return items.map((item) => fromTypedValue(item, depth + 1));
    }
    case 'table':
      if (!isObject(v)) throw invalid('a table header needs a table');
      return fromTypedHeaders(v as Record<string, TypedHeaderValue>, depth + 1);
    default:
      throw invalid('unknown header type');
  }
}

/**
 * Typed headers in the form amqplib encodes, with the AMQP type that was asked for. Anything that
 * is not a well-formed typed value is refused (`invalid-argument`), so a publisher cannot smuggle
 * a raw value or a type amqplib would guess at.
 */
export function fromTypedHeaders(
  headers: Readonly<Record<string, TypedHeaderValue>>,
  depth = 0,
): Record<string, unknown> {
  if (depth > MAX_HEADER_DEPTH)
    throw invalid('the headers are nested too deep');
  if (!isObject(headers)) throw invalid('headers must be a table');
  const out = emptyTable() as Record<string, unknown>;
  for (const key of Object.keys(headers)) {
    if (key.length === 0 || Buffer.byteLength(key) > 255) {
      throw invalid('a header name must be 1 to 255 bytes');
    }
    const header = headers[key];
    if (header === undefined) continue;
    out[key] = fromTypedValue(header, depth);
  }
  return out;
}
