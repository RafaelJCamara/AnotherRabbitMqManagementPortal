import { parseSemVer, type SemVer } from '@app/domain-model';
import { describe, expect, it } from 'vitest';
import {
  buildEffectiveConfig,
  EffectiveConfigDataSchema,
  OperatorMergeRuleSchema,
  type EffectiveConfigData,
  type OperatorMergeRule,
  type ResolutionRule,
} from './effective-config.ts';
import { createRegistry, validateRegistryData } from './registry.ts';
import { registryData } from './data/index.ts';
import { RegistryDataError, SemanticsGapError } from './schema.ts';

const v = (text: string): SemVer => {
  const parsed = parseSemVer(text);
  if (parsed === null) throw new Error(`test setup: ${text} does not parse`);
  return parsed;
};

const CITE = [{ kind: 'S', ref: 'RS@v4.3.6:x.erl L1' }] as const;

const WARN = {
  id: 'W-EC-TEST',
  severity: 'info',
  textKey: 'effective-config.W-EC-TEST.v1',
  textVersion: 1,
} as const;

function row(overrides: Partial<ResolutionRule> = {}): ResolutionRule {
  return {
    queueType: 'quorum',
    key: 'max-length',
    argument: 'x-max-length',
    versions: '>=4.0.0 <4.4.0',
    sourceRead: '>=4.3.0 <4.4.0',
    resolve: 'min',
    warnings: [],
    citations: [...CITE],
    conformance: ['CF-EFFCFG-01'],
    ...overrides,
  };
}

function data(
  overrides: Partial<EffectiveConfigData> = {},
): EffectiveConfigData {
  return {
    merges: [],
    resolutions: [row()],
    warnings: [WARN],
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

const problems = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof RegistryDataError) return error.problems.join('\n');
    throw error;
  }
  throw new Error('expected a RegistryDataError');
};

describe('M1-01 AC-7 effective-config lookups fail closed', () => {
  it('M1-01 AC-7 a queue type or key without a row is a gap that names the row', () => {
    const lookup = buildEffectiveConfig(data());

    expect(
      gap(() => lookup.resolution('classic', 'max-length', v('4.3.6'))).key,
    ).toEqual({ table: 'effective-config', id: 'classic|max-length' });
    expect(
      gap(() => lookup.resolution('quorum', 'expires', v('4.3.6'))).message,
    ).toContain('no row for this queue type and key');
  });

  it('M1-01 AC-7 an unreadable version is a gap, not the newest row', () => {
    const lookup = buildEffectiveConfig(data());

    expect(
      gap(() => lookup.resolution('quorum', 'max-length', null)).message,
    ).toContain('could not be read');
  });

  it('M1-01 AC-7 a version outside every row is a gap (4.4 and 3.13 here)', () => {
    const lookup = buildEffectiveConfig(data());

    expect(
      gap(() => lookup.resolution('quorum', 'max-length', v('4.4.0'))).message,
    ).toContain('no row covers version 4.4.0');
    expect(
      gap(() => lookup.resolution('quorum', 'max-length', v('3.13.7'))).message,
    ).toContain('no row covers version 3.13.7');
  });

  it('M1-01 AC-7 two rows that both cover a version are a gap, not a pick', () => {
    const lookup = buildEffectiveConfig(
      data({
        resolutions: [
          row({ versions: '>=4.0.0 <4.4.0' }),
          row({ versions: '>=4.2.0 <4.4.0', resolve: 'policy-wins' }),
        ],
      }),
    );

    expect(
      gap(() => lookup.resolution('quorum', 'max-length', v('4.3.0'))).message,
    ).toContain('rows overlap');
    expect(lookup.resolution('quorum', 'max-length', v('4.1.0')).resolve).toBe(
      'min',
    );
  });

  it('M1-01 AC-7 a merge rule is found by key, then by value type, otherwise a gap', () => {
    const lookup = buildEffectiveConfig(
      data({
        merges: [
          {
            key: 'expires',
            valueType: null,
            merge: 'min',
            citations: [...CITE],
            conformance: ['CF-EFFCFG-01'],
          },
          {
            key: null,
            valueType: 'boolean',
            merge: 'operator',
            citations: [...CITE],
            conformance: ['CF-EFFCFG-04'],
          },
        ],
      }),
    );

    expect(lookup.merge('expires', false).kind).toBe('min');
    expect(lookup.merge('anything', true).kind).toBe('operator');
    expect(gap(() => lookup.merge('anything', false)).message).toContain(
      'no merge rule names this key',
    );
    // A named rule wins over the value-type rule.
    expect(lookup.merge('expires', true).kind).toBe('min');
  });

  it('M1-01 AC-7 an unknown W-EC id is a gap', () => {
    const lookup = buildEffectiveConfig(data());

    expect(lookup.warning('W-EC-TEST')).toBe(WARN);
    expect(() => lookup.warning('W-EC-NOPE')).toThrow(SemanticsGapError);
  });
});

describe('M1-01 AC-6 the basis of a row', () => {
  it('M1-01 AC-6 a version inside sourceRead is source-read, any other covered version is extrapolated', () => {
    const lookup = buildEffectiveConfig(data());

    expect(lookup.resolution('quorum', 'max-length', v('4.3.6')).basis).toBe(
      'source-read',
    );
    expect(lookup.resolution('quorum', 'max-length', v('4.0.8')).basis).toBe(
      'extrapolated',
    );
  });

  it('M1-01 AC-6 a row without sourceRead is always extrapolated, and a broker default is returned as data', () => {
    const lookup = buildEffectiveConfig(
      data({
        resolutions: [
          row({ sourceRead: null, brokerDefault: { value: null } }),
        ],
      }),
    );

    const outcome = lookup.resolution('quorum', 'max-length', v('4.3.6'));
    expect(outcome.basis).toBe('extrapolated');
    expect(outcome.brokerDefault).toEqual({ value: null });
  });
});

