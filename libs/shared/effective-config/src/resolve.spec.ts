import type { QueueType } from '@app/domain-model';
import { semanticsRegistry } from '@app/semantics';
import { describe, expect, it } from 'vitest';
import { parseResolveInput } from './model.ts';
import { resolveEffective } from './resolve.ts';
import { entryOf, input, v } from './testing.ts';

/** The {{name}} values every resolver warning carries (the texts use a subset). */
const STANDARD_PARAMS = [
  'argument',
  'argumentValue',
  'key',
  'operatorValue',
  'policyName',
  'policyValue',
  'queueType',
  'reason',
  'rule',
  'userValue',
  'value',
  'version',
];

describe('M1-01 AC-1 min of argument and policy, with provenance', () => {
  it('M1-01 AC-1 a 4.0.8 quorum queue with x-max-length 500 and a policy max-length 1000 is 500, min(arg, policy)', () => {
    const result = resolveEffective(
      input({
        version: '4.0.8',
        args: { 'x-max-length': 500 },
        user: { 'max-length': 1000 },
      }),
    );

    expect(entryOf(result, 'max-length')).toEqual({
      key: 'max-length',
      argument: 'x-max-length',
      status: 'effective',
      value: 500,
      rule: 'min(arg, policy)',
      mergeRule: null,
      basis: 'extrapolated',
      provenance: [
        {
          layer: 'argument',
          name: 'x-max-length',
          value: 500,
          role: 'deciding',
        },
        {
          layer: 'user-policy',
          name: 'user-policy',
          value: 1000,
          role: 'compared',
        },
      ],
      warnings: [],
    });
  });

  it('M1-01 AC-1 the policy is the smaller: 1000 against an argument of 2000 gives 1000, the policy deciding', () => {
    const result = resolveEffective(
      input({
        version: '4.0.8',
        args: { 'x-max-length': 2000 },
        user: { 'max-length': 1000 },
      }),
    );

    const entry = entryOf(result, 'max-length');
    expect(entry.value).toBe(1000);
    expect(entry.rule).toBe('min(arg, policy)');
    expect(entry.provenance.map((leaf) => leaf.role)).toEqual([
      'compared',
      'deciding',
    ]);
  });

  it('M1-01 AC-1 equal values: both inputs decide', () => {
    const entry = entryOf(
      resolveEffective(
        input({ args: { 'x-max-length': 700 }, user: { 'max-length': 700 } }),
      ),
      'max-length',
    );

    expect(entry.value).toBe(700);
    expect(entry.provenance.map((leaf) => leaf.role)).toEqual([
      'deciding',
      'deciding',
    ]);
  });

  it('M1-01 AC-1 an operator policy merges first: operator 800 and user 1000 give a merged 800, then the argument 500 wins', () => {
    const entry = entryOf(
      resolveEffective(
        input({
          args: { 'x-max-length': 500 },
          user: { 'max-length': 1000 },
          operator: { 'max-length': 800 },
        }),
      ),
      'max-length',
    );

    expect(entry.value).toBe(500);
    expect(entry.rule).toBe('min(arg, policy)');
    expect(entry.mergeRule).toBe('min(user, operator)');
    expect(entry.provenance).toEqual([
      { layer: 'argument', name: 'x-max-length', value: 500, role: 'deciding' },
      {
        layer: 'user-policy',
        name: 'user-policy',
        value: 1000,
        role: 'compared',
      },
      {
        layer: 'operator-policy',
        name: 'operator-policy',
        value: 800,
        role: 'compared',
      },
    ]);
  });

  it('M1-01 AC-1 with an argument of 2000 the operator value 800 decides through the merge', () => {
    const entry = entryOf(
      resolveEffective(
        input({
          args: { 'x-max-length': 2000 },
          user: { 'max-length': 1000 },
          operator: { 'max-length': 800 },
        }),
      ),
      'max-length',
    );

    expect(entry.value).toBe(800);
    expect(
      entry.provenance.map((leaf) => `${leaf.layer}:${leaf.role}`),
    ).toEqual([
      'argument:compared',
      'user-policy:compared',
      'operator-policy:deciding',
    ]);
  });

  it('M1-01 AC-1 a single source is used as it is: the argument alone, the policy alone', () => {
    const argOnly = entryOf(
      resolveEffective(input({ args: { 'x-max-length': 500 } })),
      'max-length',
    );
    const policyOnly = entryOf(
      resolveEffective(input({ user: { 'max-length': 1000 } })),
      'max-length',
    );

    expect([argOnly.value, argOnly.rule]).toEqual([500, 'arg']);
    expect([policyOnly.value, policyOnly.rule]).toEqual([1000, 'policy']);
    expect(policyOnly.argument).toBe('x-max-length');
  });
});

