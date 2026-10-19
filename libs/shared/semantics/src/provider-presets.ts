// Provider presets (fact sheet j.1, blueprint 5.2 and 5.3): what a managed or restricted broker is
// known to limit or lack, before the probe has measured anything. A preset is a starting point for
// budgets and gates, never proof of what the broker does: a probe result outranks it, and a
// preset can only be as strong as the provider documentation it cites. Every provider and every
// non-RabbitMQ product has one, so a lookup has no gap; `unknown` is the preset that assumes
// nothing.
import {
  ProviderSchema,
  parseVersionRange,
  rangeIncludes,
  VersionRangeTextSchema,
  type BrokerProfile,
  type SemVer,
} from '@app/domain-model';
import { z } from 'zod';
import {
  CitationSchema,
  RegistryDataError,
  SemanticsGapError,
} from './schema.ts';

/** A preset is for a provider (where the broker runs) or a product that is not RabbitMQ. */
export const PresetIdSchema = z.enum([
  ...ProviderSchema.options,
  'lavinmq',
  'apsaramq',
]);
export type PresetId = z.infer<typeof PresetIdSchema>;

/** S supported, P partial, C needs configuration or opt-in, B blocked, U unknown until probed. */
export const SupportLevelSchema = z.enum([
  'supported',
  'partial',
  'config',
  'blocked',
  'probe',
]);
export type SupportLevel = z.infer<typeof SupportLevelSchema>;

export const SUPPORT_AREAS = [
  'peek',
  'tap',
  'firehose',
  'eventExchange',
  'prometheus',
  'streams',
  'shovels',
  'definitions',
  'operatorPolicyEdit',
  'oauth2',
] as const;
export type SupportArea = (typeof SUPPORT_AREAS)[number];

const SupportShape = Object.fromEntries(
  SUPPORT_AREAS.map((area) => [area, SupportLevelSchema]),
) as Record<SupportArea, typeof SupportLevelSchema>;
const SupportSchema = z.strictObject(SupportShape);
const SupportOverrideSchema = z.strictObject(
  Object.fromEntries(
    SUPPORT_AREAS.map((area) => [area, SupportLevelSchema.optional()]),
  ) as Record<SupportArea, z.ZodOptional<typeof SupportLevelSchema>>,
);

const positiveInt = z.number().int().positive();

export const ProviderPresetSchema = z.strictObject({
  id: PresetIdSchema,
  summary: z.string().min(1),
  /** Host-name globs that identify the provider (fact sheet j.2 step 2); `*` is one or more characters. */
  hostPatterns: z.array(z.string().min(1)),
  /** Documented limits, on the same fields as `BrokerProfile.limits`. A measured value wins. */
  limits: z.strictObject({
    connectionMax: positiveInt.optional(),
    channelMax: positiveInt.optional(),
    consumersPerChannelMax: positiveInt.optional(),
    maxMessageBytes: positiveInt.optional(),
  }),
  /** The tool's own connection budget on a tight plan (amendment A-10); the default applies when absent. */
  toolConnectionBudget: positiveInt.optional(),
  prometheus: z.strictObject({
    perObjectAllowed: z.boolean().optional(),
    minIntervalSec: z.number().positive().optional(),
    ports: z.array(positiveInt).optional(),
  }),
  /** Objects the provider owns: shown, never edited or deleted (DC-54). */
  ownedObjects: z.array(
    z.strictObject({
      kind: z.enum(['policy', 'operator-policy', 'user']),
      pattern: z.string().min(1),
    }),
  ),
  /** True when taps must declare `x-overflow=drop-head` so a default reject-publish policy cannot reach them. */
  tapNeedsExplicitOverflow: z.boolean(),
  /**
   * How the HTTP `/get` route settles: LavinMQ needs the explicit `requeue` flag (DC-55);
   * `unknown` means the tool does not use the route until a probe says otherwise.
   */
  httpGet: z.enum(['standard', 'explicit-requeue-flag', 'unknown']),
  support: SupportSchema,
  /** Per-version corrections to `support`, for providers whose plan differs by broker version. */
  overrides: z
    .array(
      z.strictObject({
        versions: VersionRangeTextSchema,
        support: SupportOverrideSchema,
      }),
    )
    .optional(),
  citations: z.array(CitationSchema).min(1),
});
export type ProviderPreset = z.infer<typeof ProviderPresetSchema>;

/** A preset with the per-version corrections applied for one broker version. */
export interface ResolvedPreset extends Omit<ProviderPreset, 'overrides'> {
  readonly support: Readonly<Record<SupportArea, SupportLevel>>;
}

export type PresetTarget = Pick<BrokerProfile, 'provider' | 'product'>;

/** The preset id a profile uses: the product when it is not RabbitMQ, else the provider. */
export function presetIdFor(target: PresetTarget): PresetId {
  if (target.product === 'lavinmq' || target.product === 'apsaramq') {
    return target.product;
  }
  return target.provider;
}

/** One per-version correction with its range parsed. */
interface Correction {
  readonly range: NonNullable<ReturnType<typeof parseVersionRange>>;
  readonly support: NonNullable<ProviderPreset['overrides']>[number]['support'];
}

/**
 * Builds the lookup. Throws RegistryDataError for a duplicate id, an invalid range, or a table
 * that leaves a provider or a non-RabbitMQ product without a preset (so a lookup cannot gap).
 * `version` selects the per-version corrections; with no version (null) none apply, which keeps
 * the base level.
 */
export function buildProviderPresets(
  presets: readonly ProviderPreset[],
): (target: PresetTarget, version: SemVer | null) => ResolvedPreset {
  const byId = new Map<
    PresetId,
    { preset: Omit<ProviderPreset, 'overrides'>; corrections: Correction[] }
  >();
  const problems: string[] = [];
  for (const preset of presets) {
    if (byId.has(preset.id)) {
      problems.push(`provider preset ${preset.id} is defined twice`);
      continue;
    }
    const { overrides, ...withoutOverrides } = preset;
    const corrections: Correction[] = [];
    for (const override of overrides ?? []) {
      const range = parseVersionRange(override.versions);
      if (range === null) {
        problems.push(
          `provider preset ${preset.id}: invalid version range ${override.versions}`,
        );
      } else {
        corrections.push({ range, support: override.support });
      }
    }
    byId.set(preset.id, { preset: withoutOverrides, corrections });
  }
  if (presets.length > 0) {
    for (const id of PresetIdSchema.options) {
      if (!byId.has(id)) problems.push(`provider preset ${id} is missing`);
    }
  }
  if (problems.length > 0) throw new RegistryDataError(problems);

  return (target, version) => {
    const id = presetIdFor(target);
    const entry = byId.get(id);
    if (entry === undefined) {
      throw new SemanticsGapError({ table: 'provider-preset', id });
    }
    const support: Record<SupportArea, SupportLevel> = {
      ...entry.preset.support,
    };
    if (version !== null) {
      for (const correction of entry.corrections) {
        if (!rangeIncludes(correction.range, version)) continue;
        for (const area of SUPPORT_AREAS) {
          const level = correction.support[area];
          if (level !== undefined) support[area] = level;
        }
      }
    }
    return { ...entry.preset, support };
  };
}
