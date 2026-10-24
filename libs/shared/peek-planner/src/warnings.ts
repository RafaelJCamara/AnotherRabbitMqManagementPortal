// Warnings of a plan (R10): codes with versioned text keys, never prose. The 16 warnings of fact
// sheet b.8 come from the registry (`registry.warning`), so their severity is the registry's. Four
// more are owned by the planner (OQ-1425): the registry has no way to say "the evidence is
// incomplete" or "the limit is unknown" without a text that would be false, and adding to the
// b.8 set is an RFC. A follow-up moves them into the registry.
import {
  WarningIdSchema,
  type WarningId,
  type WarningRef,
} from '@app/contracts';
import { TEXT_SCOPE, TEXT_VERSION } from './rejections.ts';
import type { PlannerRegistry } from './types.ts';

export const PLANNER_WARNING_IDS = [
  'W-BROKER-UNVERIFIED',
  'W-DLX-UNVERIFIED',
  'W-LIMIT-UNKNOWN',
  'W-SEMANTICS-GAP',
] as const;
export type PlannerWarningId = (typeof PLANNER_WARNING_IDS)[number];

const plannerOwned: ReadonlySet<string> = new Set(PLANNER_WARNING_IDS);

const warningId = (id: PlannerWarningId): WarningId =>
  WarningIdSchema.parse(id);

/** A planner-owned warning: always a consent, because each one asks a person to accept a doubt. */
export function plannerWarning(id: PlannerWarningId): WarningRef {
  return {
    id: warningId(id),
    severity: 'consent',
    textKey: `${TEXT_SCOPE}.warnings.${id}.v${String(TEXT_VERSION)}`,
    textVersion: TEXT_VERSION,
  };
}

/**
 * The warning for an id: the planner's own, or the registry's. A registry id without an entry
 * throws `SemanticsGapError` (the caller handles it as a gap, R12).
 */
export function warningRef(registry: PlannerRegistry, id: string): WarningRef {
  if (plannerOwned.has(id)) return plannerWarning(id as PlannerWarningId);
  return registry.warning(WarningIdSchema.parse(id));
}

const compareText = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/** One entry per id, sorted by id, so that two runs agree and a warning is never listed twice. */
export function sortWarnings(list: readonly WarningRef[]): WarningRef[] {
  const byId = new Map<string, WarningRef>();
  for (const warning of list)
    if (!byId.has(warning.id)) byId.set(warning.id, warning);
  return [...byId.values()].sort((a, b) => compareText(a.id, b.id));
}

/** The consent ids a list of warnings asks for: each `consent` warning adds its own id. */
export function consentIds(
  list: readonly WarningRef[],
  extra: readonly string[] = [],
): string[] {
  const ids = new Set<string>(extra);
  for (const warning of list)
    if (warning.severity === 'consent') ids.add(warning.id);
  return [...ids].sort(compareText);
}
