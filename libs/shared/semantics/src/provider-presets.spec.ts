import { describe, expect, it } from 'vitest';
import { providerPresets } from './data/provider-presets.data.ts';
import {
  buildProviderPresets,
  presetIdFor,
  ProviderPresetSchema,
  type ProviderPreset,
} from './provider-presets.ts';
import { RegistryDataError, SemanticsGapError } from './schema.ts';
import { v } from './testing/profile.ts';

const base = providerPresets.find((entry) => entry.id === 'amazon-mq');
if (base === undefined) throw new Error('test setup: no amazon-mq preset');

const withOverrides = (
  overrides: ProviderPreset['overrides'],
): ProviderPreset[] =>
  providerPresets.map((entry) =>
    entry.id === 'amazon-mq' ? { ...entry, overrides } : entry,
  );

describe('provider preset lookup', () => {
  it('an empty table answers every lookup with a gap that names the table and the id', () => {
    const lookup = buildProviderPresets([]);

    try {
      lookup({ provider: 'amazon-mq', product: 'rabbitmq' }, null);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SemanticsGapError);
      expect((error as SemanticsGapError).key).toEqual({
        table: 'provider-preset',
        id: 'amazon-mq',
      });
    }
  });

  it('a table that leaves a provider without a preset is invalid', () => {
    const partial = providerPresets.filter((entry) => entry.id !== 'ibm');

    expect(() => buildProviderPresets(partial)).toThrow(RegistryDataError);
    expect(() => buildProviderPresets(partial)).toThrow(/ibm is missing/);
  });

  it('a duplicate preset and an invalid override range are invalid', () => {
    expect(() => buildProviderPresets([...providerPresets, base])).toThrow(
      /defined twice/,
    );
    expect(() =>
      buildProviderPresets(
        withOverrides([{ versions: '^4', support: { tap: 'blocked' } }]),
      ),
    ).toThrow(/invalid version range/);
  });

  it('overrides apply in order, a later one wins, and only the named areas change', () => {
    const lookup = buildProviderPresets(
      withOverrides([
        { versions: '>=4.0.0', support: { tap: 'blocked', peek: 'partial' } },
        { versions: '>=4.2.0', support: { tap: 'supported' } },
      ]),
    );
    const at = (version: string) =>
      lookup({ provider: 'amazon-mq', product: 'rabbitmq' }, v(version))
        .support;

    expect(at('3.13.7')).toEqual(base.support);
    expect(at('4.1.0')).toEqual({
      ...base.support,
      tap: 'blocked',
      peek: 'partial',
    });
    expect(at('4.2.0')).toEqual({
      ...base.support,
      tap: 'supported',
      peek: 'partial',
    });
  });

  it('the resolved preset carries no override list and does not change the table', () => {
    const lookup = buildProviderPresets(providerPresets);
    const resolved = lookup(
      { provider: 'amazon-mq', product: 'rabbitmq' },
      v('4.3.6'),
    );

    expect('overrides' in resolved).toBe(false);
    expect(base.support.prometheus).toBe('blocked');
    expect(resolved.support.prometheus).toBe('supported');
  });

  it('the schema rejects an unknown preset id, a non-positive limit, a missing citation and extra keys', () => {
    expect(ProviderPresetSchema.safeParse(base).success).toBe(true);
    expect(
      ProviderPresetSchema.safeParse({ ...base, id: 'oracle-mq' }).success,
    ).toBe(false);
    expect(
      ProviderPresetSchema.safeParse({ ...base, limits: { channelMax: 0 } })
        .success,
    ).toBe(false);
    expect(
      ProviderPresetSchema.safeParse({ ...base, citations: [] }).success,
    ).toBe(false);
    expect(
      ProviderPresetSchema.safeParse({ ...base, extra: true }).success,
    ).toBe(false);
    expect(
      ProviderPresetSchema.safeParse({
        ...base,
        support: { ...base.support, peek: 'great' },
      }).success,
    ).toBe(false);
  });

  it('presetIdFor ignores a product that is RabbitMQ or unknown', () => {
    expect(presetIdFor({ provider: 'ibm', product: 'rabbitmq' })).toBe('ibm');
    expect(presetIdFor({ provider: 'ibm', product: 'unknown' })).toBe('ibm');
    expect(presetIdFor({ provider: 'ibm', product: 'apsaramq' })).toBe(
      'apsaramq',
    );
  });
});
