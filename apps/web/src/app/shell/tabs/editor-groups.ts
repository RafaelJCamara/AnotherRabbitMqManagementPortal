import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
} from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';

import { groupPixels, groupSplitBounds } from '../layout/fit-layout';
import { ShellLayoutStore } from '../layout/shell-layout-store';
import { ShellViewport } from '../layout/shell-viewport';
import { Splitter } from '../splitter/splitter';
import { TabStrip } from './tab-strip';
import { WorkspaceTabs } from './workspace-tabs';

/**
 * The editor area: up to the capped number of groups side by side (or stacked), each with its tab
 * strip and a body. The routed view is shown in the active group's body; another group says that
 * selecting one of its tabs shows it there. A group is closed only when it is empty, so closing a
 * group never loses a tab.
 */
@Component({
  selector: 'app-editor-groups',
  imports: [RouterOutlet, Splitter, TabStrip, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="groups" [attr.data-orientation]="layout().editor.orientation">
      @for (group of layout().editor.groups; track $index; let i = $index) {
        <section
          class="group"
          [class.active]="i === layout().editor.activeGroup"
          [style.flex-grow]="group.weight"
          [attr.aria-label]="'shell.editor.group' | transloco: { index: i + 1 }"
        >
          <div class="strip-row">
            <app-tab-strip
              [group]="group"
              [index]="i"
              (activateTab)="activate(i, $event)"
              (closeTab)="close(i, $event)"
            />
            <div class="actions">
              <button type="button" (click)="split()">
                {{ 'shell.editor.split' | transloco }}
              </button>
              @if (layout().editor.groups.length > 1) {
                <button type="button" (click)="tabs.toggleOrientation()">
                  {{ 'shell.editor.orientation' | transloco }}
                </button>
                <button
                  type="button"
                  [disabled]="group.tabs.length > 0"
                  (click)="tabs.closeGroup(i)"
                >
                  {{ 'shell.editor.closeGroup' | transloco }}
                </button>
              }
            </div>
          </div>
          <div
            class="group-body"
            role="tabpanel"
            tabindex="-1"
            [id]="'group-body-' + i"
            [attr.aria-label]="'shell.editor.body' | transloco"
          >
            @if (i === layout().editor.activeGroup) {
              <router-outlet />
            } @else if (group.tabs.length > 0) {
              <p class="hint">{{ 'shell.editor.inactive' | transloco }}</p>
            } @else {
              <p class="hint">{{ 'shell.editor.emptyGroup' | transloco }}</p>
            }
          </div>
        </section>
        @if (i < layout().editor.groups.length - 1) {
          <app-splitter
            [orientation]="
              layout().editor.orientation === 'row' ? 'vertical' : 'horizontal'
            "
            [label]="'shell.editor.resize' | transloco"
            [value]="sizes()[i] ?? 0"
            [min]="bounds(i).min"
            [max]="bounds(i).max"
            (resized)="tabs.resizeGroup(i, $event)"
          />
        }
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      height: 100%;
      min-width: 0;
      min-height: 0;
    }
    .groups {
      display: flex;
      height: 100%;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
    }
    .groups[data-orientation='column'] {
      flex-direction: column;
    }
    .group {
      display: flex;
      flex: 1 1 0;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
    }
    .strip-row {
      display: flex;
      flex: none;
      min-width: 0;
      background: var(--ds-color-surface-sunken);
      border-block-end: 1px solid var(--ds-color-border);
    }
    .strip-row app-tab-strip {
      flex: 1 1 auto;
    }
    .group.active .strip-row {
      border-block-end-color: var(--ds-color-accent);
    }
    .actions {
      display: flex;
      flex: none;
      gap: var(--ds-space-1);
      padding-inline: var(--ds-space-1);
    }
    .actions button {
      min-height: var(--ds-row-height);
      font: inherit;
      color: var(--ds-color-text-muted);
      background: none;
      border: 0;
      cursor: pointer;
    }
    .actions button:disabled {
      cursor: default;
      opacity: 0.5;
    }
    .actions button:focus-visible,
    .group-body:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: -2px;
    }
    .group-body {
      flex: 1;
      min-width: 0;
      min-height: 0;
      padding: var(--ds-space-3);
      overflow: auto;
    }
    .hint {
      margin: 0;
      color: var(--ds-color-text-muted);
    }
  `,
})
export class EditorGroups {
  protected readonly tabs = inject(WorkspaceTabs);
  readonly #store = inject(ShellLayoutStore);
  readonly #viewport = inject(ShellViewport);
  readonly #injector = inject(Injector);
  readonly #host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly layout = this.#store.layout;
  protected readonly sizes = computed(() =>
    groupPixels(this.layout(), this.#viewport.size()).map(Math.round),
  );

  protected bounds(index: number) {
    return groupSplitBounds(this.layout(), this.#viewport.size(), index);
  }

  protected activate(groupIndex: number, tabId: string): void {
    this.tabs.activate(groupIndex, tabId);
  }

  protected split(): void {
    this.tabs.split();
  }

  /** Closes a tab and moves focus to its neighbour, or to the group when none is left. */
  protected close(groupIndex: number, tabId: string): void {
    const neighbour = this.tabs.close(groupIndex, tabId);
    afterNextRender(
      () => {
        const group =
          this.#host.nativeElement.querySelectorAll<HTMLElement>('section')[
            groupIndex
          ];
        if (group === undefined) return;
        const tab = [
          ...group.querySelectorAll<HTMLElement>('[role="tab"]'),
        ].find((candidate) => candidate.dataset.tab === neighbour);
        (tab ?? group.querySelector<HTMLElement>('.group-body'))?.focus();
      },
      { injector: this.#injector },
    );
  }
}
