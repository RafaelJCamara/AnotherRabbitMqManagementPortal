// Capability predicates (DC-32), as data: whether the broker answers a request shape correctly, for
// example `channelsAcceptDisableStats` ("may the tool send ?disable_stats=true to /api/channels?").
// A rule holds only when the evidence says so: a node whose version cannot be read, a product the
// rule does not name and an unknown capability all answer "no" or throw. A capability is never
// granted by default (the opposite of a hazard, which is reported when it might apply).
import {
  ProductSchema,
  parseVersionRange,
  rangeIncludes,
  VersionRangeTextSchema,
  type BrokerProfile,
  type Product,
} from '@app/domain-model';
import { z } from 'zod';
import { profileNodeVersions } from './hazards.ts';
import {
  CitationSchema,
  RegistryDataError,
  SemanticsGapError,
} from './schema.ts';

export const CapabilityRuleSchema = z.strictObject({
  /** camelCase id the engine asks for, for example `channelsAcceptDisableStats`. */
  id: z.string().regex(/^[a-z][A-Za-z0-9]*$/),
  /** What holding means, in one sentence. */
  summary: z.string().min(1),
  /** The capability holds only while every node runs a version inside this range. */
  versions: VersionRangeTextSchema,
  /**
   * `always`: the version range decides. `stats-disabled`: the range matters only while
   * management statistics are disabled; with statistics on, the capability holds.
   */
  appliesWhen: z.enum(['always', 'stats-disabled']),
  /** Products the rule describes; the RabbitMQ family when omitted. `unknown` is never implied. */
  products: z.array(ProductSchema).min(1).optional(),
  citations: z.array(CitationSchema).min(1),
});
export type CapabilityRule = z.infer<typeof CapabilityRuleSchema>;

export type CapabilityProfile = Pick<
  BrokerProfile,
  'versions' | 'stats' | 'product'
>;

const DEFAULT_PRODUCTS: readonly Product[] = ['rabbitmq', 'tanzu-rabbitmq'];

/**
 * Builds the evaluator. Throws RegistryDataError for a duplicate id or an invalid range; the
 * evaluator throws SemanticsGapError for an id without a rule (fail closed).
 */
export function buildCapabilities(
  rules: readonly CapabilityRule[],
): (id: string, profile: CapabilityProfile) => boolean {
  const byId = new Map<
    string,
    {
      rule: CapabilityRule;
      range: NonNullable<ReturnType<typeof parseVersionRange>>;
    }
  >();
  for (const rule of rules) {
    if (byId.has(rule.id)) {
      throw new RegistryDataError([`capability ${rule.id} is defined twice`]);
    }
    const range = parseVersionRange(rule.versions);
    if (range === null) {
      throw new RegistryDataError([
        `capability ${rule.id}: invalid version range ${rule.versions}`,
      ]);
    }
    byId.set(rule.id, { rule, range });
  }

  return (id, profile) => {
    const entry = byId.get(id);
    if (entry === undefined) {
      throw new SemanticsGapError({ table: 'capability', id });
    }
    const { rule, range } = entry;
    if (!(rule.products ?? DEFAULT_PRODUCTS).includes(profile.product)) {
      return false;
    }
    if (rule.appliesWhen === 'stats-disabled' && !profile.stats.disabled) {
      return true;
    }
    return profileNodeVersions(profile.versions).every(
      (version) => version !== null && rangeIncludes(range, version),
    );
  };
}
