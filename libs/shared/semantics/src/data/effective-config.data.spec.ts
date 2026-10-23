// M1-01 AC-9: the k.3 data is well formed, and an oracle written from the fact sheet rows (k.3 and
// b.5) pins what it says: a changed rule, a dropped row or an extra row fails here.
import {
  parseSemVer,
  QueueTypeSchema,
  type QueueType,
} from '@app/domain-model';
import { describe, expect, it } from 'vitest';
import { semanticsRegistry } from '../index.ts';
import { SemanticsGapError } from '../schema.ts';
import type { ResolveKind } from '../effective-config.ts';
import texts from '../../i18n/en/effective-config.json' with { type: 'json' };
import { effectiveConfig } from './effective-config.data.ts';

const lookup = semanticsRegistry.effectiveConfig;
const textsById: Record<string, Record<string, string>> = texts;

const v = (text: string) => {
  const parsed = parseSemVer(text);
  if (parsed === null) throw new Error(`test setup: ${text} does not parse`);
  return parsed;
};

/** Every version a broker could report between 3.13.0 and 4.4.12 (and a few beyond). */
const VERSIONS = [
  ...[
    ['3', '13'],
    ['4', '0'],
    ['4', '1'],
    ['4', '2'],
    ['4', '3'],
    ['4', '4'],
  ].flatMap(([major, minor]) =>
    Array.from(
      { length: 13 },
      (_, patch) => `${major ?? ''}.${minor ?? ''}.${String(patch)}`,
    ),
  ),
  '4.3.0-rc.1',
  '4.5.0',
  '5.0.0',
].map(v);

/** What the fact sheet says; `null` is "no row" (a gap). */
type Answer = ResolveKind | null;

interface Oracle {
  readonly queueType: QueueType;
  readonly key: string;
  readonly byEra: Readonly<
    Record<'3.13' | '4.0-4.2' | '4.3.0' | '4.3.1+' | '4.4', Answer>
  >;
}

const same = (answer: Answer, to4_3 = answer): Oracle['byEra'] => ({
  '3.13': answer,
  '4.0-4.2': answer,
  '4.3.0': to4_3,
  '4.3.1+': to4_3,
  '4.4': null,
});
const onlyFrom43 = (answer: Answer): Oracle['byEra'] => ({
  '3.13': null,
  '4.0-4.2': null,
  '4.3.0': answer,
  '4.3.1+': answer,
  '4.4': null,
});
const delayed = (from431: Answer): Oracle['byEra'] => ({
  '3.13': 'unsupported',
  '4.0-4.2': 'unsupported',
  '4.3.0': 'argument-only',
  '4.3.1+': from431,
  '4.4': null,
});

const ORACLE: readonly Oracle[] = [
  // Classic (k.3).
  ...(
    ['expires', 'message-ttl', 'max-length', 'max-length-bytes'] as const
  ).map((key): Oracle => ({ queueType: 'classic', key, byEra: same('min') })),
  ...(
    ['dead-letter-exchange', 'dead-letter-routing-key', 'overflow'] as const
  ).map(
    (key): Oracle => ({
      queueType: 'classic',
      key,
      byEra: same('argument-wins'),
    }),
  ),
  // Quorum (k.3, b.5).
  ...(['max-length', 'max-length-bytes', 'message-ttl'] as const).map(
    (key): Oracle => ({ queueType: 'quorum', key, byEra: same('min') }),
  ),
  {
    queueType: 'quorum',
    key: 'expires',
    byEra: {
      '3.13': 'policy-wins',
      '4.0-4.2': 'min',
      '4.3.0': 'min',
      '4.3.1+': 'min',
      '4.4': null,
    },
  },
  {
    queueType: 'quorum',
    key: 'consumer-disconnected-timeout',
    byEra: onlyFrom43('min'),
  },
  { queueType: 'quorum', key: 'delivery-limit', byEra: same('negative-rule') },
  ...(
    [
      'dead-letter-exchange',
      'dead-letter-routing-key',
      'dead-letter-strategy',
    ] as const
  ).map(
    (key): Oracle => ({
      queueType: 'quorum',
      key,
      byEra: same('argument-wins'),
    }),
  ),
  { queueType: 'quorum', key: 'overflow', byEra: same('policy-wins') },
  {
    queueType: 'quorum',
    key: 'delayed-retry-type',
    byEra: delayed('policy-wins'),
  },
  {
    queueType: 'quorum',
    key: 'delayed-retry-min',
    byEra: delayed('undetermined'),
  },
  {
    queueType: 'quorum',
    key: 'delayed-retry-max',
    byEra: delayed('undetermined'),
  },
  // Streams (k.3).
  ...(
    [
      'max-length-bytes',
      'max-age',
      'stream-max-segment-size-bytes',
      'stream-filter-size-bytes',
      'initial-cluster-size',
    ] as const
  ).map(
    (key): Oracle => ({ queueType: 'stream', key, byEra: same('policy-wins') }),
  ),
];