describe('M1-01 AC-2 3.13 expires: the policy wins', () => {
  const args = { 'x-expires': 60000 };
  const user = { expires: 120000 };

  it('M1-01 AC-2 a 3.13 quorum queue with x-expires 60000 and a policy of 120000 is 120000, the policy deciding', () => {
    const entry = entryOf(
      resolveEffective(input({ version: '3.13.7', args, user })),
      'expires',
    );

    expect(entry.status).toBe('effective');
    expect(entry.value).toBe(120000);
    expect(entry.rule).toBe('policy');
    expect(entry.basis).toBe('source-read');
    expect(
      entry.provenance.map((leaf) => `${leaf.layer}:${leaf.role}`),
    ).toEqual(['argument:overridden', 'user-policy:deciding']);
    expect(entry.warnings.map((warning) => warning.id)).toEqual([
      'W-EC-POLICY-WINS-313',
    ]);
    expect(entry.warnings[0]?.params).toMatchObject({
      argumentValue: '60000',
      policyValue: '120000',
    });
    expect(entry.warnings[0]?.citations.length).toBeGreaterThan(0);
  });

  it('M1-01 AC-2 the same queue on 4.0.8 gives 60000, min(arg, policy), and no warning', () => {
    const entry = entryOf(
      resolveEffective(input({ version: '4.0.8', args, user })),
      'expires',
    );

    expect(entry.value).toBe(60000);
    expect(entry.rule).toBe('min(arg, policy)');
    expect(entry.warnings).toEqual([]);
  });

  it('M1-01 AC-2 on 3.13 the argument alone still counts', () => {
    const entry = entryOf(
      resolveEffective(input({ version: '3.13.7', args })),
      'expires',
    );

    expect([entry.value, entry.rule, entry.warnings]).toEqual([
      60000,
      'arg',
      [],
    ]);
  });
});

describe('M1-01 AC-3 delivery-limit through the resolver', () => {
  const limit = (scenario: Parameters<typeof input>[0]) =>
    entryOf(resolveEffective(input(scenario)), 'delivery-limit');

  it('M1-01 AC-3 user -1 and operator 50 merge to 50 and the entry says how', () => {
    const entry = limit({
      user: { 'delivery-limit': -1 },
      operator: { 'delivery-limit': 50 },
    });

    expect(entry.value).toBe(50);
    expect(entry.rule).toBe('policy');
    expect(entry.mergeRule).toBe('negative-rule(user, operator)');
  });

  it('M1-01 AC-3 the argument meets the merged value by the same rule', () => {
    const policy = { 'delivery-limit': 3 };
    expect(limit({ args: { 'x-delivery-limit': 5 }, user: policy }).value).toBe(
      3,
    );
    expect(
      limit({ args: { 'x-delivery-limit': -1 }, user: policy }).value,
    ).toBe(3);
    expect(
      limit({ args: { 'x-delivery-limit': 5 }, user: { 'delivery-limit': -1 } })
        .value,
    ).toBe(5);
    expect(
      limit({
        args: { 'x-delivery-limit': -1 },
        user: { 'delivery-limit': -1 },
      }).value,
    ).toBe(-1);
    expect(limit({ args: { 'x-delivery-limit': 2 }, user: policy }).rule).toBe(
      'negative-rule(arg, policy)',
    );
  });
});

