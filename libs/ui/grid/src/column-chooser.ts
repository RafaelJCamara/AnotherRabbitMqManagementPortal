// The grid's column chooser (the chooser half of AC-12). AG Grid's column tool panel is Enterprise.
// A disclosure button opens a panel with one row per column: show or hide it, move it up or down,
// set its width; and a reset. At least one column stays visible. Every change is a new
// `GridColumnState` the grid applies and the feature can store; the chooser holds no state of its own.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import {
  COLUMN_MAX_WIDTH,
  defaultColumnState,
  hideColumn,
  moveColumn,
  resizeColumn,
  showColumn,
  type GridColumnState,
} from './column-state';
import { COLUMN_MIN_WIDTH, type ResolvedColumn } from './columns';
import { fillLabel } from './status-bar';

/** The words of the chooser, already translated. `{name}` marks where a column's header goes. */
export interface GridColumnChooserLabels {
  /** The button that opens the chooser. */
  readonly button: string;
  /** The accessible name of the panel. */
  readonly title: string;
  readonly up: string;
  readonly down: string;
  /** For example "Move {name} up". */
  readonly moveUp: string;
  /** For example "Move {name} down". */
  readonly moveDown: string;
  /** For example "Width of {name}". */
  readonly width: string;
  readonly reset: string;
  /** Said when the last visible column cannot be hidden. */
  readonly lastColumn: string;
}

interface Entry {
  readonly id: string;
  readonly header: string;
  readonly hidden: boolean;
  readonly width: number;
  readonly index: number;
  /** The only visible column: it cannot be hidden. */
  readonly last: boolean;
}

let nextChooser = 0;

@Component({
  selector: 'app-grid-column-chooser',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      #toggle
      type="button"
      class="toggle"
      [attr.aria-expanded]="open()"
      [attr.aria-controls]="panelId"
      (click)="open.set(!open())"
    >
      {{ labels().button }}
    </button>
    @if (open()) {
      <div
        class="panel"
        role="group"
        [id]="panelId"
        [attr.aria-label]="labels().title"
        (keydown.escape)="close()"
      >
        <ul class="list">
          @for (entry of entries(); track entry.id) {
            <li class="entry">
              <label class="show">
                <input
                  type="checkbox"
                  [checked]="!entry.hidden"
                  [attr.aria-disabled]="entry.last ? 'true' : null"
                  [attr.aria-describedby]="entry.last ? noteId : null"
                  (change)="onShow(entry, $event)"
                />
                {{ entry.header }}
              </label>
              <button
                type="button"
                class="step"
                [disabled]="entry.index === 0"
                [attr.aria-label]="name(labels().moveUp, entry)"
                (click)="move(entry, entry.index - 1)"
              >
                {{ labels().up }}
              </button>
              <button
                type="button"
                class="step"
                [disabled]="entry.index === entries().length - 1"
                [attr.aria-label]="name(labels().moveDown, entry)"
                (click)="move(entry, entry.index + 1)"
              >
                {{ labels().down }}
              </button>
              <input
                type="number"
                class="width"
                [min]="minWidth"
                [max]="maxWidth"
                step="10"
                [value]="entry.width"
                [attr.aria-label]="name(labels().width, entry)"
                (change)="onWidth(entry, $event)"
              />
            </li>
          }
        </ul>
        @if (onlyOneVisible()) {
          <p class="note" [id]="noteId">{{ labels().lastColumn }}</p>
        }
        <button type="button" class="reset" (click)="reset()">
          {{ labels().reset }}
        </button>
      </div>
    }
  `,
  styles: `
    :host {
      position: relative;
      display: inline-block;
    }
    .toggle,
    .step,
    .reset {
      min-height: var(--ds-target-size);
      padding: 0 var(--ds-space-3);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface);
      color: var(--ds-color-text);
      font: inherit;
      cursor: pointer;
    }
    .toggle:focus-visible,
    .step:focus-visible,
    .reset:focus-visible,
    input:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 2px;
    }
    .panel {
      position: absolute;
      z-index: 900;
      min-width: 20rem;
      max-height: 24rem;
      overflow: auto;
      padding: var(--ds-space-3);
      background: var(--ds-color-surface-raised);
      color: var(--ds-color-text);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      font-size: var(--ds-font-size);
    }
    .list {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .entry {
      display: flex;
      align-items: center;
      gap: var(--ds-space-2);
      padding: var(--ds-space-1) 0;
    }
    .show {
      flex: 1 1 auto;
    }
    .width {
      width: 5rem;
    }
    .note {
      color: var(--ds-color-text-muted);
    }
  `,
})
export class GridColumnChooser<Row> {
  readonly columns = input.required<readonly ResolvedColumn<Row>[]>();
  /** The state in force: the chooser edits a copy and emits it. */
  readonly state = input.required<GridColumnState>();
  readonly labels = input.required<GridColumnChooserLabels>();
  /** A new state after the user hid, showed, moved or resized a column, or reset them. */
  readonly stateChange = output<GridColumnState>();

  protected readonly open = signal(false);
  protected readonly minWidth = COLUMN_MIN_WIDTH;
  protected readonly maxWidth = COLUMN_MAX_WIDTH;
  private readonly id = nextChooser++;
  protected readonly panelId = `app-grid-chooser-${String(this.id)}`;
  protected readonly noteId = `${this.panelId}-note`;
  private readonly toggle =
    viewChild.required<ElementRef<HTMLElement>>('toggle');

  protected readonly entries = computed<readonly Entry[]>(() => {
    const headers = new Map(this.columns().map((c) => [c.id, c.header]));
    const state = this.state();
    const visible = state.columns.filter((c) => c.hidden !== true).length;
    return state.columns.map((c, index) => ({
      id: c.id,
      header: headers.get(c.id) ?? c.id,
      hidden: c.hidden === true,
      width: c.width ?? 0,
      index,
      last: c.hidden !== true && visible === 1,
    }));
  });

  protected readonly onlyOneVisible = computed(() =>
    this.entries().some((entry) => entry.last),
  );

  protected name(template: string, entry: Entry): string {
    return fillLabel(template, { name: entry.header });
  }

  protected onShow(entry: Entry, event: Event): void {
    const input = event.target as HTMLInputElement;
    const state = this.state();
    const next = input.checked
      ? showColumn(state, entry.id)
      : hideColumn(state, entry.id);
    if (next === state) {
      // Refused (the last visible column): the box goes back to what is true.
      input.checked = !entry.hidden;
      return;
    }
    this.stateChange.emit(next);
  }

  protected move(entry: Entry, toIndex: number): void {
    this.stateChange.emit(moveColumn(this.state(), entry.id, toIndex));
  }

  protected onWidth(entry: Entry, event: Event): void {
    const input = event.target as HTMLInputElement;
    const next = resizeColumn(
      this.state(),
      this.columns(),
      entry.id,
      input.valueAsNumber,
    );
    input.value = String(
      next.columns.find((c) => c.id === entry.id)?.width ?? entry.width,
    );
    if (next !== this.state()) this.stateChange.emit(next);
  }

  protected reset(): void {
    // Order, visibility and widths go back to the defaults; the sort is not a column layout.
    this.stateChange.emit({
      ...defaultColumnState(this.columns()),
      sort: this.state().sort,
    });
  }

  protected close(): void {
    this.open.set(false);
    this.toggle().nativeElement.focus();
  }
}
