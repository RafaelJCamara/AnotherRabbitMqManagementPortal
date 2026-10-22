// The command registry (M1-41, R3): the one list the palette, the keyboard and the native menus share.
// Features register their commands while they live and dispose them when they go; the latest registration
// of an id wins and the one below returns when it is disposed. The list is a `computed` over the
// registrations, the context keys, the keymap and the engine's capabilities, so it is always current.
import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  inject,
  signal,
  untracked,
  type Signal,
} from '@angular/core';

import { Announcer } from './announcer';
import { COMMAND_CAPABILITIES, availabilityOf } from './availability';
import type {
  CommandDefinition,
  ExecuteOutcome,
  ListedCommand,
} from './command';
import type { Platform } from './chord';
import { CommandContext } from './context';
import {
  bindingTable,
  defaultChords,
  effectiveChords,
  findConflicts,
  type KeybindingOverrides,
  type KeymapConflict,
} from './keymap';

/** The ids the engine keeps overrides under (`KeybindingCommandIdSchema`). */
export const COMMAND_ID = /^[a-z][A-Za-z0-9.-]{0,99}$/;

/** `mac` when the page runs on macOS, where `Mod` is Cmd. Provided by tests; the default reads the browser. */
export const COMMAND_PLATFORM = new InjectionToken<Platform>(
  'COMMAND_PLATFORM',
  {
    providedIn: 'root',
    factory: (): Platform => {
      const nav = typeof navigator === 'undefined' ? undefined : navigator;
      const text = `${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`;
      return /Mac|iPhone|iPad/.test(text) ? 'mac' : 'other';
    },
  },
);

/** The person's overrides in force. `KeymapStore` loads and saves them; the registry only reads them. */
@Injectable({ providedIn: 'root' })
export class Keymap {
  readonly #overrides = signal<KeybindingOverrides>({});
  readonly overrides: Signal<KeybindingOverrides> =
    this.#overrides.asReadonly();

  set(next: KeybindingOverrides): void {
    this.#overrides.set(next);
  }
}

interface Registration {
  readonly token: symbol;
  readonly def: CommandDefinition;
}

interface Source {
  readonly token: symbol;
  readonly list: Signal<readonly CommandDefinition[]>;
}

const text = (value: string | (() => string)): string =>
  typeof value === 'function' ? value() : value;

@Injectable({ providedIn: 'root' })
export class CommandRegistry {
  readonly #context = inject(CommandContext);
  readonly #keymap = inject(Keymap);
  readonly #capabilities = inject(COMMAND_CAPABILITIES);
  readonly #announcer = inject(Announcer);
  readonly #registrations = signal<readonly Registration[]>([]);
  readonly #sources = signal<readonly Source[]>([]);

  /** Every definition in force, one per id (registered ones over generated ones, later over earlier). */
  readonly #definitions = computed(() => {
    const byId = new Map<string, CommandDefinition>();
    for (const source of this.#sources()) {
      for (const def of source.list()) byId.set(def.id, def);
    }
    for (const { def } of this.#registrations()) byId.set(def.id, def);
    return byId;
  });

  /** The commands that can be listed now (their `when` holds), by category then title. */
  readonly commands: Signal<readonly ListedCommand[]> = computed(() => {
    const overrides = this.#keymap.overrides();
    const snapshot = this.#capabilities();
    const listed: ListedCommand[] = [];
    for (const def of this.#definitions().values()) {
      if (def.when !== undefined && !def.when(this.#context.get)) continue;
      const bindable = def.bindable !== false;
      const defaults = bindable ? defaultChords(def.keybinding) : [];
      const set = bindable
        ? effectiveChords(def.id, defaults, overrides)
        : ({ chords: [], source: 'none' } as const);
      listed.push({
        id: def.id,
        title: text(def.title),
        category: text(def.category),
        chords: set.chords,
        defaults,
        chordSource: set.source,
        availability: availabilityOf(def, snapshot),
        menu: def.menu,
        bindable,
      });
    }
    return listed.sort(
      (a, b) =>
        a.category.localeCompare(b.category) || a.title.localeCompare(b.title),
    );
  });

  readonly #owners = computed(() =>
    this.commands().map((command) => ({
      id: command.id,
      chords: command.chords,
    })),
  );

  /** Chord conflicts among the commands listed now and the stored overrides. */
  readonly conflicts: Signal<readonly KeymapConflict[]> = computed(() =>
    findConflicts(this.#owners(), this.#keymap.overrides()),
  );

  /** Chord text to command id, without any chord in conflict. */
  readonly bindings: Signal<ReadonlyMap<string, string>> = computed(() =>
    bindingTable(this.#owners(), this.conflicts()),
  );

  /** Adds a command and returns the function that removes it. */
  register(def: CommandDefinition): () => void {
    if (def.bindable !== false && !COMMAND_ID.test(def.id)) {
      throw new RangeError(`Not a command id: ${def.id}`);
    }
    const token = Symbol(def.id);
    this.#registrations.update((list) => [...list, { token, def }]);
    return () => {
      this.#registrations.update((list) =>
        list.filter((r) => r.token !== token),
      );
    };
  }

  /** Adds a generated list of commands (a connection per entry) and returns the function that removes it. */
  registerSource(list: Signal<readonly CommandDefinition[]>): () => void {
    const token = Symbol('source');
    this.#sources.update((sources) => [...sources, { token, list }]);
    return () => {
      this.#sources.update((sources) =>
        sources.filter((s) => s.token !== token),
      );
    };
  }

  /**
   * Runs a command, only when it is listed and open. A closed command is not run and its reason is
   * announced; a command that throws or rejects is reported and the registry stays usable.
   */
  async execute(id: string): Promise<ExecuteOutcome> {
    const command = untracked(() => this.commands().find((c) => c.id === id));
    const def = untracked(() => this.#definitions().get(id));
    if (command === undefined || def === undefined)
      return { status: 'unknown' };
    if (!command.availability.enabled) {
      this.#announcer.say('closed', {
        title: command.title,
        reason: command.availability.reason,
      });
      return { status: 'closed', command };
    }
    try {
      await def.run();
      return { status: 'ran' };
    } catch (error) {
      this.#announcer.say('failed', { title: command.title });
      return { status: 'failed', command, error };
    }
  }
}

/**
 * Registers commands for the life of the calling injection context (a component, a service of a route):
 * they are removed when it is destroyed. Call it from a constructor or a field initialiser.
 */
export function registerCommands(defs: readonly CommandDefinition[]): void {
  const registry = inject(CommandRegistry);
  const disposers = defs.map((def) => registry.register(def));
  inject(DestroyRef).onDestroy(() => {
    for (const dispose of disposers) dispose();
  });
}