describe('M1-01 AC-4 effective_policy_definition is never effective', () => {
  it('M1-01 AC-4 the argument beats the policy, and the merged policy is marked notEffective and differs from the effective value', () => {
    const result = resolveEffective(
      input({
        queueType: 'classic',
        args: { 'x-dead-letter-exchange': 'dlx.arg' },
        user: { 'dead-letter-exchange': 'dlx.policy' },
      }),
    );

    const entry = entryOf(result, 'dead-letter-exchange');
    expect(entry.value).toBe('dlx.arg');
    expect(entry.rule).toBe('arg');
    expect(result.mergedPolicy.notEffective).toBe(true);
    expect(result.mergedPolicy.entries['dead-letter-exchange']).toEqual({
      status: 'value',
      value: 'dlx.policy',
      rule: null,
    });
    expect(
      entry.provenance.map((leaf) => `${leaf.layer}:${leaf.role}`),
    ).toEqual(['argument:deciding', 'user-policy:overridden']);
  });

  it('M1-01 AC-4 the result never has an effective_policy_definition anywhere', () => {
    const result = resolveEffective(
      input({
        args: { 'x-max-length': 5 },
        user: { 'max-length': 9 },
        operator: { 'max-length': 7 },
      }),
    );

    expect(JSON.stringify(result)).not.toContain('effective_policy_definition');
    expect(Object.keys(result).sort()).toEqual([
      'entries',
      'mergedPolicy',
      'queueType',
      'unrecognisedArguments',
      'version',
      'warnings',
    ]);
  });

  it('M1-01 AC-4 the input schema rejects the management API field, at the top level and inside a policy', () => {
    const base = {
      queueType: 'quorum',
      version: v('4.3.6'),
      args: {},
      userPolicy: null,
      operatorPolicy: null,
    };

    expect(parseResolveInput(base).ok).toBe(true);
    const top = parseResolveInput({
      ...base,
      effective_policy_definition: { 'max-length': 5 },
    });
    expect(top.ok).toBe(false);
    expect(top.ok ? [] : top.problems.join()).toContain(
      'effective_policy_definition',
    );
    const nested = parseResolveInput({
      ...base,
      userPolicy: {
        name: 'p',
        definition: {},
        effective_policy_definition: {},
      },
    });
    expect(nested.ok).toBe(false);
  });
});

