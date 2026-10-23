import { describe, expect, it } from 'vitest';
import {
  matchPolicy,
  MAX_CANDIDATES,
  resolveHypothetical,
  type HypotheticalInput,
  type PolicyDefinition,
} from './hypothetical.ts';
import { entryOf, v } from './testing.ts';

const pol = (
  name: string,
  pattern: string,
  definition: Record<string, unknown>,
  extra: Partial<PolicyDefinition> = {},
): PolicyDefinition => ({
  name,
  pattern,
  applyTo: 'queues',
  priority: 0,
  definition,
  ...extra,
});

const queue = (
  name: string,
  queueType: 'classic' | 'quorum' | 'stream' = 'quorum',
) => ({ kind: 'queue', name, queueType }) as const;

function declare(
  overrides: Partial<HypotheticalInput> = {},
): ReturnType<typeof resolveHypothetical> {
  return resolveHypothetical({
    name: 'orders.q',
    queueType: 'quorum',
    version: v('4.3.6'),
    args: {},
    policies: [],
    operatorPolicies: [],
    ...overrides,
  });
}

describe('M1-01 AC-11 policy matching', () => {
  it('M1-01 AC-11 the highest priority among the matching policies wins, negatives included', () => {
    const low = pol('low', '.*', {}, { priority: -5 });
    const mid = pol('mid', '^orders', {}, { priority: 3 });
    const high = pol('high', 'q$', {}, { priority: 10 });
    const away = pol('away', '^payments', {}, { priority: 99 });

    expect(matchPolicy([low, mid, high, away], queue('orders.q'))).toEqual({
      kind: 'one',
      policy: high,
    });
    expect(matchPolicy([low, mid, away], queue('orders.q'))).toEqual({
      kind: 'one',
      policy: mid,
    });
    expect(matchPolicy([low, away], queue('orders.q'))).toEqual({
      kind: 'one',
      policy: low,
    });
    expect(matchPolicy([away], queue('orders.q'))).toEqual({ kind: 'none' });
    expect(matchPolicy([], queue('orders.q'))).toEqual({ kind: 'none' });
  });

  it('M1-01 AC-11 the pattern is unanchored, like the broker, and an empty pattern matches every name', () => {
    expect(
      matchPolicy([pol('p', 'orders', {})], queue('my-orders-q')).kind,
    ).toBe('one');
    expect(
      matchPolicy([pol('p', '^orders', {})], queue('my-orders-q')).kind,
    ).toBe('none');
    expect(matchPolicy([pol('p', '', {})], queue('anything')).kind).toBe('one');
    expect(
      matchPolicy([pol('p', '^amq\\.', {})], queue('amq.gen-1')).kind,
    ).toBe('one');
    expect(matchPolicy([pol('p', '^amq\\.', {})], queue('amqXgen')).kind).toBe(
      'none',
    );
  });

  it('M1-01 AC-11 apply-to filters by target and queue type', () => {
    const applyTo = (
      value: string,
      target: Parameters<typeof matchPolicy>[1],
    ) => matchPolicy([pol('p', '.*', {}, { applyTo: value })], target).kind;
    const exchange = { kind: 'exchange', name: 'x' } as const;

    expect(applyTo('all', queue('q'))).toBe('one');
    expect(applyTo('all', exchange)).toBe('one');
    expect(applyTo('queues', queue('q', 'stream'))).toBe('one');
    expect(applyTo('queues', exchange)).toBe('none');
    expect(applyTo('exchanges', exchange)).toBe('one');
    expect(applyTo('exchanges', queue('q'))).toBe('none');
    expect(applyTo('classic_queues', queue('q', 'classic'))).toBe('one');
    expect(applyTo('classic_queues', queue('q', 'quorum'))).toBe('none');
    expect(applyTo('quorum_queues', queue('q', 'quorum'))).toBe('one');
    expect(applyTo('quorum_queues', queue('q', 'stream'))).toBe('none');
    expect(applyTo('streams', queue('q', 'stream'))).toBe('one');
    expect(applyTo('streams', queue('q', 'classic'))).toBe('none');
  });

  it('M1-01 AC-11 a tie on the highest priority is ambiguous and says it is a tie; a lower priority policy does not take part', () => {
    const a = pol('a', '.*', {}, { priority: 4 });
    const b = pol('b', 'orders', {}, { priority: 4 });
    const c = pol('c', '.*', {}, { priority: 3 });

    expect(matchPolicy([a, b, c], queue('orders.q'))).toEqual({
      kind: 'ambiguous',
      candidates: [a, b],
      uncertain: [],
      tied: true,
    });
  });

  it('M1-01 AC-11 a pattern outside the subset can still win, so it becomes a candidate; one that cannot outrank the sure match is ignored', () => {
    const sure = pol('sure', 'orders', {}, { priority: 5 });
    const higher = pol('higher', '(?<name>orders)', {}, { priority: 9 });
    const equal = pol('equal', '(?<name>orders)', {}, { priority: 5 });
    const lower = pol('lower', '(?<name>orders)', {}, { priority: 1 });

    expect(matchPolicy([sure, lower], queue('orders.q')).kind).toBe('one');
    const withHigher = matchPolicy([sure, higher], queue('orders.q'));
    expect(withHigher).toMatchObject({
      kind: 'ambiguous',
      candidates: [sure, higher],
      tied: false,
    });
    expect(withHigher.kind === 'ambiguous' && withHigher.uncertain).toEqual([
      {
        policy: 'higher',
        reason: 'the pattern uses a group form outside the supported subset',
      },
    ]);
    expect(matchPolicy([sure, equal], queue('orders.q'))).toMatchObject({
      candidates: [sure, equal],
    });
  });

  it('M1-01 AC-11 two sure matches that tie are reported as a tie even when an uncertain policy is also a candidate', () => {
    const a = pol('a', 'orders', {}, { priority: 5 });
    const b = pol('b', '.*', {}, { priority: 5 });
    const odd = pol('odd', '(?<n>x)', {}, { priority: 7 });

    const match = matchPolicy([a, b, odd], queue('orders.q'));
    expect(match).toMatchObject({ kind: 'ambiguous', tied: true });
    const alone = matchPolicy([a, odd], queue('orders.q'));
    expect(alone).toMatchObject({ kind: 'ambiguous', tied: false });
  });

  it('M1-01 AC-11 with no sure match, an uncertain policy leaves "no policy" as a candidate', () => {
    const odd = pol('odd', '\\Aorders', {}, { priority: 0 });

    expect(matchPolicy([odd], queue('orders.q'))).toEqual({
      kind: 'ambiguous',
      candidates: [null, odd],
      uncertain: [{ policy: 'odd', reason: 'the pattern uses the escape \\A' }],
      tied: false,
    });
  });

  it('M1-01 AC-11 an unknown apply-to value and a priority that is not a number are uncertain, not "no match"', () => {
    const bogus = pol('bogus', '.*', {}, { applyTo: 'topics' });
    const nan = pol('nan', '.*', {}, { priority: Number.NaN });

    const m1 = matchPolicy([bogus], queue('q'));
    const m2 = matchPolicy([nan], queue('q'));
    expect(m1.kind === 'ambiguous' && m1.uncertain[0]?.reason).toBe(
      'apply-to topics is not known',
    );
    expect(m2.kind === 'ambiguous' && m2.uncertain[0]?.reason).toBe(
      'the priority is not a number',
    );
  });

  it('M1-01 AC-11 a name the library cannot evaluate like the broker (non-ASCII, too long) is uncertain, never matched by guess', () => {
    const everything = pol('all', '.*', {});

    expect(matchPolicy([everything], queue('café')).kind).toBe('ambiguous');
    expect(matchPolicy([everything], queue('q'.repeat(256))).kind).toBe(
      'ambiguous',
    );
    expect(matchPolicy([everything], queue('q'.repeat(255))).kind).toBe('one');
  });
});

