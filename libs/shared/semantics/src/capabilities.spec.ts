import { describe, expect, it } from 'vitest';
import {
  buildCapabilities,
  CapabilityRuleSchema,
  type CapabilityRule,
} from './capabilities.ts';
import { RegistryDataError, SemanticsGapError } from './schema.ts';
import { profile } from './testing/profile.ts';

const rule = (overrides: Partial<CapabilityRule> = {}): CapabilityRule => ({
  id: 'canDoIt',
  summary: 'The broker can do it.',
  versions: '>=4.0.0 <4.2.0',
  appliesWhen: 'always',
  citations: [{ kind: 'D', ref: 'test' }],
  ...overrides,
});

describe('capability evaluator', () => {
  it('holds only inside the range, at both ends', () => {
    const can = buildCapabilities([rule()]);

    expect(can('canDoIt', profile('3.13.7'))).toBe(false);
    expect(can('canDoIt', profile('4.0.0'))).toBe(true);
    expect(can('canDoIt', profile('4.1.9'))).toBe(true);
    expect(can('canDoIt', profile('4.2.0'))).toBe(false);
  });

  it('stats-disabled rules hold with statistics on and follow the range with statistics off', () => {
    const can = buildCapabilities([rule({ appliesWhen: 'stats-disabled' })]);

    expect(can('canDoIt', profile('3.13.7'))).toBe(true);
    expect(can('canDoIt', profile('3.13.7', { statsOff: true }))).toBe(false);
    expect(can('canDoIt', profile('4.1.0', { statsOff: true }))).toBe(true);
  });

  it('without a products list the RabbitMQ family qualifies and `unknown` does not', () => {
    const can = buildCapabilities([rule()]);

    expect(can('canDoIt', profile('4.1.0', { product: 'rabbitmq' }))).toBe(
      true,
    );
    expect(
      can('canDoIt', profile('4.1.0', { product: 'tanzu-rabbitmq' })),
    ).toBe(true);
    expect(can('canDoIt', profile('4.1.0', { product: 'unknown' }))).toBe(
      false,
    );
    expect(can('canDoIt', profile('4.1.0', { product: 'lavinmq' }))).toBe(
      false,
    );
  });

  it('a products list replaces the default, and the product check also applies to stats-disabled rules', () => {
    const can = buildCapabilities([
      rule({ products: ['lavinmq'], appliesWhen: 'stats-disabled' }),
    ]);

    expect(can('canDoIt', profile('4.1.0', { product: 'lavinmq' }))).toBe(true);
    expect(can('canDoIt', profile('4.1.0', { product: 'rabbitmq' }))).toBe(
      false,
    );
  });

  it('uses the lowest known version when the profile lists no nodes, and fails closed without one', () => {
    const can = buildCapabilities([rule()]);
    const noNodes = (min: string | null) => {
      const base = profile('4.1.0');
      return {
        ...base,
        versions: {
          ...base.versions,
          perNode: {},
          min: min === null ? null : (profile(min).versions.min ?? null),
        },
      };
    };

    expect(can('canDoIt', noNodes('4.1.0'))).toBe(true);
    expect(can('canDoIt', noNodes('4.2.0'))).toBe(false);
    expect(can('canDoIt', noNodes(null))).toBe(false);
  });

  it('an unknown id is a gap that names the table and the id', () => {
    const can = buildCapabilities([rule()]);

    try {
      can('nope', profile('4.1.0'));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SemanticsGapError);
      expect((error as SemanticsGapError).key).toEqual({
        table: 'capability',
        id: 'nope',
      });
    }
  });

  it('rejects a duplicate id and an invalid range when built', () => {
    expect(() => buildCapabilities([rule(), rule()])).toThrow(
      RegistryDataError,
    );
    expect(() => buildCapabilities([rule({ versions: '^4' })])).toThrow(
      RegistryDataError,
    );
  });

  it('the schema requires a citation, a valid range and a camelCase id', () => {
    expect(CapabilityRuleSchema.safeParse(rule()).success).toBe(true);
    expect(
      CapabilityRuleSchema.safeParse(rule({ citations: [] })).success,
    ).toBe(false);
    expect(
      CapabilityRuleSchema.safeParse(rule({ versions: '??' })).success,
    ).toBe(false);
    expect(CapabilityRuleSchema.safeParse(rule({ id: 'Bad-Id' })).success).toBe(
      false,
    );
    expect(
      CapabilityRuleSchema.safeParse({ ...rule(), extra: 1 }).success,
    ).toBe(false);
  });
});