describe('M1-01 AC-6 k.3 table by queue type and era', () => {
  interface Row {
    readonly queueType: QueueType;
    readonly version: string;
    readonly key: string;
    readonly arg?: unknown;
    readonly policy?: unknown;
    readonly value: unknown;
    readonly rule: string | null;
    readonly status?: string;
  }

  const rows: readonly Row[] = [
    // Classic: the smaller of the two for the limits.
    {
      queueType: 'classic',
      version: '4.3.6',
      key: 'expires',
      arg: 100,
      policy: 200,
      value: 100,
      rule: 'min(arg, policy)',
    },
    {
      queueType: 'classic',
      version: '4.3.6',
      key: 'expires',
      arg: 300,
      policy: 200,
      value: 200,
      rule: 'min(arg, policy)',
    },
    {
      queueType: 'classic',
      version: '4.3.6',
      key: 'message-ttl',
      arg: 10,
      policy: 20,
      value: 10,
      rule: 'min(arg, policy)',
    },
    {
      queueType: 'classic',
      version: '4.3.6',
      key: 'max-length',
      arg: 10,
      policy: 20,
      value: 10,
      rule: 'min(arg, policy)',
    },
    {
      queueType: 'classic',
      version: '4.3.6',
      key: 'max-length-bytes',
      arg: 30,
      policy: 20,
      value: 20,
      rule: 'min(arg, policy)',
    },
    {
      queueType: 'classic',
      version: '3.13.7',
      key: 'message-ttl',
      arg: 30,
      policy: 20,
      value: 20,
      rule: 'min(arg, policy)',
    },
    {
      queueType: 'classic',
      version: '4.1.8',
      key: 'max-length',
      arg: 30,
      policy: 20,
      value: 20,
      rule: 'min(arg, policy)',
    },
    // Classic: the argument wins for the dead-letter keys and overflow.
    {
      queueType: 'classic',
      version: '4.3.6',
      key: 'dead-letter-exchange',
      arg: 'a',
      policy: 'p',
      value: 'a',
      rule: 'arg',
    },
    {
      queueType: 'classic',
      version: '4.3.6',
      key: 'dead-letter-routing-key',
      arg: 'a',
      policy: 'p',
      value: 'a',
      rule: 'arg',
    },
    {
      queueType: 'classic',
      version: '4.3.6',
      key: 'overflow',
      arg: 'reject-publish',
      policy: 'drop-head',
      value: 'reject-publish',
      rule: 'arg',
    },
    {
      queueType: 'classic',
      version: '4.3.6',
      key: 'overflow',
      policy: 'drop-head',
      value: 'drop-head',
      rule: 'policy',
    },
    // Quorum: the smaller of the two.
    {
      queueType: 'quorum',
      version: '4.3.6',
      key: 'max-length',
      arg: 10,
      policy: 20,
      value: 10,
      rule: 'min(arg, policy)',
    },
    {
      queueType: 'quorum',
      version: '4.3.6',
      key: 'max-length-bytes',
      arg: 30,
      policy: 20,
      value: 20,
      rule: 'min(arg, policy)',
    },
    {
      queueType: 'quorum',
      version: '4.3.6',
      key: 'message-ttl',
      arg: 30,
      policy: 20,
      value: 20,
      rule: 'min(arg, policy)',
    },
    {
      queueType: 'quorum',
      version: '4.2.9',
      key: 'expires',
      arg: 30,
      policy: 20,
      value: 20,
      rule: 'min(arg, policy)',
    },
    {
      queueType: 'quorum',
      version: '4.3.6',
      key: 'consumer-disconnected-timeout',
      arg: 30,
      policy: 20,
      value: 20,
      rule: 'min(arg, policy)',
    },
    {
      queueType: 'quorum',
      version: '4.3.6',
      key: 'delivery-limit',
      arg: 5,
      policy: 3,
      value: 3,
      rule: 'negative-rule(arg, policy)',
    },
    // Quorum: the argument wins.
    {
      queueType: 'quorum',
      version: '4.3.6',
      key: 'dead-letter-exchange',
      arg: 'a',
      policy: 'p',
      value: 'a',
      rule: 'arg',
    },
    {
      queueType: 'quorum',
      version: '4.3.6',
      key: 'dead-letter-routing-key',
      arg: 'a',
      policy: 'p',
      value: 'a',
      rule: 'arg',
    },
    {
      queueType: 'quorum',
      version: '4.3.6',
      key: 'dead-letter-strategy',
      arg: 'at-least-once',
      policy: 'at-most-once',
      value: 'at-least-once',
      rule: 'arg',
    },
    // Quorum: the policy wins.
    {
      queueType: 'quorum',
      version: '4.3.6',
      key: 'overflow',
      arg: 'drop-head',
      policy: 'reject-publish',
      value: 'reject-publish',
      rule: 'policy',
    },
    {
      queueType: 'quorum',
      version: '4.3.6',
      key: 'delayed-retry-type',
      arg: 'all',
      policy: 'failed',
      value: 'failed',
      rule: 'policy',
    },
    // Delayed retry before the policy keys exist (4.3.0): the argument only.
    {
      queueType: 'quorum',
      version: '4.3.0',
      key: 'delayed-retry-type',
      arg: 'all',
      policy: 'failed',
      value: 'all',
      rule: 'arg',
    },
    {
      queueType: 'quorum',
      version: '4.3.0',
      key: 'delayed-retry-type',
      policy: 'failed',
      value: null,
      rule: null,
      status: 'unset',
    },
    // Delayed retry does not exist before 4.3.0.
    {
      queueType: 'quorum',
      version: '4.2.9',
      key: 'delayed-retry-type',
      arg: 'all',
      value: null,
      rule: null,
      status: 'unset',
    },
    // Streams: the policy wins for the retention and segment keys and initial-cluster-size.
    {
      queueType: 'stream',
      version: '4.3.6',
      key: 'max-length-bytes',
      arg: 100,
      policy: 900,
      value: 900,
      rule: 'policy',
    },
    {
      queueType: 'stream',
      version: '4.3.6',
      key: 'max-age',
      arg: '7D',
      policy: '1D',
      value: '1D',
      rule: 'policy',
    },
    {
      queueType: 'stream',
      version: '4.3.6',
      key: 'stream-max-segment-size-bytes',
      arg: 1,
      policy: 2,
      value: 2,
      rule: 'policy',
    },
    {
      queueType: 'stream',
      version: '4.3.6',
      key: 'stream-filter-size-bytes',
      arg: 16,
      policy: 32,
      value: 32,
      rule: 'policy',
    },
    {
      queueType: 'stream',
      version: '4.3.6',
      key: 'initial-cluster-size',
      arg: 1,
      policy: 3,
      value: 3,
      rule: 'policy',
    },
    {
      queueType: 'stream',
      version: '4.3.6',
      key: 'max-age',
      arg: '7D',
      value: '7D',
      rule: 'arg',
    },
  ];

  for (const row of rows) {
    const name = `${row.queueType} ${row.version} ${row.key} arg ${String(row.arg)} policy ${String(row.policy)} gives ${String(row.value)}`;
    it(`M1-01 AC-6 ${name}`, () => {
      const entry = entryOf(
        resolveEffective(
          input({
            queueType: row.queueType,
            version: row.version,
            args: row.arg === undefined ? {} : { [`x-${row.key}`]: row.arg },
            user: row.policy === undefined ? null : { [row.key]: row.policy },
          }),
        ),
        row.key,
      );

      expect(entry.status).toBe(row.status ?? 'effective');
      expect(entry.value).toBe(row.value);
      expect(entry.rule).toBe(row.rule);
    });
  }

  it('M1-01 AC-6 a policy ignored on this version is reported with its warning, not applied', () => {
    const entry = entryOf(
      resolveEffective(
        input({
          version: '4.3.0',
          args: { 'x-delayed-retry-type': 'all' },
          user: { 'delayed-retry-type': 'failed' },
        }),
      ),
      'delayed-retry-type',
    );

    expect(entry.warnings.map((warning) => warning.id)).toEqual([
      'W-EC-POLICY-IGNORED',
    ]);
    expect(
      entry.provenance.map((leaf) => `${leaf.layer}:${leaf.role}`),
    ).toEqual(['argument:deciding', 'user-policy:ignored']);
  });

  it('M1-01 AC-6 an unsupported key says so and sets nothing', () => {
    const entry = entryOf(
      resolveEffective(
        input({ version: '4.2.9', args: { 'x-delayed-retry-type': 'all' } }),
      ),
      'delayed-retry-type',
    );

    expect(entry.status).toBe('unset');
    expect(entry.warnings.map((warning) => warning.id)).toEqual([
      'W-EC-UNSUPPORTED',
    ]);
  });

  it('M1-01 AC-6 the argument decides when the merged policy cannot be computed but the rule gives the argument precedence', () => {
    const result = resolveEffective(
      input({
        queueType: 'classic',
        args: { 'x-dead-letter-exchange': 'dlx.arg' },
        user: { 'dead-letter-exchange': 'a' },
        operator: { 'dead-letter-exchange': 'b' },
      }),
    );

    const entry = entryOf(result, 'dead-letter-exchange');
    expect(entry.value).toBe('dlx.arg');
    expect(result.mergedPolicy.entries['dead-letter-exchange']?.status).toBe(
      'unknown',
    );
  });
});

