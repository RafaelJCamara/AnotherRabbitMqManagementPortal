// Public API of this library. Export only what other projects need.
export { readDeathEntries } from './entries.ts';
export { LIMITS } from './limits.ts';
export {
  DEATH_REASONS,
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
