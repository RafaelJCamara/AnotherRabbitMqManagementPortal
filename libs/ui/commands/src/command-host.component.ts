// The host of the command system (M1-41, R8, R9): mounted once at the root of the app. It listens for
// shortcuts, runs the command a chord names, reports in one polite live region what it did not run and why,
// loads the person's keymap, and opens the palette and the cheat sheet (both lazy). It registers the two
// commands that belong to the system itself: open the palette, and show the keyboard shortcuts.
import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';

import { Announcer } from './announcer';
import {
  displayChord,
  matchesChord,
  parseChord,
  physicalChord,
  type Chord,
} from './chord';
import { CommandContext } from './context';
import { isEditableTarget } from './dialog';
import { KeymapStore } from './keymap-store';
import { PaletteControl } from './palette-control';
import { paletteScope, scopedText } from './palette-scope';
import { CommandPalette } from './palette.component';
import { announcementText, type Translate } from './reason-text';
import {
  COMMAND_PLATFORM,
  CommandRegistry,
  registerCommands,
} from './registry';
import { ShortcutsDialog } from './shortcuts.component';

interface Matcher {
  readonly chord: Chord;
  readonly text: string;
  readonly ids: readonly string[];
}

/** A chord with no Ctrl, Cmd or Alt is a plain key: typed in a text field it is text, not a shortcut. */
function isPlainKey(chord: Chord, platform: 'mac' | 'other'): boolean {
  const physical = physicalChord(chord, platform);
  return (
    !physical.ctrl &&
    !physical.meta &&
    !physical.alt &&
    chord.key !== 'Escape' &&
    !/^F\d+$/.test(chord.key)
  );
}

@Component({
  selector: 'app-command-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommandPalette, ShortcutsDialog, TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      <div class="live" role="status" aria-live="polite">
        @for (item of latest(); track $index) {
          <p>
            {{ text(item, t) }}
            @if (item.seq % 2 === 0) {
              &#8203;
            }
          </p>
        }
      </div>
    </ng-container>
    @if (control.paletteOpen()) {
      @defer {
        <app-command-palette />
      }
    }
    @if (control.shortcutsOpen()) {
      @defer {
        <app-shortcuts-dialog />
      }
    }
  `,
  styles: `
    .live {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    .live p {
      margin: 0;
    }
  `,
  host: { '(document:keydown)': 'onKeydown($event)' },
})
export class CommandHost {
  protected readonly control = inject(PaletteControl);
  readonly #registry = inject(CommandRegistry);
  readonly #announcer = inject(Announcer);
  readonly #document = inject(DOCUMENT);
  readonly #platform = inject(COMMAND_PLATFORM);

  protected readonly latest = computed(() => {
    const latest = this.#announcer.latest();
    return latest === null ? [] : [latest];
  });

  /** The chords that run a command, and the chords two commands share (they run nothing). */
  readonly #matchers = computed(() => {
    const bound: Matcher[] = [];
    for (const [text, id] of this.#registry.bindings()) {
      const chord = parseChord(text);
      if (chord !== null) bound.push({ chord, text, ids: [id] });
    }
    const clashes: Matcher[] = [];
    for (const conflict of this.#registry.conflicts()) {
      if (conflict.kind !== 'duplicate') continue; // a reserved chord belongs to the browser: leave it alone
      const chord = parseChord(conflict.chord);
      if (chord !== null)
        clashes.push({ chord, text: conflict.chord, ids: conflict.ids });
    }
    return { bound, clashes };
  });

  constructor() {
    const scope = paletteScope();
    registerCommands([
      {
        id: 'palette.open',
        title: scopedText(scope, 'commands.open'),
        category: scopedText(scope, 'category.general'),
        keybinding: 'Mod+K',
        menu: { menu: 'view', order: 0 },
        run: () => {
          this.control.togglePalette();
        },
      },
      {
        id: 'help.keyboard-shortcuts',
        title: scopedText(scope, 'commands.shortcuts'),
        category: scopedText(scope, 'category.help'),
        menu: { menu: 'help', order: 0 },
        run: () => {
          this.control.openShortcuts();
        },
      },
    ]);
    inject(CommandContext).bind('palette.open', this.control.paletteOpen);
    void inject(KeymapStore).load();
  }

  protected text(
    item: Parameters<typeof announcementText>[0],
    t: Translate,
  ): string {
    return announcementText(item, t);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;
    const { bound, clashes } = this.#matchers();
    const platform = this.#platform;
    const hit = bound.find((m) => matchesChord(event, m.chord, platform));
    const clash =
      hit === undefined
        ? clashes.find((m) => matchesChord(event, m.chord, platform))
        : undefined;
    const matched = hit ?? clash;
    if (matched === undefined) return;
    if (isEditableTarget(event.target) && isPlainKey(matched.chord, platform))
      return;
    if (this.control.shortcutsOpen()) return;
    if (this.control.paletteOpen()) {
      if (hit?.ids[0] !== 'palette.open') return;
    } else if (this.#document.querySelector('[aria-modal="true"]') !== null) {
      return; // another dialog owns the keyboard
    }
    event.preventDefault();
    if (hit !== undefined) {
      const id = hit.ids[0];
      if (id !== undefined) void this.#registry.execute(id);
      return;
    }
    const titles = this.#registry
      .commands()
      .filter((c) => matched.ids.includes(c.id))
      .map((c) => c.title);
    this.#announcer.say('conflict', {
      chord: displayChord(matched.chord, platform),
      titles: titles.join(', '),
    });
  }
}
