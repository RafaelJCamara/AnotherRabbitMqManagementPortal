// A facet of the filter as a disclosure panel (M0-54, R5, R13): a button that opens a group of labelled
// checkboxes, and a field to type another exact value (the engine has no list of vhosts or states to
// offer, so any value may be typed). It writes to the WAI-ARIA disclosure pattern locally, like the
// grid's column chooser, and holds no filter of its own: the bar decides what an edit means.
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

let nextPicker = 0;

@Component({
  selector: 'app-facet-picker',
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
      {{ label() }}
      @if (selected().length > 0) {
        <span class="count">{{ selected().length }}</span>
      }
    </button>
    @if (open()) {
      <div
        class="panel"
        role="group"
        [id]="panelId"
        [attr.aria-label]="label()"
        (keydown.escape)="close()"
      >
        @for (value of values(); track value) {
          <label class="option">
            <input
              type="checkbox"
              [checked]="selected().includes(value)"
              (change)="onToggle(value, $event)"
            />
            <span>{{ value }}</span>
          </label>
        }
        <div class="add">
          <label>
            <span>{{ addLabel() }}</span>
            <input
              #typed
              type="text"
              maxlength="255"
              (keydown.enter)="addTyped($event)"
            />
          </label>
          <button type="button" class="add-button" (click)="addTyped()">
            {{ addButton() }}
          </button>
        </div>
        @if (reason(); as why) {
          <p class="reason" role="status">{{ why }}</p>
        }
      </div>
    }
  `,
  styles: `
    :host {
      position: relative;
      display: inline-block;
    }
    .toggle,
    .add-button {
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
    .add-button:focus-visible,
    input:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 2px;
    }
    .count {
      margin-inline-start: var(--ds-space-2);
      font-weight: 600;
    }
    .panel {
      position: absolute;
      z-index: 5;
      min-width: 14rem;
      padding: var(--ds-space-3);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface-raised);
      display: flex;
      flex-direction: column;
      gap: var(--ds-space-2);
    }
    .option,
    .add {
      display: flex;
      align-items: center;
      gap: var(--ds-space-2);
    }
    .reason {
      margin: 0;
      color: var(--ds-color-text-danger);
    }
  `,
})
export class FacetPicker {
  /** The facet's name, already translated; also the accessible name of the panel. */
  readonly label = input.required<string>();
  /** Values offered as checkboxes; any value may also be typed. */
  readonly options = input<readonly string[]>([]);
  readonly selected = input.required<readonly string[]>();
  readonly addLabel = input.required<string>();
  readonly addButton = input.required<string>();
  /** Why the last edit was refused (a cap), or `null`. */
  readonly reason = input<string | null>(null);
  readonly add = output<string>();
  readonly remove = output<string>();

  protected readonly open = signal(false);
  protected readonly panelId = `app-facet-panel-${String(nextPicker++)}`;
  private readonly toggle =
    viewChild.required<ElementRef<HTMLButtonElement>>('toggle');
  private readonly typed = viewChild<ElementRef<HTMLInputElement>>('typed');

  /** The suggestions, then any selected value that is not one of them, so every selection can be unchecked. */
  protected readonly values = computed(() => {
    const offered = this.options();
    return [...offered, ...this.selected().filter((v) => !offered.includes(v))];
  });

  protected onToggle(value: string, event: Event): void {
    const checked =
      event.target instanceof HTMLInputElement && event.target.checked;
    if (checked) this.add.emit(value);
    else this.remove.emit(value);
  }

  protected addTyped(event?: Event): void {
    event?.preventDefault();
    const field = this.typed()?.nativeElement;
    const value = field?.value ?? '';
    if (field) field.value = '';
    if (value !== '') this.add.emit(value);
  }

  protected close(): void {
    this.open.set(false);
    this.toggle().nativeElement.focus();
  }
}
