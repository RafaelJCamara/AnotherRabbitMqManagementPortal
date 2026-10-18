// Tap rules (blueprint 5.8, fact sheet c.1): per exchange type, whether a tap queue or an
// exchange-to-exchange tap diverts traffic from the real consumers, whether the e2e mode is
// allowed, and whether the planner refuses the tap unless the user accepts the diversion.
import {
  parseVersionRange,
  rangeIncludes,
  VersionRangeTextSchema,
  type SemVer,
} from '@app/domain-model';
import { z } from 'zod';
import { RegistryDataError } from './schema.ts';

const OverrideSchema = z.strictObject({
  /** The override applies when the broker version is inside this range. */
  versions: VersionRangeTextSchema,
  diverts: z.boolean().optional(),
  e2eAllowed: z.boolean().optional(),
  refuseByDefault: z.boolean().optional(),
});

export const TapRuleSchema = z.strictObject({
  exchangeType: z.string().min(1),
  /**
   * The conservative baseline. It is the answer for an unknown version, so write it for the
   * worst version; `overrides` relax it for versions known to behave better.
   */
  diverts: z.boolean(),
  e2eAllowed: z.boolean(),
  refuseByDefault: z.boolean(),
  /** The first override whose range contains the version is applied over the baseline. */
  overrides: z.array(OverrideSchema).optional(),
});
export type TapRule = z.infer<typeof TapRuleSchema>;

export interface TapRuleOutcome {
  readonly diverts: boolean;
  readonly e2eAllowed: boolean;
  readonly refuseByDefault: boolean;
}

/**
 * What an exchange type nobody has described gets: refused, assumed to divert, no e2e. This is
 * the stated rule for unknown types (blueprint 5.8), not a silent default.
 */
export const UNKNOWN_EXCHANGE_TYPE: TapRuleOutcome = {
  diverts: true,
  e2eAllowed: false,
  refuseByDefault: true,
};

/** Builds the lookup. Throws RegistryDataError for a duplicate type or an invalid range. */
export function buildTapRules(
  rules: readonly TapRule[],
): (exchangeType: string, version: SemVer | null) => TapRuleOutcome {
  const byType = new Map<
    string,
    { rule: TapRule; ranges: ReturnType<typeof parseVersionRange>[] }
  >();
  for (const rule of rules) {
    if (byType.has(rule.exchangeType)) {
      throw new RegistryDataError([
        `tap rule ${rule.exchangeType} is defined twice`,
      ]);
    }
    const ranges = (rule.overrides ?? []).map((override) => {
      const range = parseVersionRange(override.versions);
      if (range === null) {
        throw new RegistryDataError([
          `tap rule ${rule.exchangeType}: invalid version range ${override.versions}`,
        ]);
      }
      return range;
    });
    byType.set(rule.exchangeType, { rule, ranges });
  }

  return (exchangeType, version) => {
    const entry = byType.get(exchangeType);
    if (entry === undefined) return UNKNOWN_EXCHANGE_TYPE;
    const { rule, ranges } = entry;
    const index =
      version === null
        ? -1
        : ranges.findIndex(
            (range) => range !== null && rangeIncludes(range, version),
          );
    const override = index < 0 ? undefined : rule.overrides?.[index];
    return {
      diverts: override?.diverts ?? rule.diverts,
      e2eAllowed: override?.e2eAllowed ?? rule.e2eAllowed,
      refuseByDefault: override?.refuseByDefault ?? rule.refuseByDefault,
    };
  };
}
