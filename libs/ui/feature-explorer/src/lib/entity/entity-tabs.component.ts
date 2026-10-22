// The tab strip of an entity page (M1-42, R2 and R9): a WAI-ARIA tab list with one tab stop (roving tabindex),
// Left, Right, Home and End to move, a click (or Enter or Space, which press the button) to choose. A tab that
// cannot be used is `aria-disabled` and stays focusable, so its reason is read where it is found; it cannot be
// chosen. The reason is the engine's, as sent, for a closed gate.
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  input,
  output,
} from '@angular/core';
import type { EntityTabId } from '@app/explorer-model';
import { TranslocoDirective } from '@jsverse/transloco';

import type { Translate } from '../translate';
import { unavailableText, type TabUnavailable } from './entity-tab-state';

export interface StripTab {
  readonly id: EntityTabId;
  /** `null` when the tab can be used; otherwise why not. */
  readonly unavailable: TabUnavailable | null;
}

@Component({
  selector: 'app-entity-tabs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      <div class="strip" role="tablist" [attr.aria-label]="label()">
        @for (tab of tabs(); track tab.id) {
          <button
            type="button"
            role="tab"
            class="tab"
            [id]="'entity-tab-' + tab.id"
            [attr.data-tab]="tab.id"
            [attr.aria-selected]="tab.id === selected()"
            aria-controls="entity-panel"
            [attr.aria-disabled]="tab.unavailable === null ? null : 'true'"
            [attr.aria-describedby]="
              tab.unavailable === null ? null : 'entity-tab-reason-' + tab.id
            "
            [tabindex]="tab.id === selected() ? 0 : -1"
            (click)="choose(tab)"
            (keydown)="onKeydown($event, tab)"
          >
            {{ t('explorer.entity.tabs.' + tab.id) }}
          </button>
          @if (tab.unavailable; as why) {
            <span class="sr-only" [id]="'entity-tab-reason-' + tab.id">{{
              reason(why, t)
            }}</span>
          }
        }
      </div>
    </ng-container>
  `,
  styles: `
    :host {
      display: block;
    }
    .strip {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ds-space-1);
      border-block-end: 1px solid var(--ds-color-border);
    }
    .tab {
      min-height: var(--ds-target-size);
      padding: var(--ds-space-1) var(--ds-space-3);
      border: 1px solid transparent;
      border-block-end: 2px solid transparent;
      background: none;
      color: var(--ds-color-text);
      font: inherit;
      cursor: pointer;
    }
    .tab[aria-selected='true'] {
      border-block-end-color: var(--ds-color-accent);
      font-weight: 600;
    }
    .tab[aria-disabled='true'] {
      color: var(--ds-color-text-muted);
      cursor: not-allowed;
      text-decoration: line-through;
      text-decoration-thickness: 1px;
    }
    .tab:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: -2px;
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  `,
})
export class EntityTabs {
  readonly tabs = input.required<readonly StripTab[]>();
  readonly selected = input.required<EntityTabId>();
  /** The accessible name of the strip. */
  readonly label = input.required<string>();
  /** A tab that can be used was chosen. */
  readonly chosen = output<EntityTabId>();

  readonly #host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected reason(why: TabUnavailable, t: Translate): string {
    return unavailableText(why, t);
  }

  protected choose(tab: StripTab): void {
    if (tab.unavailable === null) this.chosen.emit(tab.id);
  }

  protected onKeydown(event: KeyboardEvent, tab: StripTab): void {
    const all = this.tabs();
    const at = all.findIndex((candidate) => candidate.id === tab.id);
    let to: number;
    switch (event.key) {
      case 'ArrowRight':
        to = (at + 1) % all.length;
        break;
      case 'ArrowLeft':
        to = (at - 1 + all.length) % all.length;
        break;
      case 'Home':
        to = 0;
        break;
      case 'End':
        to = all.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const next = all[to];
    if (next === undefined) return;
    this.#host.nativeElement
      .querySelector<HTMLElement>(`[data-tab="${next.id}"]`)
      ?.focus();
  }
}