describe('M1-01 AC-9 the builder rejects bad data', () => {
  it('M1-01 AC-9 a duplicate merge rule, boolean rule or warning id', () => {
    const merge: OperatorMergeRule = {
      key: 'expires',
      valueType: null,
      merge: 'min',
      citations: [...CITE],
      conformance: ['CF-EFFCFG-01'],
    };
    const boolean: OperatorMergeRule = {
      key: null,
      valueType: 'boolean',
      merge: 'operator',
      citations: [...CITE],
      conformance: ['CF-EFFCFG-04'],
    };

    expect(
      problems(() => buildEffectiveConfig(data({ merges: [merge, merge] }))),
    ).toContain('merge rule expires is defined twice');
    expect(
      problems(() =>
        buildEffectiveConfig(data({ merges: [boolean, boolean] })),
      ),
    ).toContain('two merge rules for booleans');
    expect(
      problems(() => buildEffectiveConfig(data({ warnings: [WARN, WARN] }))),
    ).toContain('warning W-EC-TEST is defined twice');
  });

  it('M1-01 AC-9 a row that names a warning the table lacks', () => {
    const text = problems(() =>
      buildEffectiveConfig(
        data({
          resolutions: [
            row({ warnings: [{ id: 'W-EC-MISSING', when: 'always' }] }),
          ],
        }),
      ),
    );

    expect(text).toContain('unknown warning W-EC-MISSING');
  });

  it('M1-01 AC-9 an argument-only, unsupported or undetermined row without a warning says nothing about why', () => {
    for (const resolve of [
      'argument-only',
      'unsupported',
      'undetermined',
    ] as const) {
      expect(
        problems(() =>
          buildEffectiveConfig(data({ resolutions: [row({ resolve })] })),
        ),
      ).toContain(`a ${resolve} row needs a warning`);
      expect(() =>
        buildEffectiveConfig(
          data({
            resolutions: [
              row({ resolve, warnings: [{ id: 'W-EC-TEST', when: 'always' }] }),
            ],
          }),
        ),
      ).not.toThrow();
    }
  });

  it('M1-01 AC-9 a key with two arguments, an argument with two keys, and the same row twice', () => {
    expect(
      problems(() =>
        buildEffectiveConfig(
          data({
            resolutions: [
              row(),
              row({ queueType: 'classic', argument: 'x-other' }),
            ],
          }),
        ),
      ),
    ).toContain('maps to x-other and x-max-length');
    expect(
      problems(() =>
        buildEffectiveConfig(
          data({
            resolutions: [
              row(),
              row({ key: 'other-key', queueType: 'classic' }),
            ],
          }),
        ),
      ),
    ).toContain('argument x-max-length maps to other-key and max-length');
    expect(
      problems(() =>
        buildEffectiveConfig(data({ resolutions: [row(), row()] })),
      ),
    ).toContain('defined twice');
  });

  it('M1-01 AC-9 an invalid version range', () => {
    expect(
      problems(() =>
        buildEffectiveConfig(
          data({ resolutions: [row({ versions: 'newer' })] }),
        ),
      ),
    ).toContain('invalid version range newer');
    expect(
      problems(() =>
        buildEffectiveConfig(
          data({ resolutions: [row({ sourceRead: '4.x.1' })] }),
        ),
      ),
    ).toContain('invalid version range 4.x.1');
  });

  it('M1-01 AC-9 the schema rejects a merge rule that names both or neither a key and a value type, and a row without citations or CF ids', () => {
    const base = {
      merge: 'min',
      citations: [...CITE],
      conformance: ['CF-EFFCFG-01'],
    };

    expect(
      OperatorMergeRuleSchema.safeParse({
        ...base,
        key: 'a',
        valueType: 'boolean',
      }).success,
    ).toBe(false);
    expect(
      OperatorMergeRuleSchema.safeParse({ ...base, key: null, valueType: null })
        .success,
    ).toBe(false);
    expect(
      OperatorMergeRuleSchema.safeParse({ ...base, key: 'a', valueType: null })
        .success,
    ).toBe(true);
    expect(
      EffectiveConfigDataSchema.safeParse(
        data({ resolutions: [row({ citations: [] })] }),
      ).success,
    ).toBe(false);
    expect(
      EffectiveConfigDataSchema.safeParse(
        data({ resolutions: [row({ conformance: [] })] }),
      ).success,
    ).toBe(false);
    expect(
      EffectiveConfigDataSchema.safeParse(
        data({ resolutions: [row({ argument: 'max-length' })] }),
      ).success,
    ).toBe(false);
  });

  it('M1-01 AC-9 the argument of a row is found by keyForArgument, an unknown one is null', () => {
    const lookup = buildEffectiveConfig(data());

    expect(lookup.keyForArgument('x-max-length')).toBe('max-length');
    expect(lookup.keyForArgument('x-queue-type')).toBeNull();
  });
});

describe('M1-01 AC-9 the registry carries the table', () => {
  it('M1-01 AC-9 createRegistry exposes the lookups and validateRegistryData reports a bad table', () => {
    const registry = createRegistry(registryData);
    expect(
      registry.effectiveConfig.resolution('quorum', 'max-length', v('4.0.8'))
        .resolve,
    ).toBe('min');

    const broken = {
      ...registryData,
      effectiveConfig: data({ resolutions: [row({ versions: 'newer' })] }),
    };
    expect(validateRegistryData(broken).join('\n')).toContain(
      'not a valid version range',
    );
    expect(() => createRegistry(broken)).toThrow(RegistryDataError);
  });
});
