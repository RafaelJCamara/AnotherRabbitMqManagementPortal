import type { FeatureId, WarningId } from '@app/contracts';
import { parseSemVer, type SemVer } from '@app/domain-model';
import { describe, expect, it } from 'vitest';
import { registryData, SEMANTICS_VERSION } from './data/index.ts';
import {
  createRegistry,
  validateRegistryData,
  type RegistryData,
} from './registry.ts';
import {
  RegistryDataError,
  SemanticsGapError,
  type CellKey,
  type SemanticsCell,
} from './schema.ts';

const v = (text: string): SemVer => {
  const parsed = parseSemVer(text);
  if (parsed === null) throw new Error(`test setup: ${text} does not parse`);
  return parsed;
};

const KEY: CellKey = {
  era: '4.0-4.2',
  queueType: 'quorum',
  protocol: 'amqp091',
  action: 'amqp091.nack_requeue',
  limit: 'finite',
};

function cell(overrides: Partial<SemanticsCell> = {}): SemanticsCell {
  return {
    id: 'SEM-4.0-4.2-quorum-amqp091-amqp091.nack_requeue-limit-finite',
    key: KEY,
    effect: {
      deltaAC: 1,
      deltaDC: 0,
      countsTowardLimit: 'yes',
      position: 'head',
      destructive: false,
    },
    citations: [{ kind: 'S', ref: 'rabbit_fifo.erl@v4.2.9 return_one' }],
    conformance: ['CF-SETTLE-01'],
    status: 'code-derived',
    evidence: [],
    ...overrides,
  };
}

/** Registry data with every table empty, so a test sees only what it puts in. */
function data(overrides: Partial<RegistryData> = {}): RegistryData {
  return {
    version: SEMANTICS_VERSION,
    cells: [],
    warnings: [],
    hazards: [],
    capabilities: [],
    gates: [],
    peekCaps: [],
    tapRules: [],
    providerPresets: [],
    ...overrides,
  };
}

const gap = (run: () => unknown): SemanticsGapError => {
  try {
    run();
  } catch (error) {
    if (error instanceof SemanticsGapError) return error;
    throw error;
  }
  throw new Error('expected a SemanticsGapError');
};

