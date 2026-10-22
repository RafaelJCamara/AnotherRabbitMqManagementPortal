// Chords a default binding must not use (M1-41, R2). A browser keeps some chords for itself and a page
// cannot intercept them (new tab, close tab, tab switching, quit); it lets a page intercept others but a
// person expects them to work (reload, print, find, the address bar, history, developer tools); the text
// fields and the grid use a few more (clipboard, undo, the grid's cell menu). A default binding on one of
// these is a defect, and a persisted override on one is reported and not bound.
import { parseChord, physicalChord, type Chord, type Platform } from './chord';

export type ReservedKind = 'browser' | 'editing' | 'grid';

interface ReservedEntry {
  readonly chord: string;
  readonly kind: ReservedKind;
}

export interface ReservedReason {
  readonly chord: string;
  readonly kind: ReservedKind;
}

const entries = (
  kind: ReservedKind,
  chords: readonly string[],
): ReservedEntry[] => chords.map((chord) => ({ chord, kind }));

/** The reserved-chord list, in the chord syntax (`Mod` resolves per platform). */
export const RESERVED_CHORDS: readonly ReservedEntry[] = [
  ...entries('browser', [
    'Mod+T',
    'Mod+N',
    'Mod+W',
    'Mod+Shift+T',
    'Mod+Shift+N',
    'Mod+Shift+W',
    'Ctrl+Tab',
    'Ctrl+Shift+Tab',
    'Ctrl+PageUp',
    'Ctrl+PageDown',
    'Mod+Q',
    'Mod+H',
    'Mod+M',
    'Alt+F4',
    'Mod+R',
    'Mod+Shift+R',
    'F5',
    'Mod+P',
    'Mod+S',
    'Mod+F',
    'Mod+G',
    'Mod+D',
    'Mod+L',
    'Mod+O',
    'Mod+U',
    'Mod+Shift+P',
    'Mod+Shift+Delete',
    'Mod+Shift+I',
    'Mod+Shift+J',
    'Mod+Shift+C',
    'Mod+[',
    'Mod+]',
    'Alt+ArrowLeft',
    'Alt+ArrowRight',
    'F11',
    'F12',
  ]),
  ...entries('editing', [
    'Mod+A',
    'Mod+X',
    'Mod+V',
    'Mod+Z',
    'Mod+Y',
    'Mod+Shift+Z',
  ]),
  // The grid handles these on a focused cell (OQ-704).
  ...entries('grid', ['Mod+C', 'Shift+F10', 'ContextMenu']),
];

const PLATFORMS: readonly Platform[] = ['mac', 'other'];

const physicalKey = (chord: Chord, platform: Platform): string => {
  const p = physicalChord(chord, platform);
  return `${p.ctrl ? 'C' : ''}${p.meta ? 'M' : ''}${p.alt ? 'A' : ''}${p.shift ? 'S' : ''}+${p.key}`;
};

const RESOLVED = RESERVED_CHORDS.flatMap((entry) => {
  const chord = parseChord(entry.chord);
  return chord === null
    ? []
    : PLATFORMS.map((platform) => ({
        platform,
        key: physicalKey(chord, platform),
        entry,
      }));
});

/**
 * Why a chord is reserved on some platform, or null. The chord is compared by the keys it needs
 * (`Ctrl+T` and `Mod+T` are the same chord on Windows), so no spelling gets past the list.
 */
export function reservedReason(text: string): ReservedReason | null {
  const chord = parseChord(text);
  if (chord === null) return null;
  for (const platform of PLATFORMS) {
    const key = physicalKey(chord, platform);
    const hit = RESOLVED.find((r) => r.platform === platform && r.key === key);
    if (hit !== undefined)
      return { chord: hit.entry.chord, kind: hit.entry.kind };
  }
  return null;
}

/** The chords of `chords` that are reserved, with their reason (empty when none is). */
export function reservedCollisions(
  chords: readonly string[],
): readonly (ReservedReason & { readonly used: string })[] {
  return chords.flatMap((used) => {
    const reason = reservedReason(used);
    return reason === null ? [] : [{ ...reason, used }];
  });
}
