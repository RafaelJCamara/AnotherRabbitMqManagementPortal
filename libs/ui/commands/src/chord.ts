// Key chords of the command registry (M1-41, R1). A chord is written as text, `Mod+Shift+K`, so it
// can be kept by the engine (`keybindings.put`), shown in the cheat sheet and handed to a desktop menu.
// `Mod` is Ctrl on Windows and Linux and Cmd on macOS. `tinykeys` is not in the catalog (OQ-824), so
// this is a small parser and matcher of our own: no sequences, one key per chord.

export type Platform = 'mac' | 'other';

export interface Chord {
  /** The key as `KeyboardEvent.key` names it, letters upper-case (`K`), named keys by name (`Escape`). */
  readonly key: string;
  /** Ctrl on Windows and Linux, Cmd on macOS. */
  readonly mod: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

/** The longest chord text the engine keeps (`KeybindingOverridesSchema`). */
export const CHORD_MAX_CHARS = 64;

const NAMED_KEYS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    Array.from({ length: 24 }, (_, n) => [
      `f${String(n + 1)}`,
      `F${String(n + 1)}`,
    ]),
  ),
  escape: 'Escape',
  esc: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  space: ' ',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowup: 'ArrowUp',
  up: 'ArrowUp',
  arrowdown: 'ArrowDown',
  down: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  left: 'ArrowLeft',
  arrowright: 'ArrowRight',
  right: 'ArrowRight',
  contextmenu: 'ContextMenu',
  plus: '+',
};

const MODIFIERS = [
  'mod',
  'ctrl',
  'control',
  'meta',
  'cmd',
  'alt',
  'option',
  'shift',
];

/** The text of a key as the chord writes it: `Space` for the space bar, `Plus` for `+`. */
const KEY_TEXT: Readonly<Record<string, string>> = {
  ' ': 'Space',
  '+': 'Plus',
};

/** Parses chord text into a chord, or null for anything that is not exactly one key with modifiers. */
export function parseChord(text: string): Chord | null {
  if (text.length === 0 || text.length > CHORD_MAX_CHARS) return null;
  const parts = text.split('+').map((part) => part.trim());
  if (parts.some((part) => part === '')) return null;
  const keyText = parts[parts.length - 1];
  if (keyText === undefined) return null;
  const modifiers = new Set<string>();
  for (const raw of parts.slice(0, -1)) {
    const name = raw.toLowerCase();
    if (!MODIFIERS.includes(name)) return null;
    const canonical =
      name === 'control'
        ? 'ctrl'
        : name === 'cmd'
          ? 'meta'
          : name === 'option'
            ? 'alt'
            : name;
    if (modifiers.has(canonical)) return null;
    modifiers.add(canonical);
  }
  const key = parseKey(keyText);
  if (key === null) return null;
  const mod = modifiers.has('mod');
  const ctrl = modifiers.has('ctrl');
  const meta = modifiers.has('meta');
  // `Mod` already means one of them on each platform; naming both is a chord that cannot be typed the same way twice.
  if (mod && (ctrl || meta)) return null;
  return {
    key,
    mod,
    ctrl,
    meta,
    alt: modifiers.has('alt'),
    shift: modifiers.has('shift'),
  };
}

function parseKey(text: string): string | null {
  if (MODIFIERS.includes(text.toLowerCase())) return null;
  const named = NAMED_KEYS[text.toLowerCase()];
  if (named !== undefined) return named;
  if (Array.from(text).length !== 1) return null;
  return /^[a-z]$/i.test(text) ? text.toUpperCase() : text;
}

/** The canonical text of a chord: modifiers in a fixed order, then the key. */
export function formatChord(chord: Chord): string {
  const parts: string[] = [];
  if (chord.mod) parts.push('Mod');
  if (chord.ctrl) parts.push('Ctrl');
  if (chord.meta) parts.push('Meta');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  parts.push(KEY_TEXT[chord.key] ?? chord.key);
  return parts.join('+');
}

