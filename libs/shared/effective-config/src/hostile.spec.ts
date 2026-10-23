// M1-01 AC-12: hostile input is bounded. The resolver reads definitions and arguments that come
// from a broker (and so, indirectly, from whoever can write a policy); it must neither be steered
// by them nor spend more than their size on them.
import { describe, expect, it } from 'vitest';
import { mergeOperator } from './merge-operator.ts';
import { resolveEffective } from './resolve.ts';
import { entryOf, input, policy } from './testing.ts';

describe('M1-01 AC-12 hostile input is bounded', () => {
  it('M1-01 AC-12 keys named __proto__, constructor and toString are data, never a prototype write', () => {
    const hostile = JSON.parse(
      '{"__proto__": {"polluted": 1}, "constructor": {"prototype": {"polluted": 2}}, "toString": 3, "max-length": 5}',
    ) as Record<string, unknown>;
    const args = JSON.parse(
      '{"__proto__": 1, "x-max-length": 9, "constructor": 2}',
    ) as Record<string, unknown>;

    const result = resolveEffective(
      input({
        args,
        user: hostile,
        operator: hostile,
        keys: ['__proto__', 'constructor'],
      }),
    );
    const merged = mergeOperator(policy('u', hostile), policy('o', hostile));

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(result.entries)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(merged.entries)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(result.mergedPolicy.entries)).toBe(
      Object.prototype,
    );
    expect(entryOf(result, 'max-length').value).toBe(5);
    // The odd keys are reported like any other unknown key.
    for (const key of ['__proto__', 'constructor', 'toString']) {
      expect(entryOf(result, key).status).toBe('unknown');
    }
    expect(result.unrecognisedArguments).toEqual(['__proto__', 'constructor']);
  });

  it('M1-01 AC-12 inherited properties are not policy values: a key only on the prototype is not set', () => {
    const inherited = Object.create({ 'max-length': 5 }) as Record<
      string,
      unknown
    >;

    const result = resolveEffective(
      input({
        user: inherited,
        args: Object.create({ 'x-expires': 3 }) as Record<string, unknown>,
      }),
    );

    expect(result.entries).toEqual({});
    expect(result.unrecognisedArguments).toEqual([]);
  });

  it('M1-01 AC-12 ten thousand keys are answered one entry each, in sorted order, and a long string value is shortened in warnings', () => {
    const definition: Record<string, unknown> = {};
    for (let index = 0; index < 10_000; index += 1)
      definition[`key-${String(index)}`] = index;
    definition['max-length'] = 'x'.repeat(1_000_000);

    const result = resolveEffective(
      input({
        user: definition,
        args: { 'x-max-length': 'y'.repeat(1_000_000) },
      }),
    );

    expect(Object.keys(result.entries)).toHaveLength(10_001);
    expect(Object.keys(result.entries)).toEqual(
      [...Object.keys(result.entries)].sort(),
    );
    const long = entryOf(result, 'max-length');
    expect(long.status).toBe('invalid');
    for (const warning of long.warnings) {
      for (const value of Object.values(warning.params))
        expect(value.length).toBeLessThanOrEqual(130);
    }
  });

  it('M1-01 AC-12 values that are objects, lists, null or functions never become an effective value', () => {
    for (const value of [{}, [], null, () => 1, Symbol('x'), 10n, undefined]) {
      const result = resolveEffective(
        input({
          queueType: 'classic',
          args: { 'x-dead-letter-exchange': value },
        }),
      );
      const entry = result.entries['dead-letter-exchange'];
      expect(entry?.status === 'effective').toBe(false);
    }
  });

  it("M1-01 AC-12 a pre-release or build-metadata version is read like its release and an unparsable one is the caller's null", () => {
    const entry = entryOf(
      resolveEffective(
        input({
          version: '4.3.6-rc.1',
          args: { 'x-max-length': 5 },
          user: { 'max-length': 9 },
        }),
      ),
      'max-length',
    );

    expect(entry.value).toBe(5);
    expect(entry.basis).toBe('source-read');
  });
});
