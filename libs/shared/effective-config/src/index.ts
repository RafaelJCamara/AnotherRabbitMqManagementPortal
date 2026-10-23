// @app/effective-config: the pure effective-config resolver (DC-30, POL-01). Isomorphic,
// trust-critical. The rules are registry data (`@app/semantics`, `registry.effectiveConfig`); this
// package is the mechanism.
export {
  MAX_CANDIDATES,
  matchPolicy,
  resolveHypothetical,
} from './hypothetical.ts';
export type {
  HypotheticalInput,
  HypotheticalResult,
  MatchView,
  PolicyDefinition,
  PolicyMatch,
  PolicyTarget,
  UncertainPolicy,
} from './hypothetical.ts';
export { combine, mergeDetails, mergeOperator } from './merge-operator.ts';
export type { MergeDetail, PolicyLayer } from './merge-operator.ts';
export {
  describeValue,
  parseResolveInput,
  ResolveInputSchema,
} from './model.ts';
export type {
  EffectiveConfig,
  EffectiveEntry,
  EffectiveWarning,
  EntryStatus,
  Layer,
  MergedEntry,
  MergedPolicy,
  ParsedResolveInput,
  PolicyInput,
  PolicyValue,
  ProvenanceEntry,
  ResolveInput,
  Role,
} from './model.ts';
export { patternProblem, testPattern } from './pattern.ts';
export type { PatternResult } from './pattern.ts';
export { resolveEffective } from './resolve.ts';
