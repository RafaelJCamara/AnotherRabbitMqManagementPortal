import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { decodeValue, encodeValue, hashValue } from './canonical.ts';

const jsonValue = fc.jsonValue();

describe('executor canonical values', () => {
  it('the same value gives the same text whatever the key order', () => {
    expect(encodeValue({ b: 1, a: { d: [1, 2], c: 'x' } })).toBe(
      encodeValue({ a: { c: 'x', d: [1, 2] }, b: 1 }),
    );
    expect(hashValue({ a: 1, b: 2 })).toBe(hashValue({ b: 2, a: 1 }));
  });

  it('different values give different hashes', () => {
    expect(hashValue({ a: 1 })).not.toBe(hashValue({ a: '1' }));
    expect(hashValue([1, 2])).not.toBe(hashValue([2, 1]));
    expect(hashValue({ a: null })).not.toBe(hashValue({}));
  });

  it('property: decode(encode(v)) is v for any JSON value', () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        expect(decodeValue(encodeValue(value))).toEqual(
          JSON.parse(JSON.stringify(value)) as unknown,
        );
      }),
    );
  });

  it('property: encoding is independent of key insertion order', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.integer()), (record) => {
        const reversed = Object.fromEntries(Object.entries(record).reverse());
        expect(encodeValue(reversed)).toBe(encodeValue(record));
      }),
    );
  });

  it('keeps bigint and bytes as themselves, not as strings', () => {
    const value = { n: 2n ** 70n, bytes: Uint8Array.of(0, 255, 7), list: [1n] };

    const back = decodeValue(encodeValue(value)) as typeof value;

    expect(back.n).toBe(2n ** 70n);
    expect(back.bytes).toEqual(Uint8Array.of(0, 255, 7));
    expect(back.bytes).toBeInstanceOf(Uint8Array);
    expect(back.list).toEqual([1n]);
    expect(hashValue({ v: '1' })).not.toBe(hashValue({ v: 1n }));
    expect(hashValue({ v: Uint8Array.of(1) })).not.toBe(hashValue({ v: '' }));
  });

  it('drops undefined members like JSON does, but refuses what JSON would change silently', () => {
    expect(encodeValue({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => encodeValue([undefined])).toThrow(TypeError);
    expect(() => encodeValue(Number.NaN)).toThrow(/NaN/);
    expect(() => encodeValue(Infinity)).toThrow(TypeError);
    expect(() => encodeValue(new Date())).toThrow(TypeError);
    expect(() => encodeValue(new Map())).toThrow(TypeError);
    expect(() => encodeValue(() => 1)).toThrow(TypeError);
    expect(() => encodeValue(Symbol('x'))).toThrow(TypeError);
    expect(() => encodeValue(Object.create({ inherited: 1 }))).toThrow(
      TypeError,
    );
  });

  it('refuses the reserved tag keys, so a payload cannot pose as bytes', () => {
    expect(() => encodeValue({ $bytes: 'AAAA' })).toThrow(/reserved/);
    expect(() => encodeValue({ $bigint: '1' })).toThrow(/reserved/);
  });

  it('refuses a value nested more than 64 deep', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 70; i += 1) deep = [deep];

    expect(() => encodeValue(deep)).toThrow(/nested/);
  });
});