describe('registry cells: AC-2 fail closed', () => {
  it('AC-2 a key with no cell throws SemanticsGapError that names the key', () => {
    const registry = createRegistry(data({ cells: [cell()] }));
    const missing: CellKey = { ...KEY, era: '4.3' };

    const error = gap(() => registry.cell(missing));

    expect(error).toBeInstanceOf(SemanticsGapError);
    expect(error.key).toEqual(missing);
    expect(error.code).toBe('SEMANTICS_GAP');
    expect(error.message).toContain('4.3|quorum|amqp091');
  });

  it('AC-2 a registry without data answers every lookup with a gap, never a default', () => {
    const registry = createRegistry(data());

    expect(() => registry.cell(KEY)).toThrow(SemanticsGapError);
    expect(() => registry.warning('W-BUDGET')).toThrow(SemanticsGapError);
    expect(() =>
      registry.peekCaps('4.3', 'quorum', 'user', 'verified'),
    ).toThrow(SemanticsGapError);
    expect(() => registry.gate('peek' as FeatureId, profile())).toThrow(
      SemanticsGapError,
    );
    expect(() =>
      registry.capability('channelsAcceptDisableStats', profile()),
    ).toThrow(SemanticsGapError);
    expect(() =>
      registry.providerPreset(
        { provider: 'amazon-mq', product: 'rabbitmq' },
        null,
      ),
    ).toThrow(SemanticsGapError);
  });

  it('AC-2 isDoomed answers through the registry', () => {
    const registry = createRegistry(data());

    expect(
      registry.isDoomed(
        '4.3',
        { deliveryCount: 21 },
        { kind: 'finite', value: 20 },
      ),
    ).toBe(true);
    expect(
      registry.isDoomed(
        '4.0-4.2',
        { deliveryCount: 20 },
        { kind: 'finite', value: 20 },
      ),
    ).toBe(true);
    expect(
      registry.isDoomed('4.3', { deliveryCount: 21 }, { kind: 'unlimited' }),
    ).toBe(false);
  });

  it('returns the cell for an exact key match', () => {
    const registry = createRegistry(data({ cells: [cell()] }));

    expect(registry.cell(KEY).effect?.deltaAC).toBe(1);
  });

  it('matches every dimension of the key: a different limit state or delayed-retry mode is another cell', () => {
    const registry = createRegistry(data({ cells: [cell()] }));

    expect(() => registry.cell({ ...KEY, limit: 'unset' })).toThrow(
      SemanticsGapError,
    );
    expect(() => registry.cell({ ...KEY, delayedRetry: 'all' })).toThrow(
      SemanticsGapError,
    );
    const withoutLimit: CellKey = {
      era: KEY.era,
      queueType: KEY.queueType,
      protocol: KEY.protocol,
      action: KEY.action,
    };
    expect(() => registry.cell(withoutLimit)).toThrow(SemanticsGapError);
    expect(() => registry.cell({ ...KEY, queueType: 'classic' })).toThrow(
      SemanticsGapError,
    );
    expect(() => registry.cell({ ...KEY, protocol: 'amqp10' })).toThrow(
      SemanticsGapError,
    );
    expect(() =>
      registry.cell({ ...KEY, action: 'amqp091.reject_requeue' }),
    ).toThrow(SemanticsGapError);
  });

  it('treats a cell whose effect is not derived yet as a gap', () => {
    const registry = createRegistry(data({ cells: [cell({ effect: null })] }));

    expect(gap(() => registry.cell(KEY)).message).toContain('not derived');
  });

  it('treats a cell the lab contradicted as a gap, not as an answer', () => {
    const contradicted = cell({
      status: 'lab-contradicted',
      evidence: ['testing/lab-evidence/4.2.9/CF-SETTLE-01.json'],
    });
    const registry = createRegistry(data({ cells: [contradicted] }));

    expect(gap(() => registry.cell(KEY)).message).toContain('contradicted');
  });

  it('answers with a lab-verified cell that has its evidence', () => {
    const verified = cell({
      status: 'lab-verified',
      evidence: ['testing/lab-evidence/4.2.9/CF-SETTLE-01.json'],
    });
    const registry = createRegistry(data({ cells: [verified] }));

    expect(registry.cell(KEY).status).toBe('lab-verified');
  });

  it('hands out frozen cells so a caller cannot change what the next lookup answers', () => {
    const registry = createRegistry(data({ cells: [cell()] }));
    const found = registry.cell(KEY);

    expect(Object.isFrozen(found)).toBe(true);
    expect(() => {
      (found.effect as { deltaAC: number }).deltaAC = 0;
    }).toThrow(TypeError);
    expect(registry.cell(KEY).effect?.deltaAC).toBe(1);
  });
});