describe('M1-01 AC-7 no row means unknown, never a default', () => {
  const warningIds = (
    queueType: QueueType,
    version: string | null,
    key: string,
    scenario: Parameters<typeof input>[0],
  ) => {
    const entry = entryOf(
      resolveEffective(input({ queueType, version, ...scenario })),
      key,
    );
    return { entry, ids: entry.warnings.map((warning) => warning.id) };
  };

  it('M1-01 AC-7 a policy key the registry never described is unknown with W-EC-NO-ROW', () => {
    const { entry, ids } = warningIds('quorum', '4.3.6', 'ha-mode', {
      user: { 'ha-mode': 'all' },
    });

    expect(entry.status).toBe('unknown');
    expect(entry.value).toBeNull();
    expect(entry.rule).toBeNull();
    expect(entry.basis).toBeNull();
    expect(ids).toEqual(['W-EC-NO-ROW']);
    expect(entry.provenance).toEqual([
      {
        layer: 'user-policy',
        name: 'user-policy',
        value: 'all',
        role: 'unresolved',
      },
    ]);
  });

  it('M1-01 AC-7 a key of another queue type has no row either (stream max-length)', () => {
    const { entry, ids } = warningIds('stream', '4.3.6', 'max-length', {
      args: { 'x-max-length': 5 },
    });

    expect([entry.status, entry.value, ids]).toEqual([
      'unknown',
      null,
      ['W-EC-NO-ROW'],
    ]);
    expect(entry.argument).toBe('x-max-length');
  });

  it('M1-01 AC-7 an unreadable version leaves every key unknown with W-EC-VERSION-UNKNOWN', () => {
    const result = resolveEffective(
      input({
        version: null,
        args: { 'x-max-length': 5, 'x-expires': 9 },
        user: { 'message-ttl': 7 },
      }),
    );

    expect(result.version).toBeNull();
    for (const entry of Object.values(result.entries)) {
      expect(entry.status).toBe('unknown');
      expect(entry.value).toBeNull();
      expect(entry.warnings.map((warning) => warning.id)).toEqual([
        'W-EC-VERSION-UNKNOWN',
      ]);
    }
  });

  it('M1-01 AC-7 broker 4.4 has no rows (OQ-963): the 4.3 answer is not borrowed', () => {
    const { entry, ids } = warningIds('quorum', '4.4.0', 'max-length', {
      args: { 'x-max-length': 5 },
      user: { 'max-length': 9 },
    });

    expect([entry.status, entry.value, ids]).toEqual([
      'unknown',
      null,
      ['W-EC-NO-ROW'],
    ]);
  });

  it('M1-01 AC-7 delayed-retry-min and max are undetermined while the sources disagree (OQ-962)', () => {
    for (const key of ['delayed-retry-min', 'delayed-retry-max']) {
      const { entry, ids } = warningIds('quorum', '4.3.6', key, {
        args: { [`x-${key}`]: 100 },
        user: { [key]: 500 },
      });

      expect(entry.status).toBe('unknown');
      expect(entry.value).toBeNull();
      expect(entry.rule).toBeNull();
      expect(ids).toEqual(['W-EC-UNDETERMINED']);
      expect(entry.warnings[0]?.citations.length).toBeGreaterThan(0);
    }
  });

  it('M1-01 AC-7 two policy layers with no merge rule are unknown unless the argument wins', () => {
    const both = {
      user: { 'consumer-disconnected-timeout': 10 },
      operator: { 'consumer-disconnected-timeout': 20 },
    };

    const noArg = warningIds(
      'quorum',
      '4.3.6',
      'consumer-disconnected-timeout',
      both,
    );
    expect([noArg.entry.status, noArg.entry.value, noArg.ids]).toEqual([
      'unknown',
      null,
      ['W-EC-NO-MERGE'],
    ]);
    const withArg = warningIds(
      'quorum',
      '4.3.6',
      'consumer-disconnected-timeout',
      { ...both, args: { 'x-consumer-disconnected-timeout': 5 } },
    );
    expect([withArg.entry.status, withArg.ids]).toEqual([
      'unknown',
      ['W-EC-NO-MERGE'],
    ]);
  });

  it('M1-01 AC-7 a value the rule cannot use is invalid with W-EC-BAD-VALUE and no value', () => {
    const badArg = warningIds('quorum', '4.3.6', 'max-length', {
      args: { 'x-max-length': 'lots' },
      user: { 'max-length': 9 },
    });
    const badPolicy = warningIds('quorum', '4.3.6', 'max-length', {
      args: { 'x-max-length': 5 },
      user: { 'max-length': '9' },
    });
    const badOnly = warningIds('quorum', '4.3.6', 'max-length', {
      args: { 'x-max-length': Number.NaN },
    });
    const badMerge = warningIds('quorum', '4.3.6', 'max-length', {
      user: { 'max-length': 'x' },
      operator: { 'max-length': 3 },
    });
    const object = warningIds('classic', '4.3.6', 'dead-letter-exchange', {
      args: { 'x-dead-letter-exchange': { nested: true } },
    });

    for (const { entry, ids } of [
      badArg,
      badPolicy,
      badOnly,
      badMerge,
      object,
    ]) {
      expect(entry.status).toBe('invalid');
      expect(entry.value).toBeNull();
      expect(ids).toEqual(['W-EC-BAD-VALUE']);
    }
    expect(badArg.entry.warnings[0]?.params.reason).toContain(
      'argument is not a number',
    );
  });

  it('M1-01 AC-7 arguments no row uses are listed, sorted, not dropped', () => {
    const result = resolveEffective(
      input({
        args: {
          'x-queue-type': 'quorum',
          'x-max-priority': 3,
          'x-max-length': 5,
        },
      }),
    );

    expect(result.unrecognisedArguments).toEqual([
      'x-max-priority',
      'x-queue-type',
    ]);
    expect(Object.keys(result.entries)).toEqual(['max-length']);
  });

  it('M1-01 AC-7 the registry lookup throws for the same inputs while the resolver answers', () => {
    expect(() =>
      semanticsRegistry.effectiveConfig.resolution(
        'quorum',
        'ha-mode',
        v('4.3.6'),
      ),
    ).toThrow();
    expect(() =>
      resolveEffective(input({ user: { 'ha-mode': 'all' } })),
    ).not.toThrow();
  });

  it('M1-01 AC-7 a lookup that fails for another reason is not swallowed as unknown', () => {
    const lookup = {
      ...semanticsRegistry.effectiveConfig,
      resolution: () => {
        throw new TypeError('boom');
      },
    };

    expect(() =>
      resolveEffective(input({ args: { 'x-max-length': 5 } }), lookup),
    ).toThrow('boom');
  });
});

