// <app-gated>: a control whose availability is decided by the engine (blueprint 10, DC-31). The
// UI never computes authorisation, so the component takes the `GateDecision` the engine sent and
// does two things with it: it refuses activation unless `enabled` is exactly true (a missing gate
// is a disabled one), and it says why, with the source, where a keyboard and a screen reader find
// it.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import type { GateDecision } from '@app/contracts';

import { parseSourceLink } from './source-link';

/** The words around a gate's reason. The caller supplies them already translated. */
export interface GatedLabels {
  /** Introduces the reason of a disabled control. */
  readonly whyDisabled: string;
  /** Introduces the reason of a control that works with limits. */
  readonly degraded: string;
  /** Names the source of the decision; the link text is this and the host name. */
  readonly source: string;
  /** Shown when the engine disabled the control and gave no reason. */
  readonly noReason: string;
}

let nextInstance = 0;

@Component({
  selector: 'app-gated',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      #control
      type="button"
      class="control"
      [attr.aria-disabled]="enabled() ? null : 'true'"
      [attr.aria-describedby]="reasonId"
      (click)="activated.emit($event)"
    >
      <ng-content />
    </button>
    <span class="reason" [id]="reasonId" aria-live="polite">
      @if (showReason()) {
        <span class="reason-kind">{{ kindLabel() }}</span
        >&ngsp;
        @if (reasonText()) {
          <span class="reason-text">{{ reasonText() }}</span
          >&ngsp;
        }
        @if (link(); as link) {
          <a
            class="reason-source"
            [href]="link.href"
            target="_blank"
            rel="noopener noreferrer"
            >{{ labels().source }} {{ link.host }}</a
          >
        } @else if (gate()?.source) {
          <span class="reason-source"
            >{{ labels().source }} {{ gate()?.source }}</span
          >
        }
      }
    </span>
  `,
  styles: `
    :host {
      display: inline-flex;
      flex-direction: column;
      gap: var(--ds-space-1);
      font-size: var(--ds-font-size);
    }
    .control {
      min-height: var(--ds-target-size);
      min-width: var(--ds-target-size);
      padding: 0 var(--ds-space-3);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-accent);
      color: var(--ds-color-on-accent);
      font: inherit;
      cursor: pointer;
    }
    .control[aria-disabled='true'] {
      background: var(--ds-color-surface-sunken);
      color: var(--ds-color-text-muted);
      border-style: dashed;
      cursor: not-allowed;
    }
    .control:focus-visible,
    .reason-source:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 2px;
    }
    .reason {
      color: var(--ds-color-text-muted);
    }
    .reason-kind {
      font-weight: 600;
      margin-inline-end: var(--ds-space-1);
    }
    .reason-source {
      margin-inline-start: var(--ds-space-2);
      color: var(--ds-color-text-link);
    }
  `,
})
export class Gated {
  /**
   * What the engine decided for this control. `null` or `undefined` (not loaded yet, or no gate
   * known) disables the control: a gate that is not known is not an open gate.
   */
  readonly gate = input.required<GateDecision | null | undefined>();
  readonly labels = input.required<GatedLabels>();
  /** Emits when the user activates the control, and only while the gate is enabled. */
  readonly activated = output<MouseEvent>();

  protected readonly reasonId = `app-gated-reason-${String(nextInstance++)}`;
  private readonly control =
    viewChild.required<ElementRef<HTMLButtonElement>>('control');

  /** True only for `enabled: true`; any other value of any other shape is a closed gate. */
  readonly enabled = computed(() => this.gate()?.enabled === true);
  protected readonly degraded = computed(
    () => this.enabled() && this.gate()?.mode === 'degraded',
  );
  protected readonly showReason = computed(
    () => !this.enabled() || this.degraded(),
  );
  protected readonly kindLabel = computed(() =>
    this.degraded() ? this.labels().degraded : this.labels().whyDisabled,
  );
  protected readonly reasonText = computed(() => {
    const reason = this.gate()?.reason?.trim() ?? '';
    if (reason !== '' || this.degraded()) return reason;
    return this.labels().noReason;
  });
  protected readonly link = computed(() =>
    parseSourceLink(this.gate()?.source),
  );

  constructor() {
    // A click, or Enter or Space on the button (browsers turn both into a click), is stopped
    // before it reaches any listener on `<app-gated>` itself or on an ancestor while the gate is
    // closed. That includes `(click)` written on the element by a caller, so the only way to
    // react to the control is `(activated)`. The capture phase runs before every such listener,
    // and only clicks that land on the button are held back: the source link keeps working.
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const guard = (event: Event): void => {
      const target = event.target;
      if (
        !this.enabled() &&
        target instanceof Node &&
        this.control().nativeElement.contains(target)
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    host.addEventListener('click', guard, { capture: true });
    inject(DestroyRef).onDestroy(() => {
      host.removeEventListener('click', guard, { capture: true });
    });
  }
}
