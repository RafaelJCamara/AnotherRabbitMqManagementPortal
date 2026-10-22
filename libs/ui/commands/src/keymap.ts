// The keymap (M1-41, R6): the chords in force are the person's override when there is one and the
// command's defaults otherwise. Everything here is plain functions over plain data, so the rules can be
// proved without a DOM: what is in force, what conflicts (never silently), and what an assignment does.
import { KEYBINDINGS_MAX } from '@app/contracts';

import { canonicalChord, parseChord } from './chord';
import { reservedReason, type ReservedReason } from './reserved';

/** A command id to a chord, or to `null` for "unbound": the document `keybindings.get` and `put` keep. */
export type KeybindingOverrides = Readonly<Record<string, string | null>>;

export interface ChordSet {
  /** Canonical chord text. */
  readonly chords: readonly string[];
  /** `user`: the person's override (an empty list is "unbound by the person"); `none`: nothing is bound. */
  readonly source: 'default' | 'user' | 'none';
}

/** The default chords of a command as canonical text; a default that does not parse is dropped (a test fails it). */
export function defaultChords(
  keybinding: string | readonly string[] | undefined,
): readonly string[] {
  const list =
    keybinding === undefined
      ? []
      : typeof keybinding === 'string'
        ? [keybinding]
        : keybinding;
  return list.flatMap((text) => {
    const canonical = canonicalChord(text);
    return canonical === null ? [] : [canonical];
  });
}

export function effectiveChords(
  id: string,
  defaults: readonly string[],
  overrides: KeybindingOverrides,
): ChordSet {
  if (Object.hasOwn(overrides, id)) {
    const value = overrides[id];
    const canonical = typeof value === 'string' ? canonicalChord(value) : null;
    return { chords: canonical === null ? [] : [canonical], source: 'user' };
  }
  return { chords: defaults, source: defaults.length > 0 ? 'default' : 'none' };
}

export interface ChordOwner {
  readonly id: string;
  readonly chords: readonly string[];
}

export type KeymapConflict =
  /** Two or more commands that can be listed together share a chord: it is bound to nothing. */
  | {
      readonly kind: 'duplicate';
      readonly chord: string;
      readonly ids: readonly string[];
    }
  /** A chord a browser, a text field or the grid keeps: it is bound to nothing. */
  | {
      readonly kind: 'reserved';
      readonly chord: string;
      readonly ids: readonly string[];
      readonly reserved: ReservedReason;
    }
  /** A stored override that is not a chord. */
  | {
      readonly kind: 'invalid';
      readonly chord: string;
      readonly ids: readonly string[];
    };

/** Every conflict among the commands listed now and the stored overrides. Order: by chord. */
export function findConflicts(
  owners: readonly ChordOwner[],
  overrides: KeybindingOverrides,
): readonly KeymapConflict[] {
  const byChord = new Map<string, string[]>();
  for (const owner of owners) {
    for (const chord of owner.chords) {
      const ids = byChord.get(chord) ?? [];
      if (!ids.includes(owner.id)) ids.push(owner.id);
      byChord.set(chord, ids);
    }
  }
  const conflicts: KeymapConflict[] = [];
  for (const [chord, ids] of [...byChord].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const reserved = reservedReason(chord);
    if (reserved !== null)
      conflicts.push({ kind: 'reserved', chord, ids, reserved });
    else if (ids.length > 1) conflicts.push({ kind: 'duplicate', chord, ids });
  }
  for (const [id, value] of Object.entries(overrides)) {
    if (typeof value === 'string' && parseChord(value) === null) {
      conflicts.push({ kind: 'invalid', chord: value, ids: [id] });
    }
  }
  return conflicts;
}

/** The chords that must run nothing: those in a duplicate or reserved conflict. */
export function blockedChords(
  conflicts: readonly KeymapConflict[],
): ReadonlySet<string> {
  return new Set(
    conflicts.filter((c) => c.kind !== 'invalid').map((c) => c.chord),
  );
}

/** Chord text to the id that owns it, without the blocked chords. */
export function bindingTable(
  owners: readonly ChordOwner[],
  conflicts: readonly KeymapConflict[],
): ReadonlyMap<string, string> {
  const blocked = blockedChords(conflicts);
  const table = new Map<string, string>();
  for (const owner of owners) {
    for (const chord of owner.chords) {
      if (!blocked.has(chord)) table.set(chord, owner.id);
    }
  }
  return table;
}

export type AssignResult =
  | {
      readonly ok: true;
      readonly overrides: KeybindingOverrides;
      /** The commands whose chord was taken away because the person chose to replace it. */
      readonly unbound: readonly string[];
    }
  | { readonly ok: false; readonly reason: 'invalid' }
  | {
      readonly ok: false;
      readonly reason: 'reserved';
      readonly reserved: ReservedReason;
    }
  | {
      readonly ok: false;
      readonly reason: 'conflict';
      readonly with: readonly string[];
    }
  | { readonly ok: false; readonly reason: 'too-many' };

/**
 * What assigning `text` to command `id` would do. It refuses a chord that does not parse, a reserved
 * chord and one that another command already has, and says which; with `replace` the other commands
 * are unbound in the same document. Nothing is changed here: the caller saves `overrides`.
 */
export function planAssign(
  owners: readonly ChordOwner[],
  overrides: KeybindingOverrides,
  id: string,
  text: string,
  options: { readonly replace?: boolean } = {},
): AssignResult {
  const chord = canonicalChord(text);
  if (chord === null) return { ok: false, reason: 'invalid' };
  const reserved = reservedReason(chord);
  if (reserved !== null) return { ok: false, reason: 'reserved', reserved };
  const others = owners
    .filter((owner) => owner.id !== id && owner.chords.includes(chord))
    .map((owner) => owner.id);
  if (others.length > 0 && options.replace !== true) {
    return { ok: false, reason: 'conflict', with: others };
  }
  const next: Record<string, string | null> = { ...overrides, [id]: chord };
  for (const other of others) next[other] = null;
  if (Object.keys(next).length > KEYBINDINGS_MAX)
    return { ok: false, reason: 'too-many' };
  return { ok: true, overrides: next, unbound: others };
}

/** The overrides with this command's removed (it goes back to its defaults). */
export function withoutOverride(
  overrides: KeybindingOverrides,
  id: string,
): KeybindingOverrides {
  return Object.fromEntries(
    Object.entries(overrides).filter(([key]) => key !== id),
  );
}

/** The overrides with this command unbound by the person. */
export function withUnbound(
  overrides: KeybindingOverrides,
  id: string,
): KeybindingOverrides {
  return { ...overrides, [id]: null };
}
