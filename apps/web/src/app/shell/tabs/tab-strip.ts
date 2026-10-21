import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { rovingIndex } from '../keyboard';
import type { EditorGroup } from '../layout/shell-layout';

/**
 * The tabs of one editor group (WAI-ARIA tabs, manual activation): the strip is one tab stop with
 * roving focus; the arrows, Home and End move focus, Enter or Space (or a click) shows the tab and
 * Delete closes it. The close buttons are for the pointer and are not tab stops, so the strip stays
 * one stop for the keyboard. A tab's title is a Transloco key (fixed tabs) or engine data (entity
 * tabs), rendered as text.
 */
@Component({
  selector: 'app-tab-strip',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      role="tablist"
      aria-orientation="horizontal"
      [attr.aria-label]="'shell.tabs.list' | transloco"
    >
      @for (tab of group().tabs; track tab.id) {
        <div
          class="tab"
          role="presentation"
          [class.selected]="tab.id === group().activeTab"
        >
          <button
            type="button"
            role="tab"
            [id]="tabDomId(tab.id)"
            [attr.data-tab]="tab.id"
            [attr.aria-selected]="tab.id === group().activeTab"
            [attr.aria-controls]="'group-body-' + index()"
            [tabindex]="tab.id === stop() ? 0 : -1"
            (click)="activateTab.emit(tab.id)"
            (focus)="focused.set(tab.id)"
            (keydown)="onKeydown($event, tab.id)"
          >
            @if (tab.titleKey) {
              {{ tab.titleKey | transloco }}
            } @else {
              {{ tab.label }}
            }
          </button>
          <button
            type="button"
            class="close"
            tabindex="-1"
            [id]="closeDomId(tab.id)"
            [attr.aria-label]="'shell.tabs.close' | transloco"
            [attr.aria-labelledby]="closeDomId(tab.id) + ' ' + tabDomId(tab.id)"
            (click)="closeTab.emit(tab.id)"
          ></button>
        </div>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
      overflow: hidden;
    }
    [role='tablist'] {
      display: flex;
      min-width: 0;
      overflow: hidden;
    }
    .tab {
      display: flex;
      flex: 0 1 auto;
      min-width: 0;
      align-items: center;
      border-inline-end: 1px solid var(--ds-color-border);
      border-block-end: 2px solid transparent;
    }
    .tab.selected {
      border-block-end-color: var(--ds-color-accent);
      background: var(--ds-color-surface);
    }
    button {
      min-height: var(--ds-row-height);
      font: inherit;
      color: var(--ds-color-text);
      background: none;
      border: 0;
      cursor: pointer;
    }
    [role='tab'] {
      min-width: 0;
      padding: 0 var(--ds-space-2);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .close {
      flex: none;
      min-width: var(--ds-row-height);
      color: var(--ds-color-text-muted);
    }
    .close::before {
      content: '\\00d7';
    }
    button:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: -2px;
    }
  `,
})
export class TabStrip {
  readonly group = input.required<EditorGroup>();
  /** The index of the group, for the id of the panel the tabs control. */
  readonly index = input.required<number>();
  readonly activateTab = output<string>();
  readonly closeTab = output<string>();

  readonly #host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly focused = signal<string | null>(null);
  /** The one tab that is a tab stop: the focused one, else the active one, else the first. */
  protected readonly stop = computed(() => {
    const { tabs, activeTab } = this.group();
    const ids = tabs.map((tab) => tab.id);
    const focused = this.focused();
    if (focused !== null && ids.includes(focused)) return focused;
    return activeTab !== null && ids.includes(activeTab) ? activeTab : ids[0];
  });

  protected onKeydown(event: KeyboardEvent, id: string): void {
    const ids = this.group().tabs.map((tab) => tab.id);
    if (event.key === 'Delete') {
      event.preventDefault();
      this.closeTab.emit(id);
      return;
    }
    const next = rovingIndex(
      event.key,
      ids.indexOf(id),
      ids.length,
      'horizontal',
    );
    const target = next === null ? undefined : ids[next];
    if (target === undefined) return;
    event.preventDefault();
    this.focused.set(target);
    this.focusTab(target);
  }

  /** Moves focus to a tab of this strip. */
  focusTab(id: string): void {
    const tabs =
      this.#host.nativeElement.querySelectorAll<HTMLElement>('[role="tab"]');
    for (const tab of tabs) {
      if (tab.dataset.tab === id) tab.focus();
    }
  }

  protected tabDomId(id: string): string {
    return `tab-${String(this.index())}-${id}`;
  }

  protected closeDomId(id: string): string {
    return `close-${String(this.index())}-${id}`;
  }
}