/** Canonical text for chord text, or null when it does not parse. */
export function canonicalChord(text: string): string | null {
  const chord = parseChord(text);
  return chord === null ? null : formatChord(chord);
}

/** The modifiers a platform needs for a chord, with `Mod` resolved. */
export function physicalChord(
  chord: Chord,
  platform: Platform,
): { key: string; ctrl: boolean; meta: boolean; alt: boolean; shift: boolean } {
  return {
    key: chord.key,
    ctrl: chord.ctrl || (chord.mod && platform === 'other'),
    meta: chord.meta || (chord.mod && platform === 'mac'),
    alt: chord.alt,
    shift: chord.shift,
  };
}

const KEY_LABELS: Readonly<Record<string, string>> = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
};

/** The chord as a person reads it on this platform (`Ctrl+K`, `Cmd+K`). */
export function displayChord(chord: Chord, platform: Platform): string {
  const parts: string[] = [];
  if (chord.mod) parts.push(platform === 'mac' ? 'Cmd' : 'Ctrl');
  if (chord.ctrl) parts.push('Ctrl');
  if (chord.meta) parts.push(platform === 'mac' ? 'Cmd' : 'Win');
  if (chord.alt) parts.push(platform === 'mac' ? 'Option' : 'Alt');
  if (chord.shift) parts.push('Shift');
  parts.push(KEY_LABELS[chord.key] ?? chord.key);
  return parts.join('+');
}

const ACCELERATOR_KEYS: Readonly<Record<string, string>> = {
  ' ': 'Space',
  Escape: 'Esc',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  '+': 'Plus',
};

/** The chord in the syntax of a desktop menu accelerator (`CmdOrCtrl+K`). */
export function acceleratorOf(chord: Chord): string {
  const parts: string[] = [];
  if (chord.mod) parts.push('CmdOrCtrl');
  if (chord.ctrl) parts.push('Ctrl');
  if (chord.meta) parts.push('Meta');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  parts.push(ACCELERATOR_KEYS[chord.key] ?? chord.key);
  return parts.join('+');
}

/** The part of a keyboard event the matcher reads (a real `KeyboardEvent` fits). */
export interface KeyEventLike {
  readonly key: string;
  readonly code?: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean;
  readonly repeat?: boolean;
  getModifierState?(key: string): boolean;
}

const isLetterOrDigit = (key: string): boolean => /^[A-Z0-9]$/i.test(key);
/** A key that is one character and neither letter nor digit: the layout decides whether Shift is needed. */
const isSymbol = (key: string): boolean =>
  Array.from(key).length === 1 && !isLetterOrDigit(key);

/**
 * Whether a keyboard event is exactly this chord on this platform: the modifiers must match (the ones
 * not named must be up), letters compare without case, and a symbol key ignores Shift (a `?` needs it
 * on one layout and not on another). AltGraph, composition and auto-repeat never match.
 */
export function matchesChord(
  event: KeyEventLike,
  chord: Chord,
  platform: Platform,
): boolean {
  if (event.isComposing === true || event.repeat === true) return false;
  if (event.getModifierState?.('AltGraph') === true) return false;
  const want = physicalChord(chord, platform);
  if (event.ctrlKey !== want.ctrl) return false;
  if (event.metaKey !== want.meta) return false;
  if (event.altKey !== want.alt) return false;
  if (!(isSymbol(chord.key) && !chord.shift) && event.shiftKey !== want.shift) {
    return false;
  }
  return sameKey(event, chord.key);
}

function sameKey(event: KeyEventLike, key: string): boolean {
  // With Alt (Option on macOS) the produced character changes, so letters and digits are read from the key's place.
  if (event.altKey && event.code !== undefined && isLetterOrDigit(key)) {
    const place =
      /^Key([A-Z])$/.exec(event.code) ?? /^Digit([0-9])$/.exec(event.code);
    if (place !== null) return place[1] === key.toUpperCase();
  }
  return key.length === 1 && isLetterOrDigit(key)
    ? event.key.toUpperCase() === key
    : event.key === key;
}
