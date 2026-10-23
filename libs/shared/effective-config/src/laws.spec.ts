// M1-01 AC-10: the merge and precedence laws, as properties over arbitrary values. The oracle is
// the rule in words (fact sheet k.3), not the implementation: a limit is the smaller of two, a
// negative delivery limit means "no limit", an argument that wins ignores the policy.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { combine, mergeOperator } from './merge-operator.ts';
import { resolveEffective } from './resolve.ts';
import { deepFreeze, entryOf, input, policy } from './testing.ts';

const num = fc.integer({ min: -1_000_000, max: 1_000_000 });
const nonNegative = fc.integer({ min: 0, max: 1_000_000 });

const MIN_KEYS = [
  'max-length',
  'max-length-bytes',
  'message-ttl',
  'expires',
] as const;
const minKey = fc.constantFrom(...MIN_KEYS);

describe('M1-01 AC-10 merge and precedence laws', () => {
  it('M1-01 AC-10 min, max and the negative rule are commutative, associative and idempotent', () => {
    for (const kind of ['min', 'max', 'negative-rule'] as const) {
      fc.assert(
        fc.property(num, num, num, (a, b, c) => {
          expect(combine(kind, a, b)).toBe(combine(kind, b, a));
          expect(combine(kind, combine(kind, a, b), c)).toBe(
            combine(kind, a, combine(kind, b, c)),
          );
          expect(combine(kind, a, a)).toBe(a);
        }),
      );
    }
  });

  it('M1-01 AC-10 the negative rule: a negative limit means "no limit", so a finite limit beats it and two finite ones give the smaller', () => {
    fc.assert(
      fc.property(num, num, (a, b) => {
        const result = combine('negative-rule', a, b);
        expect([a, b]).toContain(result);
        if (a >= 0 && b >= 0) expect(result).toBe(Math.min(a, b));
        if (a < 0 && b >= 0) expect(result).toBe(b);
        if (a < 0 && b < 0) expect(result).toBe(Math.max(a, b));
      }),
    );
  });

  it('M1-01 AC-10 a limit key never exceeds either input and is one of them', () => {
    fc.assert(
      fc.property(minKey, num, num, num, (key, arg, user, operator) => {
        const merged = mergeOperator(
          policy('u', { [key]: user }),
          policy('o', { [key]: operator }),
        );
        const value = merged.entries[key];
        expect(value).toEqual({
          status: 'value',
          value: Math.min(user, operator),
          rule: 'min(user, operator)',
        });

        const entry = entryOf(
          resolveEffective(
            input({
              args: { [`x-${key}`]: arg },
              user: { [key]: user },
              operator: { [key]: operator },
            }),
          ),
          key,
        );
        expect(entry.value).toBe(Math.min(arg, user, operator));
      }),
    );
  });

  it('M1-01 AC-10 swapping the user and operator policy does not change a limit key', () => {
    fc.assert(
      fc.property(minKey, num, num, (key, a, b) => {
        const forward = mergeOperator(
          policy('u', { [key]: a }),
          policy('o', { [key]: b }),
        );
        const backward = mergeOperator(
          policy('u', { [key]: b }),
          policy('o', { [key]: a }),
        );
        expect(forward.entries[key]).toEqual(backward.entries[key]);
      }),
    );
  });

  it('M1-01 AC-10 a limit key is monotone: a larger policy never gives a smaller result', () => {
    fc.assert(
      fc.property(minKey, num, num, num, (key, arg, p1, p2) => {
        const [low, high] = p1 <= p2 ? [p1, p2] : [p2, p1];
        const at = (policyValue: number) =>
          entryOf(
            resolveEffective(
              input({
                args: { [`x-${key}`]: arg },
                user: { [key]: policyValue },
              }),
            ),
            key,
          ).value as number;
        expect(at(low)).toBeLessThanOrEqual(at(high));
      }),
    );
  });

  it('M1-01 AC-10 merging with an empty side is the identity: the other policy comes through unchanged', () => {
    const definition = fc.dictionary(
      fc.constantFrom(
        'max-length',
        'message-ttl',
        'overflow',
        'delivery-limit',
        'some-flag',
        'ha-params',
      ),
      fc.oneof(num, fc.string(), fc.boolean()),
    );
    fc.assert(
      fc.property(definition, (def) => {
        const asUser = mergeOperator(policy('u', def), null);
        const asOperator = mergeOperator(null, policy('o', def));
        const emptyOther = mergeOperator(policy('u', def), policy('o', {}));
        const expected = Object.fromEntries(
          Object.entries(def).map(([k, value]) => [
            k,
            { status: 'value', value, rule: null },
          ]),
        );
        expect(asUser.entries).toEqual(expected);
        expect(asOperator.entries).toEqual(expected);
        expect(emptyOther.entries).toEqual(expected);
      }),
    );
  });

  it('M1-01 AC-10 an argument that wins ignores the policy, and a policy that wins ignores the argument', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        fc.string(),
        (arg, user, operator) => {
          // classic dead-letter-exchange: the argument wins whatever the policies say.
          const classic = entryOf(
            resolveEffective(
              input({
                queueType: 'classic',
                args: { 'x-dead-letter-exchange': arg },
                user: { 'dead-letter-exchange': user },
                operator: { 'dead-letter-exchange': operator },
              }),
            ),
            'dead-letter-exchange',
          );
          expect(classic.value).toBe(arg);
          // quorum overflow: the policy wins whatever the argument says.
          const quorum = entryOf(
            resolveEffective(
              input({ args: { 'x-overflow': arg }, user: { overflow: user } }),
            ),
            'overflow',
          );
          expect(quorum.value).toBe(user);
          const withOperator = entryOf(
            resolveEffective(
              input({
                args: { 'x-overflow': arg },
                user: { overflow: user },
                operator: { overflow: operator },
              }),
            ),
            'overflow',
          );
          expect(withOperator.value).toBe(operator);
        },
      ),
    );
  });

  it('M1-01 AC-10 the delivery limit: a finite policy bounds a finite argument, and a negative one defers to it', () => {
    fc.assert(
      fc.property(
        nonNegative,
        nonNegative,
        fc.integer({ min: -100, max: -1 }),
        (arg, policyLimit, negative) => {
          const limit = (a: number, p: number) =>
            entryOf(
              resolveEffective(
                input({
                  args: { 'x-delivery-limit': a },
                  user: { 'delivery-limit': p },
                }),
              ),
              'delivery-limit',
            ).value;
          expect(limit(arg, policyLimit)).toBe(Math.min(arg, policyLimit));
          expect(limit(negative, policyLimit)).toBe(policyLimit);
          expect(limit(arg, negative)).toBe(arg);
        },
      ),
    );
  });

  it('M1-01 AC-10 the result does not depend on the order of keys in the inputs', () => {
    const pairs = fc.uniqueArray(fc.tuple(minKey, num), {
      selector: ([key]) => key,
      minLength: 1,
    });
    fc.assert(
      fc.property(pairs, pairs, (argPairs, policyPairs) => {
        const build = (
          list: readonly (readonly [string, number])[],
          prefix: string,
        ) =>
          Object.fromEntries(
            list.map(([key, value]) => [`${prefix}${key}`, value]),
          );
        const forward = resolveEffective(
          input({ args: build(argPairs, 'x-'), user: build(policyPairs, '') }),
        );
        const backward = resolveEffective(
          input({
            args: build([...argPairs].reverse(), 'x-'),
            user: build([...policyPairs].reverse(), ''),
          }),
        );
        expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
      }),
    );
  });

  it('M1-01 AC-10 inputs are never mutated, and a deeply frozen input gives the same answer', () => {
    fc.assert(
      fc.property(minKey, num, num, num, (key, arg, user, operator) => {
        const make = () =>
          input({
            args: { [`x-${key}`]: arg },
            user: { [key]: user },
            operator: { [key]: operator },
          });
        const plain = resolveEffective(make());
        const frozen = resolveEffective(deepFreeze(make()));
        expect(frozen).toEqual(plain);
      }),
    );
  });

  it('M1-01 AC-10 totality: arbitrary junk never throws, and a decided entry always has a deciding input', () => {
    const keyName = fc.constantFrom(
      'max-length',
      'expires',
      'overflow',
      'delivery-limit',
      'dead-letter-exchange',
      'delayed-retry-min',
      'delayed-retry-type',
      'ha-mode',
      '__proto__',
      'constructor',
      'toString',
    );
    const junk = fc.anything();
    const definition = fc
      .array(fc.tuple(keyName, junk), { maxLength: 6 })
      .map((list) => Object.fromEntries(list));
    const args = fc
      .array(
        fc.tuple(
          fc.oneof(
            keyName.map((key) => `x-${key}`),
            fc.string(),
          ),
          junk,
        ),
        { maxLength: 6 },
      )
      .map((list) => Object.fromEntries(list));
    const queueType = fc.constantFrom('classic', 'quorum', 'stream');
    const version = fc.constantFrom(
      '3.13.7',
      '4.0.8',
      '4.3.0',
      '4.3.6',
      '4.4.0',
      null,
    );

    fc.assert(
      fc.property(
        queueType,
        version,
        args,
        definition,
        definition,
        (type, ver, a, u, o) => {
          const result = resolveEffective(
            input({
              queueType: type,
              version: ver,
              args: a,
              user: u,
              operator: o,
            }),
          );
          for (const entry of Object.values(result.entries)) {
            if (entry.status === 'effective') {
              expect(entry.value).not.toBeNull();
              expect(
                entry.provenance.some(
                  (leaf) =>
                    leaf.role === 'deciding' && leaf.value === entry.value,
                ),
              ).toBe(true);
            } else if (
              entry.status === 'unknown' ||
              entry.status === 'invalid'
            ) {
              expect(entry.value).toBeNull();
              expect(entry.rule).toBeNull();
              expect(
                entry.provenance.every((leaf) => leaf.role === 'unresolved'),
              ).toBe(true);
              expect(entry.warnings.length).toBeGreaterThan(0);
            }
            expect(JSON.stringify(entry)).not.toContain(
              'effective_policy_definition',
            );
          }
          expect(result.mergedPolicy.notEffective).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});
