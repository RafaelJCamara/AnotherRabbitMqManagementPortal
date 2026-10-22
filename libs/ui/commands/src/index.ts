// Public API of this library. Export only what other projects need.
export { Announcer, type Announcement, type AnnounceParams } from './announcer';
export {
  COMMAND_CAPABILITIES,
  NO_CAPABILITIES,
  availabilityOf,
  type Availability,
  type CapabilitySnapshot,
  type DisabledReason,
} from './availability';
export {
  CHORD_MAX_CHARS,
  acceleratorOf,
  canonicalChord,
  displayChord,
  formatChord,
  matchesChord,
  parseChord,
  physicalChord,
  type Chord,
  type KeyEventLike,
  type Platform,
} from './chord';
export type {
  CommandDefinition,
  CommandMenu,
  ExecuteOutcome,
  ListedCommand,
  MenuName,
} from './command';
export {
  CommandContext,
  type ContextGetter,
  type ContextValue,
} from './context';
export {
  PALETTE_LIMIT,
  rankCommands,
  toRanges,
  type Rankable,
  type Ranked,
  type Range,
} from './fuzzy';
export {
  blockedChords,
  bindingTable,
  defaultChords,
  effectiveChords,
  findConflicts,
  planAssign,
  withUnbound,
  withoutOverride,
  type AssignResult,
  type ChordOwner,
  type ChordSet,
  type KeybindingOverrides,
  type KeymapConflict,
} from './keymap';
export {
  buildMenuModel,
  syncNativeMenu,
  type MenuCommandItem,
  type MenuItem,
  type MenuModel,
  type NativeMenuHost,
} from './menu-model';
export {
  COMMAND_ID,
  COMMAND_PLATFORM,
  CommandRegistry,
  Keymap,
  registerCommands,
} from './registry';
export {
  RESERVED_CHORDS,
  reservedCollisions,
  reservedReason,
  type ReservedKind,
  type ReservedReason,
} from './reserved';
