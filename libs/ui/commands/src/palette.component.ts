// The command palette (M1-41, R10, R11): a modal dialog with a text field that is a combobox over a listbox of
// the registered commands, ranked by the fuzzy filter. Written locally (M0-54 Q-27): the text field keeps
// focus and names the active option with `aria-activedescendant`. Choosing an open command closes the
// palette, gives focus back to where it was, and only then runs the command, so a command that moves
// focus wins. A closed command stays in the list with the engine's reason and is not run.
import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';

import { displayChord, parseChord } from './chord';
import type { ListedCommand } from './command';
import { trapTab } from './dialog';
import { rankCommands, type Range, type Ranked } from './fuzzy';
import { PaletteControl } from './palette-control';
import { describeReason, type Translate } from './reason-text';
import { COMMAND_PLATFORM, CommandRegistry } from './registry';
import { COMMAND_TIMER } from './timer';

/** How long the result count waits for typing to stop before it is announced. */
export const COUNT_ANNOUNCE_DELAY_MS = 300;
/** How many options PageUp and PageDown move. */
const PAGE_STEP = 5;

interface Segment {
  readonly text: string;
  readonly hit: boolean;
}

/** Cuts a text at the highlight ranges; drawn as text, never as markup. */
function segments(text: string, ranges: readonly Range[]): readonly Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) out.push({ text: text.slice(at, start), hit: false });
    out.push({ text: text.slice(start, end), hit: true });
    at = end;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

let nextPalette = 0;