describe('registry data is validated when the registry is built', () => {
  const problemsOf = (overrides: Partial<RegistryData>): string[] =>
    validateRegistryData(data(overrides));

  it('accepts the data this release ships', () => {
    expect(validateRegistryData(registryData)).toEqual([]);
    expect(registryData.version).toBe(SEMANTICS_VERSION);
  });

  it('rejects a duplicate cell id and a duplicate cell key', () => {
    const duplicateId = problemsOf({
      cells: [cell(), cell({ key: { ...KEY, limit: 'unset' } })],
    });
    const duplicateKey = problemsOf({
      cells: [cell(), cell({ id: 'SEM-other' })],
    });

    expect(duplicateId.join('\n')).toContain('used by 2 cells');
    expect(duplicateKey.join('\n')).toContain('same key');
  });

  it('rejects a cell with no conformance id', () => {
    expect(problemsOf({ cells: [cell({ conformance: [] })] }).join()).toContain(
      'conformance id',
    );
  });

  it('rejects a cell that is lab-verified or lab-contradicted without evidence', () => {
    for (const status of ['lab-verified', 'lab-contradicted'] as const) {
      expect(
        problemsOf({ cells: [cell({ status })] }).join(),
        status,
      ).toContain('without lab evidence');
    }
  });

  it("rejects evidence that is not for one of the cell's own conformance ids", () => {
    const other = cell({
      status: 'lab-verified',
      evidence: ['testing/lab-evidence/4.2.9/CF-OTHER-01.json'],
    });

    expect(problemsOf({ cells: [other] }).join()).toContain('not for one of');
  });

  it('rejects an evidence path outside testing/lab-evidence', () => {
    expect(
      problemsOf({ cells: [cell({ evidence: ['docs/evidence.json'] })] })
        .length,
    ).toBeGreaterThan(0);
  });

  it('rejects an unknown field, a bad id and a bad version stamp', () => {
    expect(
      validateRegistryData({ ...data(), extra: true }).length,
    ).toBeGreaterThan(0);
    expect(
      problemsOf({ cells: [cell({ id: 'cell-1' as never })] }).length,
    ).toBeGreaterThan(0);
    expect(problemsOf({ version: '2026.10' }).length).toBeGreaterThan(0);
  });

  it('createRegistry throws RegistryDataError listing every problem', () => {
    const build = (): unknown =>
      createRegistry(data({ cells: [cell({ conformance: [] })] }));

    expect(build).toThrow(RegistryDataError);
  });
});

function profile(
  overrides: Record<string, unknown> = {},
): Parameters<ReturnType<typeof createRegistry>['gate']>[1] {
  return {
    product: 'rabbitmq',
    stats: { disabled: false, queueTotals: true },
    featureFlags: {},
    versions: {
      min: v('4.3.6'),
      perNode: { 'rabbit@a': v('4.3.6') },
      mixed: false,
      build: 'oss',
    },
    ...overrides,
  };
}