describe('M1-01 AC-8 warnings come from registry data with citations', () => {
  const classicOverflow = (
    user: Record<string, unknown> | null,
    operator: Record<string, unknown> | null,
  ) =>
    entryOf(
      resolveEffective(
        input({
          queueType: 'classic',
          args: { 'x-overflow': 'reject-publish' },
          user,
          operator,
        }),
      ),
      'overflow',
    );

  it('M1-01 AC-8 a classic x-overflow argument beats an operator policy: the value is the argument and the warning says the guide differs', () => {
    const entry = classicOverflow(null, { overflow: 'drop-head' });

    expect(entry.value).toBe('reject-publish');
    expect(entry.rule).toBe('arg');
    expect(entry.warnings.map((warning) => warning.id)).toEqual([
      'W-EC-ARG-BEATS-OPERATOR',
    ]);
    expect(entry.warnings[0]?.params).toMatchObject({
      operatorValue: 'drop-head',
      argumentValue: 'reject-publish',
    });
    expect(
      entry.warnings[0]?.citations.some((citation) => citation.kind === 'S'),
    ).toBe(true);
  });

  it('M1-01 AC-8 the same argument against a user policy only carries no such warning', () => {
    expect(classicOverflow({ overflow: 'drop-head' }, null).warnings).toEqual(
      [],
    );
  });

  it('M1-01 AC-8 the policy-wins rows warn when both are set and only then', () => {
    const quorumOverflow = (args: Record<string, unknown>) =>
      entryOf(
        resolveEffective(input({ args, user: { overflow: 'reject-publish' } })),
        'overflow',
      );

    expect(
      quorumOverflow({ 'x-overflow': 'drop-head' }).warnings.map(
        (warning) => warning.id,
      ),
    ).toEqual(['W-EC-POLICY-WINS']);
    expect(quorumOverflow({}).warnings).toEqual([]);
  });

  it('M1-01 AC-8 the broker default of delivery-limit is default (20 from 4.0, no limit on 3.13), never effective', () => {
    const fromFour = entryOf(
      resolveEffective(input({ version: '4.0.8', keys: ['delivery-limit'] })),
      'delivery-limit',
    );
    const threeThirteen = entryOf(
      resolveEffective(input({ version: '3.13.7', keys: ['delivery-limit'] })),
      'delivery-limit',
    );

    expect([fromFour.status, fromFour.value, fromFour.rule]).toEqual([
      'default',
      20,
      'broker-default',
    ]);
    expect(fromFour.provenance).toEqual([
      {
        layer: 'broker-default',
        name: 'broker default',
        value: 20,
        role: 'deciding',
      },
    ]);
    expect(fromFour.warnings.map((warning) => warning.id)).toEqual([
      'W-EC-DEFAULT',
    ]);
    expect(fromFour.warnings[0]?.params.value).toBe('20');
    expect([threeThirteen.status, threeThirteen.value]).toEqual([
      'default',
      null,
    ]);
    expect(threeThirteen.warnings[0]?.params.value).toBe('no limit');
  });

  it('M1-01 AC-8 a requested key nothing sets and the registry has no default for is unset, not defaulted', () => {
    const entry = entryOf(
      resolveEffective(input({ keys: ['max-length'] })),
      'max-length',
    );

    expect([entry.status, entry.value, entry.rule]).toEqual([
      'unset',
      null,
      null,
    ]);
  });

  it('M1-01 AC-8 every placeholder of every text a scenario emits is filled', () => {
    const results = [
      resolveEffective(
        input({
          version: '3.13.7',
          args: { 'x-expires': 1 },
          user: { expires: 2 },
        }),
      ),
      resolveEffective(
        input({
          queueType: 'classic',
          args: { 'x-overflow': 'a' },
          operator: { overflow: 'b' },
        }),
      ),
      resolveEffective(
        input({ args: { 'x-overflow': 'a' }, user: { overflow: 'b' } }),
      ),
      resolveEffective(
        input({
          version: '4.3.0',
          args: { 'x-delayed-retry-type': 'all' },
          user: { 'delayed-retry-type': 'x' },
        }),
      ),
      resolveEffective(
        input({ version: '4.2.9', args: { 'x-delayed-retry-type': 'all' } }),
      ),
      resolveEffective(
        input({
          args: { 'x-delayed-retry-min': 1 },
          user: { 'delayed-retry-min': 2 },
        }),
      ),
      resolveEffective(input({ user: { 'ha-mode': 'all' } })),
      resolveEffective(input({ version: null, user: { 'max-length': 1 } })),
      resolveEffective(
        input({
          user: { 'consumer-disconnected-timeout': 1 },
          operator: { 'consumer-disconnected-timeout': 2 },
        }),
      ),
      resolveEffective(input({ args: { 'x-max-length': 'x' } })),
      resolveEffective(input({ keys: ['delivery-limit'] })),
    ];

    const seen = new Set<string>();
    for (const result of results) {
      for (const entry of Object.values(result.entries)) {
        for (const warning of entry.warnings) {
          seen.add(warning.id);
          expect(warning.textKey).toBe(
            `effective-config.${warning.id}.v${String(warning.textVersion)}`,
          );
          // The texts use only these names (checked in the registry's data spec), so a text can
          // never show an unfilled placeholder.
          expect(Object.keys(warning.params).sort(), warning.id).toEqual(
            [...STANDARD_PARAMS].sort(),
          );
        }
      }
    }
    expect([...seen].sort()).toEqual([
      'W-EC-ARG-BEATS-OPERATOR',
      'W-EC-BAD-VALUE',
      'W-EC-DEFAULT',
      'W-EC-NO-MERGE',
      'W-EC-NO-ROW',
      'W-EC-POLICY-IGNORED',
      'W-EC-POLICY-WINS',
      'W-EC-POLICY-WINS-313',
      'W-EC-UNDETERMINED',
      'W-EC-UNSUPPORTED',
      'W-EC-VERSION-UNKNOWN',
    ]);
  });
});