const SAMPLE = {
  '3.13': ['3.13.0', '3.13.7'],
  '4.0-4.2': ['4.0.0', '4.0.8', '4.2.9'],
  '4.3.0': ['4.3.0'],
  '4.3.1+': ['4.3.1', '4.3.6', '4.3.12'],
  '4.4': ['4.4.0', '4.4.3', '5.0.0'],
} as const;

function answer(queueType: QueueType, key: string, version: string): Answer {
  try {
    return lookup.resolution(queueType, key, v(version)).resolve;
  } catch (error) {
    if (error instanceof SemanticsGapError) return null;
    throw error;
  }
}

describe('M1-01 AC-9 the k.3 data is well formed', () => {
  it('M1-01 AC-9 the data is exactly the oracle: every (queue type, key, era) answers as the fact sheet says, and no other row exists', () => {
    for (const { queueType, key, byEra } of ORACLE) {
      for (const [era, expected] of Object.entries(byEra)) {
        for (const version of SAMPLE[era as keyof typeof SAMPLE]) {
          expect(
            answer(queueType, key, version),
            `${queueType} ${key} on ${version}`,
          ).toBe(expected);
        }
      }
    }
    const described = new Set(
      ORACLE.map((entry) => `${entry.queueType}|${entry.key}`),
    );
    const shipped = new Set(
      effectiveConfig.resolutions.map(
        (rule) => `${rule.queueType}|${rule.key}`,
      ),
    );
    expect([...shipped].sort()).toEqual([...described].sort());
  });

  it('M1-01 AC-9 no two rows of a (queue type, key) cover the same version, from 3.13.0 to 5.0.0', () => {
    for (const queueType of QueueTypeSchema.options) {
      for (const key of new Set(
        effectiveConfig.resolutions.map((rule) => rule.key),
      )) {
        for (const version of VERSIONS) {
          try {
            lookup.resolution(queueType, key, version);
          } catch (error) {
            expect(error).toBeInstanceOf(SemanticsGapError);
            expect(
              (error as Error).message,
              `${queueType} ${key} ${version.raw}`,
            ).not.toContain('overlap');
          }
        }
      }
    }
  });

  it('M1-01 AC-9 broker 4.4 and later have no row at all (OQ-963), so the answer is a gap, never the 4.3 rule', () => {
    for (const rule of effectiveConfig.resolutions) {
      for (const version of ['4.4.0', '4.4.12', '4.5.0', '5.0.0']) {
        expect(
          answer(rule.queueType, rule.key, version),
          `${rule.key} on ${version}`,
        ).toBeNull();
      }
    }
  });

  it('M1-01 AC-9 every row and merge rule has a citation and a planned CF-EFFCFG id, and none claims lab status or evidence', () => {
    for (const rule of [
      ...effectiveConfig.merges,
      ...effectiveConfig.resolutions,
    ]) {
      expect(rule.citations.length).toBeGreaterThan(0);
      expect(rule.conformance.length).toBeGreaterThan(0);
      for (const id of rule.conformance)
        expect(id).toMatch(/^CF-EFFCFG-0[1-7]$/);
      for (const citation of rule.citations)
        expect(citation.ref.length).toBeGreaterThan(20);
    }
    expect(JSON.stringify(effectiveConfig)).not.toMatch(
      /lab-verified|lab-contradicted|evidence/,
    );
  });

  it('M1-01 AC-9 an argument maps to one key and each key to its x- argument', () => {
    for (const rule of effectiveConfig.resolutions) {
      expect(lookup.keyForArgument(rule.argument)).toBe(rule.key);
      expect(rule.argument).toBe(`x-${rule.key}`);
    }
  });

  it('M1-01 AC-9 the operator merge rules are the step 1 rows of k.3', () => {
    const kind = (key: string, bothBoolean = false) =>
      lookup.merge(key, bothBoolean).kind;
    for (const key of [
      'message-ttl',
      'max-length',
      'max-length-bytes',
      'max-in-memory-length',
      'max-in-memory-bytes',
      'expires',
    ]) {
      expect(kind(key), key).toBe('min');
    }
    expect(kind('delivery-limit')).toBe('negative-rule');
    for (const key of ['overflow', 'queue-version', 'delayed-retry-type'])
      expect(kind(key), key).toBe('operator');
    expect(kind('target-group-size')).toBe('max');
    expect(kind('some-flag', true)).toBe('operator');
    expect(() => kind('max-age')).toThrow(SemanticsGapError);
    expect(() => kind('delayed-retry-min')).toThrow(SemanticsGapError);
  });

  it('M1-01 AC-9 the delayed-retry min and max rows are undetermined and say so, because k.3 and b.5 disagree (OQ-962)', () => {
    for (const key of ['delayed-retry-min', 'delayed-retry-max']) {
      const outcome = lookup.resolution('quorum', key, v('4.3.6'));
      expect(outcome.resolve).toBe('undetermined');
      expect(outcome.warnings.map((entry) => entry.warning.id)).toEqual([
        'W-EC-UNDETERMINED',
      ]);
    }
  });

  it('M1-01 AC-9 the delivery-limit broker default is 20 from 4.0 and unlimited on 3.13', () => {
    expect(
      lookup.resolution('quorum', 'delivery-limit', v('3.13.7')).brokerDefault,
    ).toEqual({ value: null });
    expect(
      lookup.resolution('quorum', 'delivery-limit', v('4.0.8')).brokerDefault,
    ).toEqual({ value: 20 });
    expect(
      lookup.resolution('quorum', 'delivery-limit', v('4.3.6')).brokerDefault,
    ).toEqual({ value: 20 });
    expect(
      lookup.resolution('quorum', 'max-length', v('4.3.6')).brokerDefault,
    ).toBeNull();
  });

  it('M1-01 AC-9 the basis says how far each row was read: 4.3 source-read, 3.13 expires source-read, the rest extrapolated', () => {
    const basis = (queueType: QueueType, key: string, version: string) =>
      lookup.resolution(queueType, key, v(version)).basis;
    expect(basis('quorum', 'max-length', '4.3.6')).toBe('source-read');
    expect(basis('quorum', 'max-length', '4.0.8')).toBe('extrapolated');
    expect(basis('quorum', 'expires', '3.13.7')).toBe('source-read');
    expect(basis('quorum', 'max-length', '3.13.7')).toBe('extrapolated');
    expect(basis('quorum', 'delivery-limit', '3.13.7')).toBe('extrapolated');
  });
});

