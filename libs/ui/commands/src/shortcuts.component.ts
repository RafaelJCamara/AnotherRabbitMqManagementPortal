// The keyboard shortcuts dialog, the cheat sheet (M1-41, R12): every command that can have a chord, the chord in
// force and whether it is the default or the person's choice, the conflicts and reserved chords as a list, the
// state of the keymap on the engine (load and save, with a retry), and the controls to change, unbind or reset a
// chord. A new chord is captured from the next key press with the registry's own parser; a chord that is
// invalid, reserved or taken is refused with the reason (and may replace the other command's chord if the
// person says so). Nothing is changed silently.
import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { isEngineProblem } from '@app/ui-data';
import { TranslocoDirective } from '@jsverse/transloco';

import { chordOfEvent, displayChord, formatChord, parseChord } from './chord';
import type { ListedCommand } from './command';
import { trapTab } from './dialog';
import type { AssignResult, KeymapConflict } from './keymap';
import { KeymapStore } from './keymap-store';
import { PaletteControl } from './palette-control';
import type { Translate } from './reason-text';
import { COMMAND_PLATFORM, CommandRegistry } from './registry';

interface Refusal {
  readonly id: string;
  readonly chord: string;
  readonly result: Exclude<AssignResult, { ok: true }>;
}

let nextDialog = 0;

