import { describe, expect, it } from 'vitest';

import {
  RESERVED_CHORDS,
  reservedCollisions,
  reservedReason,
} from './reserved';
import { canonicalChord } from './chord';

describe('reserved chords', () => {
  it('names the kind of a reserved chord whatever way it is spelled', () => {
    expect(reservedReason('Mod+T')).toEqual({
      chord: 'Mod+T',
      kind: 'browser',
    });
    // On Windows Ctrl+T is the tab chord; the list is compared by the keys that are pressed.
    expect(reservedReason('Ctrl+T')?.kind).toBe('browser');
    expect(reservedReason('ctrl+shift+t')?.chord).toBe('Mod+Shift+T');
    expect(reservedReason('Mod+Shift+P')?.kind).toBe('browser');
    expect(reservedReason('Mod+Z')?.kind).toBe('editing');
    expect(reservedReason('Mod+C')?.kind).toBe('grid');
    expect(reservedReason('Shift+F10')?.kind).toBe('grid');
    expect(reservedReason('ContextMenu')?.kind).toBe('grid');
  });

  it('lets the chords this product binds through', () => {
    for (const free of [
      'Mod+K',
      '/',
      'Mod+Alt+R',
      'Alt+1',
      'F1',
      'Mod+Shift+K',
      'Escape',
    ]) {
      expect(reservedReason(free), free).toBeNull();
    }
  });

  it('reports every collision in a list of default chords', () => {
    expect(reservedCollisions(['Mod+K', '/'])).toEqual([]);
    expect(reservedCollisions(['Mod+K', 'Mod+T', 'ctrl+n'])).toEqual([
      { chord: 'Mod+T', kind: 'browser', used: 'Mod+T' },
      { chord: 'Mod+N', kind: 'browser', used: 'ctrl+n' },
    ]);
  });

  it('keeps the list in canonical spelling, with no chord twice', () => {
    const chords = RESERVED_CHORDS.map((entry) => entry.chord);
    expect(chords.map((chord) => canonicalChord(chord))).toEqual(chords);
    expect(new Set(chords).size).toBe(chords.length);
  });
});
