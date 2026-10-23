// Public API of this library. Export only what other projects need.
export { INTERPRETED_CAPABILITY, deathContext } from './context.ts';
export { readDeathEntries } from './entries.ts';
export { LIMITS } from './limits.ts';
export { normalizeDeaths } from './normalize.ts';
export { REPLAY_STAMPS, REPUBLISH_MARKERS } from './trust.ts';
export {
  DEATH_REASONS,
  type Counter,
  type DeathContext,
  type DeathCounters,
  type DeathHistory,
  type DeathSummary,
  type DeathTrust,
  type TrustReason,
  type TrustState,
  type DeathEntry,
  type DeathMessage,
  type DeathProtocol,
  type DeathReason,
  type DeathSource,
  type EntriesResult,
  type EntryFlag,
  type HistoryFlag,
  type HistoryState,
  type OrderBasis,
  type Truncation,
} from './types.ts';
