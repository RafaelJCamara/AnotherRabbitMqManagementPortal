import { describe, expect, it } from 'vitest';

import type { TypedHeaderValue } from '@app/ports';

import { message } from './testing/fake-driver.ts';
import {
  fromTypedHeaders,
  MAX_HEADER_DEPTH,
  toDelivery,
  toDeliveryProperties,
  toTypedHeaders,
} from './headers.ts';

describe('toTypedHeaders (what amqplib decoded)', () => {
  it('types every kind of value amqplib can hand over', () => {
    const typed = toTypedHeaders({
      s: 'text',
      b: true,
      n: null,
      i: 42,
      neg: -7,
      f: 1.5,
      big: 2 ** 40,
      bytes: Buffer.from([1, 2, 3]),
      when: { '!': 'timestamp', value: 1_700_000_000 },
      money: { '!': 'decimal', value: { places: 2, digits: 1999 } },
      list: [1, 'a', [true]],
      table: { inner: 'x' },
    });
    expect(typed.s).toEqual({ t: 'string', v: 'text' });
    expect(typed.b).toEqual({ t: 'bool', v: true });
    expect(typed.n).toEqual({ t: 'void', v: null });
    expect(typed.i).toEqual({ t: 'long', v: 42 });
    expect(typed.neg).toEqual({ t: 'long', v: -7 });
    expect(typed.f).toEqual({ t: 'double', v: 1.5 });
    expect(typed.big).toEqual({ t: 'long', v: 2 ** 40 });
    expect(typed.bytes).toEqual({ t: 'bytes', v: new Uint8Array([1, 2, 3]) });
    expect(typed.when).toEqual({ t: 'timestamp', v: 1_700_000_000 });
    expect(typed.money).toEqual({
      t: 'decimal',
      v: { places: 2, digits: 1999 },
    });
    expect(typed.list).toEqual({
      t: 'array',
      v: [
        { t: 'long', v: 1 },
        { t: 'string', v: 'a' },
        { t: 'array', v: [{ t: 'bool', v: true }] },
      ],
    });
    expect(typed.table).toEqual({
      t: 'table',
      v: { inner: { t: 'string', v: 'inner'.length === 5 ? 'x' : '' } },
    });
  });

  it('absent headers are an empty table', () => {
    expect(Object.keys(toTypedHeaders(undefined))).toEqual([]);
    expect(Object.keys(toTypedHeaders(null))).toEqual([]);
    expect(Object.keys(toTypedHeaders('nope'))).toEqual([]);
  });

  it('copies bytes: the delivery does not alias the read buffer', () => {
    const source = Buffer.from([9, 9]);
    const typed = toTypedHeaders({ b: source });
    source[0] = 0;
    expect((typed.b?.v as Uint8Array)[0]).toBe(9);
  });

  it('a header called __proto__ is an ordinary key and does not touch Object.prototype', () => {
    // amqplib builds the table with `fields[key] = value`, so a __proto__ header replaces the
    // prototype of the decoded table; the adapter reads it back as the header it was.
    const decoded: Record<string, unknown> = {};
    (decoded as { __proto__: unknown }).__proto__ = { polluted: 'yes' };
    decoded.ok = 1;
    const typed = toTypedHeaders(decoded);
    expect(Object.keys(typed).sort()).toEqual(['__proto__', 'ok']);
    expect(typed.__proto__).toEqual({
      t: 'table',
      v: { polluted: { t: 'string', v: 'yes' } },
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(typed)).toBeNull();
  });

  it('cuts nesting off at a fixed depth instead of recursing without end', () => {
    let nested: unknown = 'leaf';
    for (let level = 0; level < MAX_HEADER_DEPTH + 10; level += 1) {
      nested = { next: nested };
    }
    let cursor: TypedHeaderValue | undefined = toTypedHeaders({
      top: nested,
    }).top;
    let depth = 0;
    while (cursor?.t === 'table') {
      cursor = cursor.v.next;
      depth += 1;
    }
    expect(depth).toBeLessThanOrEqual(MAX_HEADER_DEPTH);
    expect(cursor?.t).toBe('string');
    expect(String(cursor?.v)).toContain('nested deeper than');
  });
});

describe('fromTypedHeaders (what a publish sends)', () => {
  it('encodes the type that was asked for', () => {
    const wire = fromTypedHeaders({
      s: { t: 'string', v: 'text' },
      b: { t: 'bool', v: false },
      n: { t: 'void', v: null },
      long: { t: 'long', v: 5 },
      int: { t: 'int', v: -5 },
      short: { t: 'short', v: 300 },
      byte: { t: 'byte', v: 7 },
      d: { t: 'double', v: 0.5 },
      f: { t: 'float', v: 0.25 },
      ts: { t: 'timestamp', v: 1_700_000_000 },
      dec: { t: 'decimal', v: { places: 2, digits: 5 } },
      bytes: { t: 'bytes', v: new Uint8Array([1]) },
      arr: { t: 'array', v: [{ t: 'long', v: 1 }] },
      tbl: { t: 'table', v: { x: { t: 'string', v: 'y' } } },
    });
    expect(wire).toEqual({
      s: 'text',
      b: false,
      n: null,
      long: { '!': 'long', value: 5 },
      int: { '!': 'int', value: -5 },
      short: { '!': 'short', value: 300 },
      byte: { '!': 'byte', value: 7 },
      d: { '!': 'double', value: 0.5 },
      f: { '!': 'float', value: 0.25 },
      ts: { '!': 'timestamp', value: 1_700_000_000 },
      dec: { '!': 'decimal', value: { places: 2, digits: 5 } },
      bytes: Buffer.from([1]),
      arr: [{ '!': 'long', value: 1 }],
      tbl: { x: 'y' },
    });
  });

  it.each([
    ['an untyped value', { a: 1 }],
    ['a null header', { a: null }],
    ['an unknown type', { a: { t: 'blob', v: 'x' } }],
    ['a string that is a number', { a: { t: 'string', v: 1 } }],
    ['a byte out of range', { a: { t: 'byte', v: 200 } }],
    ['a short out of range', { a: { t: 'short', v: 40_000 } }],
    ['an int that is a float', { a: { t: 'int', v: 1.5 } }],
    ['a long that is not a number', { a: { t: 'long', v: 'x' } }],
    ['a negative timestamp', { a: { t: 'timestamp', v: -1 } }],
    ['bytes that are a string', { a: { t: 'bytes', v: 'abc' } }],
    ['an empty header name', { '': { t: 'string', v: 'x' } }],
    [
      'a header name over 255 bytes',
      { ['n'.repeat(256)]: { t: 'string', v: 'x' } },
    ],
  ])('refuses %s', (_name, headers) => {
    expect(() => fromTypedHeaders(headers as never)).toThrow(
      expect.objectContaining({ reason: 'invalid-argument' }) as Error,
    );
  });

  it('refuses nesting beyond the limit', () => {
    let value: TypedHeaderValue = { t: 'string', v: 'leaf' };
    for (let level = 0; level < MAX_HEADER_DEPTH + 5; level += 1) {
      value = { t: 'table', v: { next: value } };
    }
    expect(() => fromTypedHeaders({ top: value })).toThrow(
      expect.objectContaining({ reason: 'invalid-argument' }) as Error,
    );
  });

  it('a header called __proto__ is sent as a header, not as a prototype', () => {
    const headers = Object.create(null) as Record<string, TypedHeaderValue>;
    headers.__proto__ = { t: 'string', v: 'x' };
    const wire = fromTypedHeaders(headers);
    expect(Object.keys(wire)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(wire)).toBeNull();
  });
});

describe('toDelivery', () => {
  it('builds the port delivery: bigint tag, properties without headers, copied body', () => {
    const source = message(12, {
      body: 'abc',
      redelivered: true,
      headers: { h: 'v' },
    });
    const delivery = toDelivery(source, 12n);
    expect(delivery).toMatchObject({
      tag: 12n,
      redelivered: true,
      exchange: '',
      routingKey: 'q',
      properties: { contentType: 'text/plain' },
    });
    expect('headers' in delivery.properties).toBe(false);
    expect(delivery.headers.h).toEqual({ t: 'string', v: 'v' });
    source.content[0] = 0;
    expect(new TextDecoder().decode(delivery.body)).toBe('abc');
  });

  it('leaves out absent properties', () => {
    expect(
      toDeliveryProperties({ contentType: undefined, type: 't', headers: {} }),
    ).toEqual({ type: 't' });
  });
});