describe('M1-01 AC-11 hypothetical names', () => {
  it('M1-01 AC-11 what applies if I declare orders.q: the user and operator policy are picked, merged, then the argument is applied', () => {
    const result = declare({
      args: { 'x-max-length': 5000 },
      policies: [
        pol(
          'orders-limits',
          '^orders',
          { 'max-length': 1000 },
          { priority: 2 },
        ),
        pol('everything', '.*', { 'max-length': 10 }, { priority: 1 }),
      ],
      operatorPolicies: [pol('ops-cap', '.*', { 'max-length': 800 })],
    });

    const entry = entryOf(result, 'max-length');
    expect(entry.value).toBe(800);
    expect(entry.mergeRule).toBe('min(user, operator)');
    expect(
      entry.provenance.map((leaf) => `${leaf.layer}:${leaf.name}:${leaf.role}`),
    ).toEqual([
      'argument:x-max-length:compared',
      'user-policy:orders-limits:compared',
      'operator-policy:ops-cap:deciding',
    ]);
    expect(result.userMatch).toEqual({
      status: 'one',
      selected: 'orders-limits',
      candidates: ['orders-limits'],
    });
    expect(result.operatorMatch).toEqual({
      status: 'one',
      selected: 'ops-cap',
      candidates: ['ops-cap'],
    });
    expect(result.warnings).toEqual([]);
  });

  it('M1-01 AC-11 a name no policy matches has only its arguments', () => {
    const result = declare({
      name: 'payments.q',
      args: { 'x-max-length': 5 },
      policies: [pol('orders-limits', '^orders', { 'max-length': 1000 })],
    });

    expect(entryOf(result, 'max-length').value).toBe(5);
    expect(result.userMatch.status).toBe('none');
  });

  it('M1-01 AC-11 a tie keeps the keys on which both policies agree and leaves the others unknown with W-EC-TIE', () => {
    const result = declare({
      policies: [
        pol('a', '.*', { 'max-length': 10, 'message-ttl': 5 }, { priority: 1 }),
        pol('b', '.*', { 'max-length': 20, 'message-ttl': 5 }, { priority: 1 }),
      ],
    });

    const length = entryOf(result, 'max-length');
    expect([length.status, length.value, length.rule]).toEqual([
      'unknown',
      null,
      null,
    ]);
    expect(length.warnings.map((warning) => warning.id)).toEqual(['W-EC-TIE']);
    expect(length.warnings[0]?.params.candidates).toBe('a, b');
    expect(length.provenance.every((leaf) => leaf.role === 'unresolved')).toBe(
      true,
    );
    const ttl = entryOf(result, 'message-ttl');
    expect([ttl.status, ttl.value]).toEqual(['effective', 5]);
    expect(ttl.provenance[0]?.name).toBe('a | b');
    expect(result.userMatch).toEqual({
      status: 'ambiguous',
      selected: null,
      candidates: ['a', 'b'],
    });
    expect(result.warnings.map((warning) => warning.id)).toEqual(['W-EC-TIE']);
    expect(result.mergedPolicy).toEqual({ notEffective: true, entries: {} });
  });

  it('M1-01 AC-11 a tie does not matter when the argument decides whatever the policies say', () => {
    const result = declare({
      queueType: 'classic',
      args: { 'x-dead-letter-exchange': 'dlx.arg' },
      policies: [
        pol('a', '.*', { 'dead-letter-exchange': 'x' }, { priority: 1 }),
        pol('b', '.*', { 'dead-letter-exchange': 'y' }, { priority: 1 }),
      ],
    });

    const entry = entryOf(result, 'dead-letter-exchange');
    expect([entry.status, entry.value]).toEqual(['effective', 'dlx.arg']);
  });

  it('M1-01 AC-11 an uncertain pattern warns with W-EC-PATTERN, and its keys are unknown against "no policy"', () => {
    const result = declare({
      policies: [pol('odd', '(?i)ORDERS', { 'max-length': 10 })],
      args: { 'x-expires': 99 },
    });

    expect(entryOf(result, 'max-length').status).toBe('unknown');
    expect(entryOf(result, 'expires').value).toBe(99);
    expect(result.warnings.map((warning) => warning.id)).toEqual([
      'W-EC-PATTERN',
    ]);
    expect(result.warnings[0]?.params).toMatchObject({ policyName: 'odd' });
    expect(result.userMatch.candidates).toEqual(['odd']);
  });

  it('M1-01 AC-11 an uncertain policy that cannot outrank the sure match changes nothing', () => {
    const result = declare({
      policies: [
        pol('sure', 'orders', { 'max-length': 10 }, { priority: 5 }),
        pol('odd', '(?i)ORDERS', { 'max-length': 99 }, { priority: 1 }),
      ],
    });

    expect(entryOf(result, 'max-length').value).toBe(10);
    expect(result.warnings).toEqual([]);
    expect(result.userMatch.status).toBe('one');
  });

  it('M1-01 AC-11 more candidates than MAX_CANDIDATES: every key any of them sets is unknown, the rest is still answered', () => {
    const many = Array.from({ length: MAX_CANDIDATES + 1 }, (_, index) =>
      pol(
        `p${String(index).padStart(2, '0')}`,
        '.*',
        { 'max-length': 100, 'message-ttl': 7 },
        { priority: 1 },
      ),
    );

    const result = declare({ policies: many, args: { 'x-expires': 3 } });

    // All candidates agree on both keys here, but beyond the cap nothing is compared: unknown.
    expect(entryOf(result, 'max-length').status).toBe('unknown');
    expect(entryOf(result, 'message-ttl').status).toBe('unknown');
    expect(entryOf(result, 'expires').value).toBe(3);
    expect(result.userMatch.candidates).toHaveLength(MAX_CANDIDATES + 1);
  });

  it('M1-01 AC-11 requested keys are answered for every candidate, and an unreadable version stays unknown', () => {
    const asked = declare({ keys: ['delivery-limit'] });
    expect(entryOf(asked, 'delivery-limit').status).toBe('default');
    const blind = declare({
      version: null,
      policies: [pol('p', '.*', { 'max-length': 1 })],
    });
    expect(
      entryOf(blind, 'max-length').warnings.map((warning) => warning.id),
    ).toEqual(['W-EC-VERSION-UNKNOWN']);
  });
});
