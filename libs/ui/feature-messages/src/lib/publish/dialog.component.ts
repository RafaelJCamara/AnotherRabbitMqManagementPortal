// A modal dialog (R11): `role="dialog"`, labelled by its heading, Cancel focused first (the safe answer), Escape
// cancels, Tab stays inside, and focus goes back to the control that opened it. While a call is on its way nothing
// can be pressed again and Escape does nothing. The confirm button can be held closed with a reason that stays
// readable (`aria-disabled`, not `disabled`). It renders words it is given and the engine's Problem as text; it
// decides nothing. A copy of the confirmation dialog of the connections pages (#281).
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

import type { ProblemView } from './problem';
import { ProblemAlert } from './problem-alert.component';

let nextId = 0;

/** The elements a Tab can land on inside the dialog. */
const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled])';

@Component({
  selector: 'app-dialog',
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
          <button
            type="button"
            class="primary"
            [attr.aria-disabled]="busy() || confirmClosed() ? 'true' : null"
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
      width: min(36rem, 100%);
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
export class Dialog {
  readonly heading = input.required<string>();
  readonly confirmLabel = input.required<string>();
  readonly cancelLabel = input.required<string>();
  /** The confirm button's text while the call runs. */
  readonly busyLabel = input.required<string>();
  /** A call is on its way: nothing can be pressed and Escape does nothing. */
  readonly busy = input(false);
  /** The confirm button does nothing yet (the reason is in the body); it stays focusable. */
  readonly confirmClosed = input(false);
  /** The failure of the last call, as received. */
  readonly problem = input<ProblemView | null>(null);

  readonly confirmed = output();
  readonly cancelled = output();

  protected readonly titleId = `publish-dialog-title-${String(nextId)}`;
  protected readonly bodyId = `publish-dialog-body-${String(nextId++)}`;

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
    if (!this.busy() && !this.confirmClosed()) this.confirmed.emit();
  }

  protected onCancel(): void {
    if (!this.busy()) this.cancelled.emit();
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