describe('registry tables', () => {
  const registry = createRegistry(
    data({
      warnings: [
        {
          id: 'W-BUDGET',
          severity: 'consent',
          textKey: 'warnings.budget',
          textVersion: 1,
        },
      ],
      peekCaps: [
        {
          era: '4.0-4.2',
          queueType: 'quorum',
          role: 'user',
          def: 20,
          max: 50,
          maxBytes: 1000,
        },
        {
          era: '4.0-4.2',
          queueType: 'quorum',
          role: 'admin',
          def: 20,
          max: 200,
          maxBytes: 2000,
        },
        {
          era: '4.3',
          queueType: 'quorum',
          role: 'user',
          def: 20,
          max: 500,
          maxBytes: 16000,
        },
      ],
      tapRules: [
        {
          exchangeType: 'x-consistent-hash',
          diverts: true,
          e2eAllowed: false,
          refuseByDefault: true,
          overrides: [{ versions: '>=4.3.6', e2eAllowed: true }],
        },
        {
          exchangeType: 'topic',
          diverts: false,
          e2eAllowed: true,
          refuseByDefault: false,
        },
      ],
      gates: [
        {
          feature: 'channels.stats' as FeatureId,
          versions: '>=4.3.6',
          requiresStats: true,
          reason:
            'Channel statistics need 4.3.6 or later with statistics enabled.',
          source: 'fact sheet hazards',
        },
      ],
      hazards: [
        {
          id: 'channels-400-stats-off',
          versions: '<4.3.6',
          statsDisabled: true,
          summary: '/api/channels returns 400 while statistics are disabled.',
          citations: [{ kind: 'GH', ref: 'rabbitmq/rabbitmq-server#17198' }],
        },
      ],
    }),
  );

  it('warning() returns the entry and throws a gap for an unknown id', () => {
    expect(registry.warning('W-BUDGET').textKey).toBe('warnings.budget');
    expect(gap(() => registry.warning('W-NOPE')).key).toEqual({
      table: 'warning',
      id: 'W-NOPE',
    });
  });

  it('peekCaps() returns the row for a verified build', () => {
    expect(registry.peekCaps('4.0-4.2', 'quorum', 'admin', 'verified')).toEqual(
      {
        def: 20,
        max: 200,
        maxBytes: 2000,
      },
    );
  });

  it('peekCaps() caps a build that is not verified at the conservative row defaults', () => {
    for (const verification of [
      'unverified-patch',
      'unverified-minor',
      'unknown-build',
    ] as const) {
      expect(
        registry.peekCaps('4.3', 'quorum', 'user', verification),
        verification,
      ).toEqual({
        def: 20,
        max: 20,
        maxBytes: 1000,
      });
    }
  });

  it('peekCaps() throws a gap for a missing row and for a missing conservative row', () => {
    expect(
      gap(() => registry.peekCaps('4.3', 'classic', 'user', 'verified')).key,
    ).toEqual({
      table: 'peek-caps',
      id: '4.3|classic|user',
    });
    expect(
      gap(() => registry.peekCaps('4.3', 'quorum', 'admin', 'verified')).key,
    ).toEqual({
      table: 'peek-caps',
      id: '4.3|quorum|admin',
    });
  });

  it('tapRule() applies the version override and falls back to the baseline for an unknown version', () => {
    expect(registry.tapRule('x-consistent-hash', v('4.3.4'))).toEqual({
      diverts: true,
      e2eAllowed: false,
      refuseByDefault: true,
    });
    expect(registry.tapRule('x-consistent-hash', v('4.3.6')).e2eAllowed).toBe(
      true,
    );
    expect(registry.tapRule('x-consistent-hash', null).e2eAllowed).toBe(false);
    expect(registry.tapRule('topic', v('4.3.6'))).toEqual({
      diverts: false,
      e2eAllowed: true,
      refuseByDefault: false,
    });
  });

  it('tapRule() refuses an exchange type nobody described', () => {
    expect(registry.tapRule('x-future-type', v('4.3.6'))).toEqual({
      diverts: true,
      e2eAllowed: false,
      refuseByDefault: true,
    });
  });

  it('gate() opens, closes with the rule reason, and throws a gap without a rule', () => {
    const feature = 'channels.stats' as FeatureId;

    expect(registry.gate(feature, profile())).toEqual({
      enabled: true,
      mode: 'full',
      source: 'fact sheet hazards',
    });
    expect(
      registry.gate(
        feature,
        profile({ stats: { disabled: true, queueTotals: false } }),
      ),
    ).toMatchObject({
      enabled: false,
      reason: 'Channel statistics need 4.3.6 or later with statistics enabled.',
    });
    const old = {
      min: v('4.3.5'),
      perNode: { a: v('4.3.5') },
      mixed: false,
      build: 'oss',
    };
    expect(registry.gate(feature, profile({ versions: old })).enabled).toBe(
      false,
    );
    expect(
      gap(() => registry.gate('other' as FeatureId, profile())).key,
    ).toEqual({
      table: 'gate',
      id: 'other',
    });
  });

  it('gate() closes when any node is older than the range or unreadable', () => {
    const feature = 'channels.stats' as FeatureId;
    const mixed = {
      min: v('4.3.5'),
      perNode: { a: v('4.3.6'), b: v('4.3.5') },
      mixed: true,
      build: 'oss',
    };
    const unreadable = {
      min: null,
      perNode: { a: v('4.3.6'), b: null },
      mixed: false,
      build: 'oss',
    };

    expect(registry.gate(feature, profile({ versions: mixed })).enabled).toBe(
      false,
    );
    expect(
      registry.gate(feature, profile({ versions: unreadable })).enabled,
    ).toBe(false);
  });

  it('hazards() lists the rules that apply to the profile', () => {
    const statsOff = { disabled: true, queueTotals: false };
    const old = {
      min: v('4.3.5'),
      perNode: { a: v('4.3.5') },
      mixed: false,
      build: 'oss',
    };

    expect(
      registry.hazards(profile({ versions: old, stats: statsOff })),
    ).toEqual(['channels-400-stats-off']);
    expect(registry.hazards(profile({ stats: statsOff }))).toEqual([]);
    expect(registry.hazards(profile({ versions: old }))).toEqual([]);
    expect(
      registry.hazards(
        profile({ versions: old, stats: statsOff, product: 'lavinmq' }),
      ),
    ).toEqual([]);
  });

  it('hazards() reports a rule when a node version could not be read', () => {
    const unreadable = {
      min: null,
      perNode: { a: null },
      mixed: false,
      build: 'commercial-or-unknown',
    };
    const statsOff = { disabled: true, queueTotals: false };

    expect(
      registry.hazards(profile({ versions: unreadable, stats: statsOff })),
    ).toEqual(['channels-400-stats-off']);
  });

  it('rejects duplicate table entries and invalid ranges when the registry is built', () => {
    const warning = {
      id: 'W-X' as WarningId,
      severity: 'info' as const,
      textKey: 'k',
      textVersion: 1,
    };
    const row = {
      era: '4.3' as const,
      queueType: 'quorum' as const,
      role: 'user' as const,
      def: 1,
      max: 1,
      maxBytes: 1,
    };

    expect(
      validateRegistryData(data({ warnings: [warning, warning] })).join(),
    ).toContain('defined twice');
    expect(
      validateRegistryData(data({ peekCaps: [row, row] })).join(),
    ).toContain('defined twice');
    expect(
      validateRegistryData(data({ peekCaps: [{ ...row, def: 5, max: 2 }] }))
        .length,
    ).toBeGreaterThan(0);
    expect(
      validateRegistryData(
        data({
          tapRules: [
            {
              exchangeType: 't',
              diverts: false,
              e2eAllowed: true,
              refuseByDefault: false,
              overrides: [{ versions: '^4' }],
            },
          ],
        }),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      validateRegistryData(
        data({
          gates: [{ feature: 'f' as FeatureId, versions: '??', reason: 'r' }],
        }),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      validateRegistryData(
        data({
          hazards: [
            { id: 'Bad Id', versions: '<4', summary: 's', citations: [] },
          ],
        }),
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe('registry data of M0-13 tables', () => {
  it('rejects a duplicate capability, an invalid capability range and a provider table with a hole', () => {
    const capability = {
      id: 'canDoIt',
      summary: 's',
      versions: '>=4.0.0',
      appliesWhen: 'always' as const,
      citations: [{ kind: 'D' as const, ref: 'r' }],
    };
    const [first, ...rest] = registryData.providerPresets;
    if (first === undefined) throw new Error('test setup: no presets');

    expect(
      validateRegistryData(
        data({ capabilities: [capability, capability] }),
      ).join(),
    ).toContain('defined twice');
    expect(
      validateRegistryData(
        data({ capabilities: [{ ...capability, versions: '??' }] }),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      validateRegistryData(data({ providerPresets: rest })).join(),
    ).toContain(`provider preset ${first.id} is missing`);
  });

  it('the shipped data builds a registry whose tables all answer', () => {
    const shipped = createRegistry(registryData);

    expect(shipped.warning('W-BUDGET').severity).toBe('consent');
    expect(
      shipped.hazards(
        profile({
          versions: {
            min: v('4.3.5'),
            perNode: {},
            mixed: false,
            build: 'oss',
          },
          stats: { disabled: true, queueTotals: false },
        }),
      ),
    ).toContain('channels-400-stats-off');
    expect(shipped.tapRule('x-random', null).refuseByDefault).toBe(true);
  });
});