@Component({
  selector: 'app-shortcuts-dialog',
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
        [attr.aria-labelledby]="titleId"
        (keydown)="onKey($event)"
      >
        <h2 #heading [id]="titleId" tabindex="-1">
          {{ t('palette.shortcuts.title') }}
        </h2>
        <p class="status" role="status" aria-live="polite">{{ saveText(t) }}</p>
        @if (store.loadStatus() === 'failed') {
          <p class="problem">
            <span>{{ t('palette.shortcuts.loadFailed') }}</span>
            <span>{{ problemOf(store.loadError()) }}</span>
            <button type="button" (click)="store.load()">
              {{ t('palette.shortcuts.retry') }}
            </button>
          </p>
        }
        @if (store.saveStatus() === 'failed') {
          <p class="problem">
            <span>{{ t('palette.shortcuts.saveFailedDetail') }}</span>
            <span>{{ problemOf(store.saveError()) }}</span>
            <button type="button" (click)="store.retry()">
              {{ t('palette.shortcuts.retry') }}
            </button>
          </p>
        }
        @if (conflicts().length > 0) {
          <section [attr.aria-labelledby]="conflictsId">
            <h3 [id]="conflictsId">{{ t('palette.shortcuts.conflicts') }}</h3>
            <ul>
              @for (
                conflict of conflicts();
                track conflict.chord + conflict.kind
              ) {
                <li>{{ conflictText(conflict, t) }}</li>
              }
            </ul>
          </section>
        }
        @if (refusal(); as refused) {
          <p class="problem" role="alert">
            {{ refusalText(refused, t) }}
            @if (refused.result.reason === 'conflict') {
              <button type="button" (click)="replace(refused)">
                {{ t('palette.shortcuts.replace') }}
              </button>
            }
          </p>
        }
        <div class="scroll">
          <table>
            <caption>
              {{
                t('palette.shortcuts.table')
              }}
            </caption>
            <thead>
              <tr>
                <th scope="col">{{ t('palette.shortcuts.command') }}</th>
                <th scope="col">{{ t('palette.shortcuts.category') }}</th>
                <th scope="col">{{ t('palette.shortcuts.shortcut') }}</th>
                <th scope="col">{{ t('palette.shortcuts.actions') }}</th>
              </tr>
            </thead>
            <tbody>
              @for (command of commands(); track command.id) {
                <tr>
                  <th scope="row">{{ command.title }}</th>
                  <td>{{ command.category }}</td>
                  <td>
                    @if (capturing() === command.id) {
                      {{ t('palette.shortcuts.press') }}
                    } @else {
                      @for (chord of chordsOf(command); track $index) {
                        <kbd>{{ chord }}</kbd>
                      } @empty {
                        {{
                          command.chordSource === 'user'
                            ? t('palette.shortcuts.unbound')
                            : t('palette.shortcuts.none')
                        }}
                      }
                      @if (command.chordSource === 'user') {
                        <span class="muted">{{
                          t('palette.shortcuts.yours')
                        }}</span>
                      }
                    }
                  </td>
                  <td class="row-actions">
                    <button
                      type="button"
                      [attr.aria-label]="
                        t('palette.shortcuts.changeNamed', {
                          name: command.title,
                        })
                      "
                      (click)="capture(command, $event)"
                    >
                      {{ t('palette.shortcuts.change') }}
                    </button>
                    <button
                      type="button"
                      [attr.aria-label]="
                        t('palette.shortcuts.unbindNamed', {
                          name: command.title,
                        })
                      "
                      (click)="store.unbind(command.id)"
                    >
                      {{ t('palette.shortcuts.unbind') }}
                    </button>
                    @if (command.chordSource === 'user') {
                      <button
                        type="button"
                        [attr.aria-label]="
                          t('palette.shortcuts.defaultNamed', {
                            name: command.title,
                          })
                        "
                        (click)="store.useDefault(command.id)"
                      >
                        {{ t('palette.shortcuts.useDefault') }}
                      </button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <div class="footer">
          <button type="button" (click)="store.resetAll()">
            {{ t('palette.shortcuts.resetAll') }}
          </button>
          <button type="button" (click)="close()">
            {{ t('palette.shortcuts.close') }}
          </button>
        </div>
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
      top: 8vh;
      left: 50%;
      transform: translateX(-50%);
      width: min(48rem, calc(100vw - var(--ds-space-4)));
      max-height: 80vh;
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
    h2,
    h3,
    p {
      margin: 0;
    }
    .scroll {
      overflow: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th,
    td {
      padding: var(--ds-space-1) var(--ds-space-2);
      text-align: start;
      vertical-align: baseline;
    }
    caption {
      text-align: start;
      color: var(--ds-color-text-muted);
    }
    .muted,
    .status {
      color: var(--ds-color-text-muted);
    }
    .problem {
      padding: var(--ds-space-1) var(--ds-space-2);
      border-inline-start: 4px solid var(--ds-color-warning);
    }
    kbd {
      padding: 0 var(--ds-space-1);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      font: inherit;
    }
    button {
      min-height: var(--ds-target-size);
      padding: 0 var(--ds-space-3);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface);
      color: var(--ds-color-text);
      font: inherit;
      cursor: pointer;
    }
    button:focus-visible,
    h2:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 2px;
    }
    .row-actions,
    .footer {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ds-space-2);
    }
  `,
})
export class ShortcutsDialog {
  protected readonly store = inject(KeymapStore);
  readonly #registry = inject(CommandRegistry);
  readonly #control = inject(PaletteControl);
  readonly #platform = inject(COMMAND_PLATFORM);
  private readonly dialogRef = viewChild<ElementRef<HTMLElement>>('dialog');
  private readonly headingRef = viewChild<ElementRef<HTMLElement>>('heading');
  readonly #id = nextDialog++;

  protected readonly titleId = `app-shortcuts-title-${String(this.#id)}`;
  protected readonly conflictsId = `app-shortcuts-conflicts-${String(this.#id)}`;
  protected readonly capturing = signal<string | null>(null);
  protected readonly refusal = signal<Refusal | null>(null);
  #trigger: HTMLElement | null = null;
  #focused = false;

  /** Only commands that can hold a chord (generated ones, one per connection, cannot). */
  protected readonly commands = computed(() =>
    this.#registry.commands().filter((command) => command.bindable),
  );
  protected readonly conflicts = this.#registry.conflicts;

  constructor() {
    // The heading exists once the translations have loaded: focus it the first time it appears.
    effect(() => {
      const heading = this.headingRef();
      if (heading !== undefined && !this.#focused) {
        this.#focused = true;
        heading.nativeElement.focus();
      }
    });
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
  }

  protected chordsOf(command: ListedCommand): readonly string[] {
    return command.chords.flatMap((text) => {
      const chord = parseChord(text);
      return chord === null ? [] : [displayChord(chord, this.#platform)];
    });
  }

  protected problemOf(error: unknown): string {
    return isEngineProblem(error) ? error.problem.title : '';
  }

  protected saveText(t: Translate): string {
    switch (this.store.saveStatus()) {
      case 'saving':
        return t('palette.shortcuts.saving');
      case 'saved':
        return t('palette.shortcuts.saved');
      default:
        return '';
    }
  }

  #titles(ids: readonly string[]): string {
    const listed = this.#registry.commands();
    return ids
      .map((id) => listed.find((c) => c.id === id)?.title ?? id)
      .join(', ');
  }

  protected conflictText(conflict: KeymapConflict, t: Translate): string {
    const parsed = parseChord(conflict.chord);
    const chord =
      parsed === null ? conflict.chord : displayChord(parsed, this.#platform);
    return t(`palette.shortcuts.conflict.${conflict.kind}`, {
      chord,
      titles: this.#titles(conflict.ids),
    });
  }

  protected refusalText(refusal: Refusal, t: Translate): string {
    const parsed = parseChord(refusal.chord);
    const chord =
      parsed === null ? refusal.chord : displayChord(parsed, this.#platform);
    const titles =
      refusal.result.reason === 'conflict'
        ? this.#titles(refusal.result.with)
        : '';
    return t(`palette.shortcuts.refused.${refusal.result.reason}`, {
      chord,
      titles,
    });
  }

  protected capture(command: ListedCommand, event: Event): void {
    this.#trigger =
      event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    this.refusal.set(null);
    this.capturing.set(command.id);
    this.#trigger?.focus();
  }

  protected replace(refusal: Refusal): void {
    const result = this.store.assign(refusal.id, refusal.chord, {
      replace: true,
    });
    this.refusal.set(
      result.ok ? null : { id: refusal.id, chord: refusal.chord, result },
    );
  }

  protected onKey(event: KeyboardEvent): void {
    const id = this.capturing();
    if (id !== null) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        this.capturing.set(null);
        this.#trigger?.focus();
        return;
      }
      const chord = chordOfEvent(event, this.#platform);
      if (chord === null) return; // only a modifier so far
      const text = formatChord(chord);
      const result = this.store.assign(id, text);
      this.capturing.set(null);
      this.refusal.set(result.ok ? null : { id, chord: text, result });
      this.#trigger?.focus();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }
    const dialog = this.dialogRef()?.nativeElement;
    if (dialog !== undefined) trapTab(event, dialog);
  }

  protected close(): void {
    this.#control.closeShortcuts();
  }
}