@Component({
  selector: 'app-command-palette',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      <div class="backdrop" aria-hidden="true"></div>
      <div
        #dialog
        class="dialog"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="t('palette.title')"
        (keydown)="onDialogKey($event)"
      >
        <input
          #field
          type="text"
          class="field"
          role="combobox"
          aria-autocomplete="list"
          autocomplete="off"
          spellcheck="false"
          [attr.aria-expanded]="rows().length > 0"
          [attr.aria-controls]="listId"
          [attr.aria-activedescendant]="activeId()"
          [attr.aria-label]="t('palette.input')"
          [attr.placeholder]="t('palette.placeholder')"
          [value]="query()"
          (input)="onInput($event)"
          (keydown)="onFieldKey($event)"
        />
        <ul
          class="list"
          role="listbox"
          [id]="listId"
          [attr.aria-label]="t('palette.results')"
        >
          @for (row of rows(); track row.item.id; let i = $index) {
            <li
              role="option"
              class="option"
              [id]="optionId(i)"
              [class.active]="i === active()"
              [class.closed]="!row.item.availability.enabled"
              [attr.aria-selected]="i === active()"
              [attr.aria-disabled]="
                row.item.availability.enabled ? null : 'true'
              "
              [attr.aria-describedby]="
                row.item.availability.enabled ? null : reasonId(i)
              "
              tabindex="-1"
              (mousedown)="$event.preventDefault()"
              (click)="choose(i)"
              (keydown.enter)="choose(i)"
              (mousemove)="active.set(i)"
            >
              <span class="category">{{ row.item.category }}</span>
              <span class="title">
                @for (part of titleParts(row); track $index) {
                  @if (part.hit) {
                    <mark>{{ part.text }}</mark>
                  } @else {
                    {{ part.text }}
                  }
                }
              </span>
              <span class="id">
                @for (part of idParts(row); track $index) {
                  @if (part.hit) {
                    <mark>{{ part.text }}</mark>
                  } @else {
                    {{ part.text }}
                  }
                }
              </span>
              @for (chord of chordsOf(row.item); track $index) {
                <kbd>{{ chord }}</kbd>
              }
              @if (!row.item.availability.enabled) {
                <span class="reason" [id]="reasonId(i)">{{
                  reasonOf(row.item, t)
                }}</span>
              }
            </li>
          }
        </ul>
        @if (rows().length === 0) {
          <p class="empty">{{ t('palette.empty') }}</p>
        }
        <p class="count" role="status" aria-live="polite">
          {{
            announced() === null ? '' : t(countKey(), { count: announced() })
          }}
        </p>
      </div>
    </ng-container>
  `,
  styles: `
    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 1000;
      background: var(--ds-color-overlay, rgb(0 0 0 / 40%));
    }
    .dialog {
      position: fixed;
      z-index: 1001;
      top: 12vh;
      left: 50%;
      transform: translateX(-50%);
      width: min(40rem, calc(100vw - var(--ds-space-4)));
      max-height: 70vh;
      display: flex;
      flex-direction: column;
      gap: var(--ds-space-2);
      padding: var(--ds-space-3);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface-raised);
      color: var(--ds-color-text);
      font-size: var(--ds-font-size);
    }
    .field {
      min-height: var(--ds-target-size);
      padding: 0 var(--ds-space-2);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface);
      color: inherit;
      font: inherit;
    }
    .field:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 2px;
    }
    .list {
      margin: 0;
      padding: 0;
      overflow: auto;
      list-style: none;
    }
    .option {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: var(--ds-space-2);
      padding: var(--ds-space-1) var(--ds-space-2);
      border-radius: var(--ds-radius);
      cursor: pointer;
    }
    .option.active {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: -2px;
      background: var(--ds-color-surface-sunken);
    }
    .option.closed {
      color: var(--ds-color-text-muted);
    }
    .category,
    .id,
    .reason {
      color: var(--ds-color-text-muted);
    }
    .title {
      flex: 1 1 auto;
    }
    .reason {
      flex: 1 1 100%;
    }
    mark {
      background: transparent;
      color: inherit;
      font-weight: 700;
      text-decoration: underline;
    }
    kbd {
      padding: 0 var(--ds-space-1);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      font: inherit;
    }
    .empty,
    .count {
      margin: 0;
      color: var(--ds-color-text-muted);
    }
  `,
})
export class CommandPalette {
  readonly #registry = inject(CommandRegistry);
  readonly #control = inject(PaletteControl);
  readonly #platform = inject(COMMAND_PLATFORM);
  readonly #timer = inject(COMMAND_TIMER);
  readonly #injector = inject(Injector);
  private readonly fieldRef = viewChild<ElementRef<HTMLInputElement>>('field');
  private readonly dialogRef = viewChild<ElementRef<HTMLElement>>('dialog');
  readonly #id = nextPalette++;

  protected readonly listId = `app-palette-list-${String(this.#id)}`;
  protected readonly query = signal('');
  protected readonly active = signal(0);
  /** The count the live region says: set after typing has stopped. */
  protected readonly announced = signal<number | null>(null);

  protected readonly rows = computed<readonly Ranked<ListedCommand>[]>(() =>
    rankCommands(this.query(), this.#registry.commands()),
  );
  protected readonly activeId = computed(() =>
    this.rows().length === 0 ? null : this.optionId(this.active()),
  );

  constructor() {
    // A press outside the dialog closes it (the backdrop is not a control, so it has no handler of its own).
    const document = inject(DOCUMENT);
    const outside = (event: Event): void => {
      const target = event.target;
      if (
        target instanceof Node &&
        this.dialogRef()?.nativeElement.contains(target) === false
      )
        this.close();
    };
    document.addEventListener('pointerdown', outside);
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('pointerdown', outside);
    });
    // The field exists once the translations have loaded: focus it the first time it appears.
    effect(() => {
      const field = this.fieldRef();
      if (field !== undefined && !this.#focused) {
        this.#focused = true;
        field.nativeElement.focus();
      }
    });
    // A new query starts at the best match.
    effect(() => {
      this.query();
      untracked(() => {
        this.active.set(0);
      });
    });
    // The count is announced once typing has stopped, not for every key of a burst.
    effect((onCleanup) => {
      const count = this.rows().length;
      const cancel = this.#timer.set(() => {
        this.announced.set(count);
      }, COUNT_ANNOUNCE_DELAY_MS);
      onCleanup(cancel);
    });
  }

  protected optionId(index: number): string {
    return `${this.listId}-option-${String(index)}`;
  }

  protected reasonId(index: number): string {
    return `${this.listId}-reason-${String(index)}`;
  }

  protected countKey(): string {
    const count = this.announced();
    return count === 0
      ? 'palette.countNone'
      : count === 1
        ? 'palette.countOne'
        : 'palette.count';
  }

  protected titleParts(row: Ranked<ListedCommand>): readonly Segment[] {
    return segments(
      row.item.title,
      row.matchedIn === 'title' ? row.ranges : [],
    );
  }

  protected idParts(row: Ranked<ListedCommand>): readonly Segment[] {
    return segments(row.item.id, row.matchedIn === 'id' ? row.ranges : []);
  }

  protected chordsOf(command: ListedCommand): readonly string[] {
    return command.chords.flatMap((text) => {
      const chord = parseChord(text);
      return chord === null ? [] : [displayChord(chord, this.#platform)];
    });
  }

  protected reasonOf(command: ListedCommand, t: Translate): string {
    return command.availability.enabled
      ? ''
      : describeReason(command.availability.reason, t);
  }

  protected onInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  #focused = false;

  protected onDialogKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }
    const dialog = this.dialogRef()?.nativeElement;
    if (dialog !== undefined) trapTab(event, dialog);
  }

  protected onFieldKey(event: KeyboardEvent): void {
    const count = this.rows().length;
    const move = (to: number): void => {
      event.preventDefault();
      this.active.set(to);
    };
    if (count === 0) {
      if (event.key === 'Enter') event.preventDefault();
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        move((this.active() + 1) % count);
        break;
      case 'ArrowUp':
        move((this.active() - 1 + count) % count);
        break;
      case 'PageDown':
        move(Math.min(count - 1, this.active() + PAGE_STEP));
        break;
      case 'PageUp':
        move(Math.max(0, this.active() - PAGE_STEP));
        break;
      case 'Enter':
        event.preventDefault();
        void this.choose(this.active());
        break;
    }
  }

  protected close(): void {
    this.#control.closePalette();
  }

  /** Runs the option: an open command after focus has returned; a closed one only says why. */
  protected async choose(index: number): Promise<void> {
    const command = this.rows()[index]?.item;
    if (command === undefined) return;
    if (!command.availability.enabled) {
      await this.#registry.execute(command.id); // announces the reason; the palette stays open
      return;
    }
    this.#control.closePalette(); // focus is back where it was before the command runs
    await this.#registry.execute(command.id);
  }
}
