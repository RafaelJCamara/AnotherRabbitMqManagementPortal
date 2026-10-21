// Grid key chords. The command registry (tinykeys) has not landed, so the chord is a small
// structure of our own that the registry can feed later (OQ-550).
import type { GridCellTarget } from './context-menu';

export interface GridChord {
  /** A `KeyboardEvent.key` value; single letters compare without case. */
  readonly key: string;
  /** Ctrl on Windows and Linux, Cmd on macOS. */
  readonly ctrlOrMeta?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

/** What a binding can use when it runs: the focused cell, the selection and the grid's own actions. */
export interface GridKeyContext<Row = unknown> {
  /** The cell that has focus. */
  readonly target: GridCellTarget<Row>;
  readonly selection: ReadonlySet<string>;
  /** Opens the context menu on the focused cell. */
  openMenu(): void;
  /** Copies the selected rows as text. */
  copy(): void;
}

export interface GridKeybinding<Row = unknown> {
  readonly id: string;
  readonly chord: GridChord;
  run(context: GridKeyContext<Row>): void;
}

/** Whether a keyboard event is exactly this chord (a modifier that is not named must not be down). */
export function matchesChord(event: KeyboardEvent, chord: GridChord): boolean {
  const single = chord.key.length === 1;
  const sameKey = single
    ? event.key.toLowerCase() === chord.key.toLowerCase()
    : event.key === chord.key;
  return (
    sameKey &&
    (event.ctrlKey || event.metaKey) === (chord.ctrlOrMeta === true) &&
    event.shiftKey === (chord.shift === true) &&
    event.altKey === (chord.alt === true)
  );
}

/** Copy the selected rows (Ctrl or Cmd+C), and open the context menu (Shift+F10 and the context-menu key). */
export const DEFAULT_GRID_KEYBINDINGS: readonly GridKeybinding[] = [
  {
    id: 'grid.copy',
    chord: { key: 'c', ctrlOrMeta: true },
    run: (context) => {
      context.copy();
    },
  },
  {
    id: 'grid.openMenu.shiftF10',
    chord: { key: 'F10', shift: true },
    run: (context) => {
      context.openMenu();
    },
  },
  {
    id: 'grid.openMenu.contextKey',
    chord: { key: 'ContextMenu' },
    run: (context) => {
      context.openMenu();
    },
  },
];
