// The registry (DC-01/02, ADR-007): typed data in, a fail-closed lookup interface out. The data is
// validated with zod when the registry is built, so a bad data file fails the build and the tests
// instead of producing a wrong answer at run time. Lookups never fall back to a default: a missing
// entry throws SemanticsGapError and the caller handles it conservatively.
import {
  WarningRefSchema,
  type FeatureId,
  type GateDecision,
  type WarningId,
  type WarningRef,
} from '@app/contracts';
import type { Era, QueueType, SemVer, Verification } from '@app/domain-model';
import { z } from 'zod';
import { auditCells } from './audit.ts';
import {
  buildPeekCaps,
  PeekCapRowSchema,
  type PeekCaps,
  type PeekRole,
} from './caps.ts';
import {
  isDoomed,
  type DeliveryCounters,
  type DeliveryLimit,
} from './doomed.ts';
import { resolveEra, type EraInputs, type EraResolution } from './era.ts';
import { buildGates, GateRuleSchema, type GateProfile } from './gates.ts';
import {
  buildHazards,
  HazardRuleSchema,
  type HazardProfile,
} from './hazards.ts';
import {
  cellKeyString,
  RegistryDataError,
  SemanticsCellSchema,
  SemanticsGapError,
  type CellKey,
  type SemanticsCell,
} from './schema.ts';
import {
  buildTapRules,
  TapRuleSchema,
  type TapRuleOutcome,
} from './tap-rules.ts';
import { buildWarnings } from './warnings.ts';

export const RegistryDataSchema = z.strictObject({
  /** Stamped on every receipt, for example `sem-2026.10.1`. */
  version: z.string().regex(/^sem-\d{4}\.\d{2}\.\d+$/),
  cells: z.array(SemanticsCellSchema),
  warnings: z.array(WarningRefSchema),
  hazards: z.array(HazardRuleSchema),
  gates: z.array(GateRuleSchema),
  peekCaps: z.array(PeekCapRowSchema),
  tapRules: z.array(TapRuleSchema),
});
export type RegistryData = z.infer<typeof RegistryDataSchema>;

/** The lookups the engine uses (core-interfaces.md, `BrokerSemanticsRegistry`). */
export interface BrokerSemanticsRegistry {
  readonly version: string;
  resolveEra(input: EraInputs): EraResolution;
  /** Throws SemanticsGapError for a key without a usable cell. */
  cell(key: CellKey): SemanticsCell;
  isDoomed(era: Era, counters: DeliveryCounters, limit: DeliveryLimit): boolean;
  /** Throws SemanticsGapError for an unknown warning id. */
  warning(id: WarningId): WarningRef;
  hazards(profile: HazardProfile): string[];
  /** Throws SemanticsGapError for a feature without a gate rule. */
  gate(feature: FeatureId, profile: GateProfile): GateDecision;
  /** Throws SemanticsGapError when the table has no row. */
  peekCaps(
    era: Era,
    queueType: QueueType,
    role: PeekRole,
    verification: Verification,
  ): PeekCaps;
  tapRule(exchangeType: string, version: SemVer | null): TapRuleOutcome;
}

/**
 * Every problem in the data, or an empty list: schema violations, duplicates in any table and
 * the structural cell rules of the audit. `createRegistry` throws when this is not empty.
 */
export function validateRegistryData(input: unknown): string[] {
  const parsed = RegistryDataSchema.safeParse(input);
  if (!parsed.success) {
    return parsed.error.issues.map(
      (issue) =>
        `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
    );
  }
  const data = parsed.data;
  const problems = auditCells(data.cells).map(
    (finding) => `cell ${finding.cell}: ${finding.message}`,
  );
  const builders: (() => unknown)[] = [
    () => buildWarnings(data.warnings),
    () => buildHazards(data.hazards),
    () => buildGates(data.gates),
    () => buildPeekCaps(data.peekCaps),
    () => buildTapRules(data.tapRules),
  ];
  for (const build of builders) {
    try {
      build();
    } catch (error) {
      if (error instanceof RegistryDataError) problems.push(...error.problems);
      else throw error;
    }
  }
  return problems;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Builds the registry from data. Throws RegistryDataError when the data is invalid. The returned
 * cells are frozen: a caller cannot change what the next lookup answers.
 */
export function createRegistry(input: RegistryData): BrokerSemanticsRegistry {
  const problems = validateRegistryData(input);
  if (problems.length > 0) throw new RegistryDataError(problems);
  const data = deepFreeze(RegistryDataSchema.parse(input));

  const cells = new Map<string, SemanticsCell>();
  for (const cell of data.cells) cells.set(cellKeyString(cell.key), cell);

  const warning = buildWarnings(data.warnings);
  const hazards = buildHazards(data.hazards);
  const gate = buildGates(data.gates);
  const peekCaps = buildPeekCaps(data.peekCaps);
  const tapRule = buildTapRules(data.tapRules);

  return {
    version: data.version,
    resolveEra,
    cell(key) {
      const cell = cells.get(cellKeyString(key));
      if (cell === undefined) throw new SemanticsGapError(key);
      // A cell without a derived effect, or one the lab contradicted, is not an answer.
      if (cell.effect === null) {
        throw new SemanticsGapError(key, 'the effect is not derived yet');
      }
      if (cell.status === 'lab-contradicted') {
        throw new SemanticsGapError(key, 'the lab contradicted this cell');
      }
      return cell;
    },
    isDoomed,
    warning,
    hazards,
    gate,
    peekCaps,
    tapRule,
  };
}
