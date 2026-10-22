// The types of a command (M1-41, R3). A command is data plus one function: the registry lists it, the
// palette and the keyboard run it, and the menu model reads it. Nothing here knows about a component.
import type { GateDecision } from '@app/contracts';

import type { Availability } from './availability';
import type { ContextGetter } from './context';

/** The menus a desktop shell draws; the browser has none (the palette is its menu). */
export type MenuName = 'file' | 'view' | 'go' | 'help';

export interface CommandMenu {
  readonly menu: MenuName;
  /** Order inside the menu; commands with the same order keep their registration order. */
  readonly order?: number;
  /** A separator is drawn between groups. */
  readonly group?: string;
}

export interface CommandDefinition {
  /** `^[a-z][A-Za-z0-9.-]{0,99}$`: the id the engine keeps keybinding overrides under. */
  readonly id: string;
  /** Text, or a function that reads signals so a language change updates it. */
  readonly title: string | (() => string);
  readonly category: string | (() => string);
  /** The command is listed and runs only while this holds; it reads context keys, so it is reactive. */
  readonly when?: (get: ContextGetter) => boolean;
  /** Default chords. Reserved chords are a defect (a test fails). */
  readonly keybinding?: string | readonly string[];
  /** The engine action this command calls: closed unless the engine's `allowedActions` has it. */
  readonly action?: string;
  /** A gate id looked up in the engine's `gates`, or a function that returns the decision the engine sent. */
  readonly gate?: string | (() => GateDecision | null | undefined);
  /** The feature's own reason for being closed now (for example a refresh floor); null when open. */
  readonly unavailable?: () => string | null;
  readonly menu?: CommandMenu;
  /** False for generated commands (a connection per entry): they have no stable id to bind a key to. */
  readonly bindable?: boolean;
  run(): void | Promise<void>;
}

/** A command as the palette, the keymap and the menu see it. */
export interface ListedCommand {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  /** The chords in force: the person's override, else the defaults, canonical text. */
  readonly chords: readonly string[];
  readonly defaults: readonly string[];
  readonly chordSource: 'default' | 'user' | 'none';
  readonly availability: Availability;
  readonly menu: CommandMenu | undefined;
  readonly bindable: boolean;
}

export type ExecuteOutcome =
  | { readonly status: 'ran' }
  | { readonly status: 'closed'; readonly command: ListedCommand }
  | { readonly status: 'unknown' }
  | {
      readonly status: 'failed';
      readonly command: ListedCommand;
      readonly error: unknown;
    };
