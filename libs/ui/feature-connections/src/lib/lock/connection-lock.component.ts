// The lock line of a connection and its unlock dialog (M0-52, R5). It shows what this page knows about the prod
// lock (`ArmingStore`: what its own `ops.arm` was answered, nothing else), offers Unlock for a production
// connection and Lock again while a window is open, and hosts the confirmation: the dialog names the connection and
// its class, says what the unlock allows and that it is recorded in the audit log, and calls `ops.arm` once on
// confirm. The engine decides and records; a refusal stays in the dialog as sent. A parent can open the dialog
// itself (`open()`), for the case where the engine refused a call with the lock and named the arming as the fix.
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import type { EnvClass } from '@app/contracts';
import { ArmingStore, lockGate } from '@app/ui-data';
import { TranslocoDirective } from '@jsverse/transloco';

import { ConfirmDialog } from '../dialog/confirm-dialog.component';
import { problemView, type ProblemView } from '../problem';
import { ProblemAlert } from '../problem-alert.component';

@Component({
  selector: 'app-connection-lock',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ConfirmDialog, ProblemAlert, TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      @if (visible()) {
        <div
          class="lock"
          role="group"
          [attr.aria-label]="t('connections.lock.region')"
          [attr.data-lock]="armed() ? 'armed' : 'locked'"
        >
          <span class="state">
            @if (armed()) {
              {{ t('connections.lock.armedUntil', { time: untilText() }) }}
            } @else {
              {{ t('connections.lock.locked') }}
            }
          </span>
          @if (armed()) {
            <button
              #main
              type="button"
              [attr.aria-disabled]="busy() ? 'true' : null"
              (click)="lockAgain()"
            >
              {{ t('connections.lock.lockAgain') }}
            </button>
          } @else {
            <button
              #main
              type="button"
              [attr.aria-disabled]="busy() ? 'true' : null"
              (click)="open()"
            >
              {{ t('connections.lock.unlock') }}
            </button>
          }
        </div>
        @if (lockError(); as error) {
          <app-problem-alert [problem]="error" />
        }
      }
      @if (dialogOpen()) {
        <app-confirm-dialog
          [heading]="t('connections.lock.dialog.title', { name: name() })"
          [confirmLabel]="t('connections.lock.dialog.confirm')"
          [cancelLabel]="t('connections.lock.dialog.cancel')"
          [busyLabel]="t('connections.lock.dialog.busy')"
          [busy]="busy()"
          [problem]="dialogError()"
          (confirmed)="confirm()"
          (cancelled)="close()"
        >
          <p>
            {{
              t('connections.lock.dialog.body', {
                name: name(),
                env: t('connections.env.' + envClass()),
              })
            }}
          </p>
          <p>{{ t('connections.lock.dialog.audit') }}</p>
        </app-confirm-dialog>
      }
    </ng-container>
  `,
  styles: `
    .lock {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ds-space-3);
      align-items: center;
      padding: var(--ds-space-2) var(--ds-space-3);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface-sunken);
    }
    .lock[data-lock='locked'] .state {
      color: var(--ds-color-text-danger);
      font-weight: 600;
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
    button[aria-disabled='true'] {
      cursor: not-allowed;
      border-style: dashed;
    }
    button:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 2px;
    }
  `,
})
export class ConnectionLock {
  readonly cid = input.required<string>();
  readonly name = input.required<string>();
  /** The class the engine sent; unset or unknown reads as production. */
  readonly envClass = input.required<EnvClass>();

  readonly #arming = inject(ArmingStore);
  readonly #injector = inject(Injector);
  private readonly main = viewChild<ElementRef<HTMLButtonElement>>('main');

  protected readonly busy = this.#arming.busy;
  protected readonly armed = computed(() => this.#arming.armed(this.cid())());
  /** Shown for a connection the lock applies to, and while a window is open. */
  protected readonly visible = computed(
    () =>
      this.armed() ||
      !lockGate({
        cid: this.cid(),
        envClass: this.envClass(),
        armed: false,
        reason: '',
      }).enabled,
  );
  protected readonly untilText = computed(() => {
    const end = this.#arming.until(this.cid());
    return end === null
      ? ''
      : new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(end);
  });
  protected readonly dialogOpen = signal(false);
  protected readonly dialogError = signal<ProblemView | null>(null);
  protected readonly lockError = signal<ProblemView | null>(null);

  /** Opens the confirmation. A parent calls this when the engine named the arming as the fix. */
  open(): void {
    this.dialogError.set(null);
    this.dialogOpen.set(true);
  }

  protected close(): void {
    this.dialogOpen.set(false);
  }

  protected async confirm(): Promise<void> {
    const outcome = await this.#arming.arm(this.cid());
    if (outcome.ok) {
      this.dialogError.set(null);
      this.dialogOpen.set(false);
      this.#focusMain();
    } else {
      this.dialogError.set(problemView(outcome.error));
    }
  }

  protected async lockAgain(): Promise<void> {
    const outcome = await this.#arming.disarm(this.cid());
    this.lockError.set(outcome.ok ? null : problemView(outcome.error));
    this.#focusMain();
  }

  /** The button that opened the dialog is replaced by its counterpart: focus goes to that. */
  #focusMain(): void {
    afterNextRender(
      () => {
        this.main()?.nativeElement.focus();
      },
      { injector: this.#injector },
    );
  }
}
