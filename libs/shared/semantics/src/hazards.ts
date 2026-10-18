// Known broker bugs and restrictions as data (the hazard table of the fact sheet): a rule names the
// versions it affects and, optionally, the configuration that has to be present for it to bite.
// The registry reports the ids of the rules that apply to a broker profile.
import {
  ProductSchema,
  parseVersionRange,
  rangeIncludes,
  VersionRangeTextSchema,
  type BrokerProfile,
  type Product,
  type SemVer,
} from '@app/domain-model';
import { z } from 'zod';
import { CitationSchema, RegistryDataError } from './schema.ts';

export const HazardRuleSchema = z.strictObject({
  /** Kebab-case id that receipts and the UI refer to, for example `channels-400-stats-off`. */
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  /** The rule applies when any node runs a version inside this range. */
  versions: VersionRangeTextSchema,
  /** Products it applies to; the RabbitMQ family and `unknown` when omitted. */
  products: z.array(ProductSchema).min(1).optional(),
  /** Only while statistics are disabled (true) or enabled (false). */
  statsDisabled: z.boolean().optional(),
  /** Only while this feature flag has this state. */
  featureFlag: z
    .strictObject({
      name: z.string().min(1),
      state: z.enum(['enabled', 'disabled', 'unavailable']),
    })
    .optional(),
  summary: z.string().min(1),
  citations: z.array(CitationSchema).min(1),
});
export type HazardRule = z.infer<typeof HazardRuleSchema>;

export type HazardProfile = Pick<
  BrokerProfile,
  'versions' | 'stats' | 'featureFlags' | 'product'
>;

const DEFAULT_PRODUCTS: readonly Product[] = [
  'rabbitmq',
  'tanzu-rabbitmq',
  'unknown',
];

/**
 * The version of every node, or the lowest known version when the profile lists no nodes. A null
 * entry is a node whose version could not be read.
 */
export function profileNodeVersions(
  versions: HazardProfile['versions'],
): (SemVer | null)[] {
  const perNode = Object.values(versions.perNode);
  return perNode.length > 0 ? perNode : [versions.min];
}

/** Builds the evaluator. Throws RegistryDataError for a duplicate id. */
export function buildHazards(
  rules: readonly HazardRule[],
): (profile: HazardProfile) => string[] {
  const seen = new Set<string>();
  const compiled = rules.map((rule) => {
    if (seen.has(rule.id)) {
      throw new RegistryDataError([`hazard ${rule.id} is defined twice`]);
    }
    seen.add(rule.id);
    const range = parseVersionRange(rule.versions);
    if (range === null) {
      throw new RegistryDataError([
        `hazard ${rule.id}: invalid version range ${rule.versions}`,
      ]);
    }
    return { rule, range };
  });

  return (profile) => {
    const versions = profileNodeVersions(profile.versions);
    return compiled
      .filter(({ rule, range }) => {
        if (!(rule.products ?? DEFAULT_PRODUCTS).includes(profile.product)) {
          return false;
        }
        if (
          rule.statsDisabled !== undefined &&
          rule.statsDisabled !== profile.stats.disabled
        ) {
          return false;
        }
        if (
          rule.featureFlag !== undefined &&
          profile.featureFlags[rule.featureFlag.name] !== rule.featureFlag.state
        ) {
          return false;
        }
        // A node whose version is unknown may be affected: report rather than hide the hazard.
        return versions.some(
          (version) => version === null || rangeIncludes(range, version),
        );
      })
      .map(({ rule }) => rule.id);
  };
}
