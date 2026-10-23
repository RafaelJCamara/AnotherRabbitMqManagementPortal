// Public API of this library. Export only what other projects need.
export { alternateExchangeFor, alternateExchangeOf } from './ae.ts';
export { routingKeysOf } from './cc-bcc.ts';
export type { KeyedKey, RoutingKeysOutcome } from './cc-bcc.ts';
export { DEFAULT_EXCHANGE, routeDefault } from './default-exchange.ts';
export type { DefaultRoute } from './default-exchange.ts';
export { directRule } from './direct.ts';
export { findLoops, indexTopology } from './e2e.ts';
export type { Edge, TopologyIndex } from './e2e.ts';
export { fanoutRule } from './fanout.ts';
export { simulate } from './simulate.ts';
export { headersRule, headerValuesEqual, parseXMatch } from './headers.ts';
export type { ParsedXMatch } from './headers.ts';
export {
  countHashWords,
  splitTopicKey,
  topicMatches,
  topicRule,
  topicWordsMatch,
} from './topic.ts';
export type { TopicOutcome } from './topic.ts';
export { validateBinding } from './validate-binding.ts';
export type { BindingProblem, BindingRules } from './validate-binding.ts';
export { DEFAULT_LIMITS, X_MATCH_MODES } from './types.ts';
export type {
  BindingRef,
  Fate,
  HeaderTable,
  HeaderValue,
  KeySource,
  LoopReport,
  MatchRule,
  NoteCode,
  Outcome,
  PublishInput,
  Refusal,
  RouteHop,
  RoutePath,
  RoutingKeys,
  RoutingNote,
  RoutingResult,
  RoutingTopology,
  SimulationLimits,
  TopologyBinding,
  TopologyExchange,
  TopologyQueue,
  Truncation,
  UnknownExchange,
  UnknownHint,
  XMatchMode,
} from './types.ts';
