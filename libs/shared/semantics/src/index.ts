// @app/semantics: the broker semantics registry core (DC-01/02, ADR-007). Isomorphic, pure,
// trust-critical. Data tables are in `data/`; everything else here is mechanism.
import { registryData } from './data/index.ts';
import { createRegistry } from './registry.ts';

export {
  auditCells,
  REQUIREMENTS,
  type AuditFinding,
  type AuditOptions,
  type Requirement,
} from './audit.ts';
export {
  CapabilityRuleSchema,
  type CapabilityProfile,
  type CapabilityRule,
} from './capabilities.ts';
export {
  PeekCapRowSchema,
  PeekRoleSchema,
  type PeekCapRow,
  type PeekCaps,
  type PeekRole,
} from './caps.ts';
export { registryData, SEMANTICS_VERSION } from './data/index.ts';
export { settleMatrix } from './data/settle-matrix.data.ts';
export {
  isDoomed,
  type DeliveryCounters,
  type DeliveryLimit,
} from './doomed.ts';
export {
  EffectiveConfigDataSchema,
  MergeKindSchema,
  OperatorMergeRuleSchema,
  ResolutionRuleSchema,
  ResolveKindSchema,
  WarningConditionSchema,
  type EffectiveConfigData,
  type EffectiveConfigLookup,
  type MergeKind,
  type MergeOutcome,
  type OperatorMergeRule,
  type ResolutionOutcome,
  type ResolutionRule,
  type ResolveKind,
  type RowWarning,
  type WarningCondition,
} from './effective-config.ts';
export { resolveEra, type EraInputs, type EraResolution } from './era.ts';
export { GateRuleSchema, type GateProfile, type GateRule } from './gates.ts';
export {
  HazardRuleSchema,
  type HazardProfile,
  type HazardRule,
} from './hazards.ts';
export {
  PresetIdSchema,
  presetIdFor,
  ProviderPresetSchema,
  SUPPORT_AREAS,
  SupportLevelSchema,
  type PresetId,
  type PresetTarget,
  type ProviderPreset,
  type ResolvedPreset,
  type SupportArea,
  type SupportLevel,
} from './provider-presets.ts';
export {
  createRegistry,
  RegistryDataSchema,
  validateRegistryData,
  type BrokerSemanticsRegistry,
  type RegistryData,
} from './registry.ts';
export {
  cellKeyString,
  CellKeySchema,
  CellStatusSchema,
  CitationSchema,
  DelayedRetrySchema,
  EVIDENCE_PATH,
  EvidencePathSchema,
  LimitStateSchema,
  ProtocolSchema,
  RegistryDataError,
  SemanticsCellSchema,
  SemanticsGapError,
  SettleActionSchema,
  SettleEffectSchema,
  type CellKey,
  type CellStatus,
  type Citation,
  type DelayedRetry,
  type GapKey,
  type LimitState,
  type Protocol,
  type SemanticsCell,
  type SettleAction,
  type SettleEffect,
  type TableKey,
} from './schema.ts';
export {
  TapRuleSchema,
  UNKNOWN_EXCHANGE_TYPE,
  type TapRule,
  type TapRuleOutcome,
} from './tap-rules.ts';
export { WarningDefSchema } from './warnings.ts';

/** The registry this release ships, built (and so validated) when the module loads. */
export const semanticsRegistry = createRegistry(registryData);
