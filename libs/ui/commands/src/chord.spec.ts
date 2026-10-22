import { describe, expect, it } from 'vitest';

import {
  CHORD_MAX_CHARS,
  acceleratorOf,
  canonicalChord,
  displayChord,
  matchesChord,
  parseChord,
  type KeyEventLike,
} from './chord';

const event = (
  key: string,
  init: Partial<KeyEventLike> = {},
): KeyEventLike => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...init,
});

const chord = (text: string) => {
  const parsed = parseChord(text);
  if (parsed === null) throw new Error(`not a chord: ${text}`);
  return parsed;
};

describe('chords', () => {
  it('AC-2 chords parse, format and match per platform', () => {
    // Parse and format: any case, any order of modifiers, one canonical text.
    expect(canonicalChord('Mod+K')).toBe('Mod+K');
    expect(canonicalChord('shift+mod+k')).toBe('Mod+Shift+K');
    expect(canonicalChord('ctrl+shift+p')).toBe('Ctrl+Shift+P');
    expect(canonicalChord('Control+Option+x')).toBe('Ctrl+Alt+X');
    expect(canonicalChord('/')).toBe('/');
    expect(canonicalChord('f1')).toBe('F1');
    expect(canonicalChord('esc')).toBe('Escape');
    expect(canonicalChord('Mod+space')).toBe('Mod+Space');
    expect(canonicalChord('Mod+Plus')).toBe('Mod+Plus');
    // Anything that is not exactly one key with modifiers is null.
    for (const bad of [
      '',
      'Mod+',
      '+K',
      'K+L',
      'Foo+K',
      'Mod+Shift',
      'Mod+Mod+K',
      'Mod+Ctrl+K',
      'Mod+Meta+K',
      'Mod+Fn99',
      'x'.repeat(CHORD_MAX_CHARS + 1),
    ]) {
      expect(parseChord(bad), bad).toBeNull();
    }

    // Matching: Mod is Ctrl on Windows and Linux, Cmd on macOS, and the other one must be up.
    const modK = chord('Mod+K');
    expect(matchesChord(event('k', { ctrlKey: true }), modK, 'other')).toBe(
      true,
    );
    expect(matchesChord(event('K', { ctrlKey: true }), modK, 'other')).toBe(
      true,
    );
    expect(matchesChord(event('k', { metaKey: true }), modK, 'other')).toBe(
      false,
    );
    expect(matchesChord(event('k', { metaKey: true }), modK, 'mac')).toBe(true);
    expect(matchesChord(event('k', { ctrlKey: true }), modK, 'mac')).toBe(
      false,
    );
    expect(
      matchesChord(event('k', { ctrlKey: true, metaKey: true }), modK, 'mac'),
    ).toBe(false);
    // A modifier that is not named must be up.
    expect(
      matchesChord(
        event('k', { ctrlKey: true, shiftKey: true }),
        modK,
        'other',
      ),
    ).toBe(false);
    expect(
      matchesChord(event('k', { ctrlKey: true, altKey: true }), modK, 'other'),
    ).toBe(false);
    expect(matchesChord(event('k'), modK, 'other')).toBe(false);
    // A symbol key ignores Shift (a layout decides whether `?` needs it); a letter does not.
    expect(matchesChord(event('/'), chord('/'), 'other')).toBe(true);
    expect(
      matchesChord(event('/', { shiftKey: true }), chord('/'), 'other'),
    ).toBe(true);
    expect(
      matchesChord(event('k', { shiftKey: true }), chord('K'), 'other'),
    ).toBe(false);
    expect(matchesChord(event('Escape'), chord('Escape'), 'other')).toBe(true);
    // AltGraph (typing a character on a European layout), composition and auto-repeat never match.
    const altGraph = {
      getModifierState: (name: string) => name === 'AltGraph',
    };
    expect(
      matchesChord(
        event('k', { ctrlKey: true, altKey: true, ...altGraph }),
        chord('Ctrl+Alt+K'),
        'other',
      ),
    ).toBe(false);
    expect(
      matchesChord(
        event('k', { ctrlKey: true, isComposing: true }),
        modK,
        'other',
      ),
    ).toBe(false);
    expect(
      matchesChord(event('k', { ctrlKey: true, repeat: true }), modK, 'other'),
    ).toBe(false);
    // With Option on macOS the key produces another character; the key's place decides.
    expect(
      matchesChord(
        event('˚', { altKey: true, code: 'KeyK' }),
        chord('Alt+K'),
        'mac',
      ),
    ).toBe(true);

    // What a person reads, and what a desktop menu is given.
    expect(displayChord(modK, 'other')).toBe('Ctrl+K');
    expect(displayChord(modK, 'mac')).toBe('Cmd+K');
    expect(displayChord(chord('Mod+Alt+ArrowUp'), 'mac')).toBe('Cmd+Option+Up');
    expect(acceleratorOf(modK)).toBe('CmdOrCtrl+K');
    expect(acceleratorOf(chord('Mod+Shift+Escape'))).toBe(
      'CmdOrCtrl+Shift+Esc',
    );
  });
});
