// A WAI-ARIA window splitter: a focusable `separator` that carries the size of the pane it
// resizes in `aria-valuenow` (with min and max), moves with the arrow keys, Home and End, and
// drags with the pointer. It only reports the size the person asks for; the store decides what
// stays (OQ-527: written locally to the pattern until the aria wrappers are in the catalog).
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';

import { stepFor } from '../keyboard';

@Component({
  selector: 'app-splitter',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
  host: {
    role: 'separator',
    tabindex: '0',
    '[attr.aria-orientation]': 'orientation()',
    '[attr.aria-valuenow]': 'value()',
    '[attr.aria-valuemin]': 'min()',
    '[attr.aria-valuemax]': 'max()',
    '[attr.aria-label]': 'label()',
    '[attr.data-orientation]': 'orientation()',
    '[class.dragging]': 'dragging()',
    '(keydown)': 'onKeydown($event)',
    '(pointerdown)': 'onPointerDown($event)',
    '(pointermove)': 'onPointerMove($event)',
    '(pointerup)': 'onPointerEnd($event)',
    '(pointercancel)': 'onPointerEnd($event)',
  },
  styles: `
    :host {
      display: block;
      flex: none;
      background: var(--ds-color-border);
      touch-action: none;
    }
    :host([data-orientation='vertical']) {
      width: 4px;
      cursor: col-resize;
    }
    :host([data-orientation='horizontal']) {
      height: 4px;
      cursor: row-resize;
    }
    :host(:hover),
    :host(.dragging) {
      background: var(--ds-color-accent);
    }
    :host(:focus-visible) {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: -1px;
    }
  `,
})
export class Splitter {
  /** `vertical` is a vertical bar that resizes a width; `horizontal` resizes a height. */
  readonly orientation = input.required<'vertical' | 'horizontal'>();
  /** The size of the pane in pixels (or the share of a group, in the units of the caller). */
  readonly value = input.required<number>();
  readonly min = input.required<number>();
  readonly max = input.required<number>();
  /** The accessible name, already translated. */
  readonly label = input.required<string>();
  /** True when the pane lies after the bar, so moving the bar toward the start grows it. */
  readonly reverse = input(false);
  readonly step = input(16);
  readonly resized = output<number>();

  protected readonly dragging = signal(false);
  #startPointer = 0;
  #startValue = 0;

  readonly #sign = computed(() => (this.reverse() ? -1 : 1));

  protected onKeydown(event: KeyboardEvent): void {
    const vertical = this.orientation() === 'vertical';
    const step = stepFor(event.key, vertical ? 'horizontal' : 'vertical');
    let next: number;
    if (event.key === 'Home') next = this.min();
    else if (event.key === 'End') next = this.max();
    else if (step === 0) return;
    else next = this.value() + step * this.#sign() * this.step();
    event.preventDefault();
    this.#emit(next);
  }

  protected onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    this.dragging.set(true);
    this.#startPointer = this.#position(event);
    this.#startValue = this.value();
    // jsdom has no pointer capture; browsers do.
    (event.currentTarget as Partial<HTMLElement>).setPointerCapture?.(
      event.pointerId,
    );
    event.preventDefault();
  }

  protected onPointerMove(event: PointerEvent): void {
    if (!this.dragging()) return;
    const moved = this.#position(event) - this.#startPointer;
    this.#emit(this.#startValue + moved * this.#sign());
  }

  protected onPointerEnd(event: PointerEvent): void {
    if (!this.dragging()) return;
    this.dragging.set(false);
    (event.currentTarget as Partial<HTMLElement>).releasePointerCapture?.(
      event.pointerId,
    );
  }

  #position(event: PointerEvent): number {
    return this.orientation() === 'vertical' ? event.clientX : event.clientY;
  }

  #emit(raw: number): void {
    const next = Math.round(Math.min(this.max(), Math.max(this.min(), raw)));
    if (next !== this.value()) this.resized.emit(next);
  }
}