describe('M1-01 AC-8 the W-EC warnings are data with texts', () => {
  const placeholders = (text: string): string[] =>
    [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1] ?? '');

  /** The parameters the resolver fills (README of effective-config). */
  const PARAMS = new Set([
    'key',
    'argument',
    'queueType',
    'version',
    'argumentValue',
    'userValue',
    'operatorValue',
    'policyValue',
    'policyName',
    'value',
    'rule',
    'reason',
    'candidates',
  ]);

  it('M1-01 AC-8 every warning has a text of its version under its key, and the text file has no stray entry', () => {
    for (const warning of effectiveConfig.warnings) {
      expect(warning.id).toMatch(/^W-EC-[A-Z0-9-]+$/);
      expect(warning.textKey).toBe(
        `effective-config.${warning.id}.v${String(warning.textVersion)}`,
      );
      const text = textsById[warning.id]?.[`v${String(warning.textVersion)}`];
      expect(
        typeof text,
        `${warning.textKey} is in effective-config.json`,
      ).toBe('string');
      expect((text ?? '').length).toBeGreaterThan(40);
    }
    expect(Object.keys(textsById).sort()).toEqual(
      effectiveConfig.warnings.map((warning) => warning.id).sort(),
    );
  });

  it('M1-01 AC-8 every text uses only {{name}} placeholders the resolver fills', () => {
    for (const [id, versions] of Object.entries(textsById)) {
      for (const text of Object.values(versions)) {
        expect(text.replace(/\{\{\w+\}\}/g, ''), id).not.toMatch(/[{}]/);
        for (const name of placeholders(text))
          expect(PARAMS.has(name), `${id} uses {{${name}}}`).toBe(true);
      }
    }
  });

  it('M1-01 AC-8 the wording never calls a read non-destructive, read-only or safe (DC-15)', () => {
    const banned =
      /non[-\s]?destructive|read[-\s]?only|without (?:any )?side[-\s]effects?|side[-\s]effect[-\s]free|\bsafe peek\b|without breaking|never drops/i;
    for (const [id, versions] of Object.entries(textsById)) {
      for (const text of Object.values(versions))
        expect(text, id).not.toMatch(banned);
    }
  });

  it('M1-01 AC-8 the traps carry their warning: classic overflow, 3.13 expires, the policy-wins rows, the default', () => {
    const ids = (queueType: QueueType, key: string, version: string) =>
      lookup
        .resolution(queueType, key, v(version))
        .warnings.map((entry) => `${entry.warning.id}@${entry.when}`);
    expect(ids('classic', 'overflow', '4.3.6')).toEqual([
      'W-EC-ARG-BEATS-OPERATOR@operator-and-argument',
    ]);
    expect(ids('quorum', 'expires', '3.13.7')).toEqual([
      'W-EC-POLICY-WINS-313@both-present',
    ]);
    expect(ids('quorum', 'expires', '4.0.8')).toEqual([]);
    expect(ids('quorum', 'overflow', '4.3.6')).toEqual([
      'W-EC-POLICY-WINS@both-present',
    ]);
    expect(ids('stream', 'max-age', '4.3.6')).toEqual([
      'W-EC-POLICY-WINS@both-present',
    ]);
    expect(ids('quorum', 'delivery-limit', '4.0.8')).toEqual([
      'W-EC-DEFAULT@neither-present',
    ]);
    expect(ids('quorum', 'delayed-retry-min', '4.2.9')).toEqual([
      'W-EC-UNSUPPORTED@always',
    ]);
    expect(ids('quorum', 'delayed-retry-min', '4.3.0')).toEqual([
      'W-EC-POLICY-IGNORED@policy-present',
    ]);
  });
});
