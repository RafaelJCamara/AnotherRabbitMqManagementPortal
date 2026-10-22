// The confirmation dialog of the connections pages (M0-52, R5, R10, R11): used by the unlock and by the delete.
// A modal `role="dialog"`: labelled by its heading, described by its body, Cancel focused first (the safe
// answer), Escape cancels, Tab stays inside, and focus goes back to the control that opened it. While a call is on
// its way nothing can be pressed again and Escape does nothing. A failure of that call stays in the dialog as sent.
// It renders words it is given (already translated) and the engine's Problem as text; it decides nothing.
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';

import type { ProblemView } from '../problem';
import { ProblemAlert } from '../problem-alert.component';

let nextId = 0;

/** The elements a Tab can land on inside the dialog. */
const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled])';

@Component({
  selector: 'app-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ProblemAlert],
  template: `
    <div class="backdrop">
      <div
        #panel
        class="dialog"
        role="dialog"
        aria-modal="true"
        [attr.aria-labelledby]="titleId"
        [attr.aria-describedby]="bodyId"
        (keydown)="onKeydown($event)"
      >
        <h2 [id]="titleId">{{ heading() }}</h2>
        <div class="body" [id]="bodyId"><ng-content /></div>
        @if (problem(); as problem) {
          <app-problem-alert [problem]="problem" />
        }
        <div class="actions">
          <button
            #cancel
            type="button"
            class="secondary"
            [attr.aria-disabled]="busy() ? 'true' : null"
            (click)="onCancel()"
          >
            {{ cancelLabel() }}
          </button>
          @if (extraLabel(); as label) {
            <button
              type="button"
              class="secondary"
              [attr.aria-disabled]="busy() ? 'true' : null"
              (click)="onExtra()"
            >
              {{ label }}
            </button>
          }
          <button
            type="button"
            class="primary"
            [class.danger]="danger()"
            [attr.aria-disabled]="busy() ? 'true' : null"
            (click)="onConfirm()"
          >
            {{ busy() ? busyLabel() : confirmLabel() }}
          </button>
        </div>
      </div>
    </div>
  `,
  styles: `
    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 10;
      display: grid;
      place-items: center;
      padding: var(--ds-space-4);
      background: rgb(0 0 0 / 45%);
    }
    .dialog {
      box-sizing: border-box;
      width: min(32rem, 100%);
      max-height: 100%;
      overflow: auto;
      padding: var(--ds-space-4);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface-raised);
      color: var(--ds-color-text);
    }
    h2 {
      margin: 0 0 var(--ds-space-3);
      font-size: 1.15em;
    }
    .body {
      margin-bottom: var(--ds-space-3);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ds-space-2);
      justify-content: flex-end;
      margin-top: var(--ds-space-3);
    }
    button {
      min-height: var(--ds-target-size);
      min-width: var(--ds-target-size);
      padding: 0 var(--ds-space-3);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      font: inherit;
      cursor: pointer;
    }
    .secondary {
      background: var(--ds-color-surface);
      color: var(--ds-color-text);
    }
    .primary {
      background: var(--ds-color-accent);
      color: var(--ds-color-on-accent);
    }
    .primary.danger {
      background: var(--ds-color-danger);
      color: var(--ds-color-on-danger);
    }
    button[aria-disabled='true'] {
      cursor: not-allowed;
      border-style: dashed;
      opacity: 0.7;
    }
    button:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 2px;
    }
  `,
})
export class ConfirmDialog {
  readonly heading = input.required<string>();
  readonly confirmLabel = input.required<string>();
  readonly cancelLabel = input.required<string>();
  /** The confirm button's text while the call runs. */
  readonly busyLabel = input.required<string>();
  /** A call is on its way: nothing can be pressed and Escape does nothing. */
  readonly busy = input(false);
  /** The confirm action is destructive (the delete). */
  readonly danger = input(false);
  /** The failure of the last call, as received. */
  readonly problem = input<ProblemView | null>(null);
  /** A third button (for example "Unlock this connection"), or `null` for none. */
  readonly extraLabel = input<string | null>(null);

  readonly confirmed = output();
  readonly cancelled = output();
  readonly extra = output();

  protected readonly titleId = `connections-dialog-title-${String(nextId)}`;
  protected readonly bodyId = `connections-dialog-body-${String(nextId++)}`;

  private readonly panel = viewChild.required<ElementRef<HTMLElement>>('panel');
  private readonly cancel =
    viewChild.required<ElementRef<HTMLButtonElement>>('cancel');
  /** Where focus was when the dialog opened: the control that opened it. */
  readonly #opener =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

  constructor() {
    afterNextRender(() => {
      this.cancel().nativeElement.focus();
    });
    inject(DestroyRef).onDestroy(() => {
      if (this.#opener?.isConnected === true) this.#opener.focus();
    });
  }

  protected onConfirm(): void {
    if (!this.busy()) this.confirmed.emit();
  }

  protected onCancel(): void {
    if (!this.busy()) this.cancelled.emit();
  }

  protected onExtra(): void {
    if (!this.busy()) this.extra.emit();
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    // Keep Tab inside: from the last control to the first, and back.
    const items = [
      ...this.panel().nativeElement.querySelectorAll<HTMLElement>(FOCUSABLE),
    ];
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) return;
    const here = document.activeElement;
    if (event.shiftKey && here === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && here === last) {
      event.preventDefault();
      first.focus();
    } else if (!this.panel().nativeElement.contains(here)) {
      event.preventDefault();
      first.focus();
    }
  }
}
