// Capability gates (DC-32): whether a feature is available on this broker, as data. A rule lists the
// conditions under which the feature is open; anything else is closed, with the rule's reason. The
// engine computes `gates` for a profile and the UI only renders them.
import type { GateDecision } from '@app/contracts';
import { FeatureIdSchema, type FeatureId } from '@app/contracts';
import {
  ProductSchema,
  parseVersionRange,
  rangeIncludes,
  VersionRangeTextSchema,
} from '@app/domain-model';
import { z } from 'zod';
import { profileNodeVersions, type HazardProfile } from './hazards.ts';
import { RegistryDataError, SemanticsGapError } from './schema.ts';

export const GateRuleSchema = z.strictObject({
  feature: FeatureIdSchema,
  /** Open only while every node runs a version inside this range (an unreadable one closes it). */
  versions: VersionRangeTextSchema.optional(),
  /** Open only for these products. */
  products: z.array(ProductSchema).min(1).optional(),
  /** Feature flags that must all be `enabled`. */
  featureFlags: z.array(z.string().min(1)).optional(),
  /** Closed while statistics are disabled. */
  requiresStats: z.boolean().optional(),
  /** Why the feature is closed, shown to the user. */
  reason: z.string().min(1),
  /** Where the rule comes from, for example a fact sheet row or an issue. */
  source: z.string().min(1).optional(),
});
export type GateRule = z.infer<typeof GateRuleSchema>;

export type GateProfile = HazardProfile;

function isOpen(
  rule: GateRule,
  range: ReturnType<typeof parseVersionRange>,
  profile: GateProfile,
): boolean {
  if (rule.products !== undefined && !rule.products.includes(profile.product)) {
    return false;
  }
  if (rule.requiresStats === true && profile.stats.disabled) return false;
  for (const flag of rule.featureFlags ?? []) {
    if (profile.featureFlags[flag] !== 'enabled') return false;
  }
  if (range !== null) {
    return profileNodeVersions(profile.versions).every(
      (version) => version !== null && rangeIncludes(range, version),
    );
  }
  return true;
}

/**
 * Builds the evaluator. A feature without a rule throws SemanticsGapError (fail closed): the
 * caller decides what a missing rule means, the registry never invents an answer.
 */
export function buildGates(
  rules: readonly GateRule[],
): (feature: FeatureId, profile: GateProfile) => GateDecision {
  const byFeature = new Map<string, GateRule>();
  for (const rule of rules) {
    if (byFeature.has(rule.feature)) {
      throw new RegistryDataError([`gate ${rule.feature} is defined twice`]);
    }
    if (
      rule.versions !== undefined &&
      parseVersionRange(rule.versions) === null
    ) {
      throw new RegistryDataError([
        `gate ${rule.feature}: invalid version range ${rule.versions}`,
      ]);
    }
    byFeature.set(rule.feature, rule);
  }

  return (feature, profile) => {
    const rule = byFeature.get(feature);
    if (rule === undefined) {
      throw new SemanticsGapError({ table: 'gate', id: feature });
    }
    const range =
      rule.versions === undefined ? null : parseVersionRange(rule.versions);
    const source = rule.source === undefined ? {} : { source: rule.source };
    return isOpen(rule, range, profile)
      ? { enabled: true, mode: 'full', ...source }
      : { enabled: false, reason: rule.reason, ...source };
  };
}
