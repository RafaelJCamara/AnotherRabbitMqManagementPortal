import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';

import {
  setPanelVisible,
  setSidebarVisible,
  showActivity,
} from '../layout/layout-ops';
import { ShellLayoutStore } from '../layout/shell-layout-store';
import type { ActivityId } from '../layout/shell-layout';

/** An entry of the activity bar: a sidebar container that opens a route of the shell. */
export interface ActivityEntry {
  readonly id: ActivityId;
  readonly titleKey: string;
  /** Relative to `/c/:cid`. */
  readonly route: string;
}

/**
 * Only entries that have a registered route are shown, so nothing is listed that cannot open
 * (OQ-536). The rest of the product list joins as its features land.
 */
export const ACTIVITY_ENTRIES: readonly ActivityEntry[] = [
  { id: 'explorer', titleKey: 'shell.explorer.title', route: 'explorer' },
];

/** The activity bar: the entries that have a route, and the toggles of the sidebar and panel. */
@Component({
  selector: 'app-activity-bar',
  imports: [RouterLink, RouterLinkActive, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav [attr.aria-label]="'shell.activityBar' | transloco">
      @for (entry of entries; track entry.id) {
        <a
          [routerLink]="entry.route"
          routerLinkActive="active"
          ariaCurrentWhenActive="page"
          [title]="entry.titleKey | transloco"
          (click)="show(entry.id)"
          >{{ entry.titleKey | transloco }}</a
        >
      }
      <span class="spacer"></span>
      <button
        type="button"
        [attr.aria-pressed]="sidebarVisible()"
        [title]="'shell.activity.sidebar' | transloco"
        (click)="toggleSidebar()"
      >
        {{ 'shell.activity.sidebar' | transloco }}
      </button>
      <button
        type="button"
        [attr.aria-pressed]="panelVisible()"
        [title]="'shell.activity.panel' | transloco"
        (click)="togglePanel()"
      >
        {{ 'shell.activity.panel' | transloco }}
      </button>
    </nav>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
      overflow: hidden;
      background: var(--ds-color-surface-sunken);
      border-inline-end: 1px solid var(--ds-color-border);
    }
    nav {
      display: flex;
      flex-direction: column;
      gap: var(--ds-space-1);
      height: 100%;
      padding: var(--ds-space-2) var(--ds-space-1);
    }
    a,
    button {
      min-height: var(--ds-target-size);
      padding: var(--ds-space-1);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-align: center;
      font: inherit;
      color: var(--ds-color-text);
      background: none;
      border: 0;
      border-inline-start: 3px solid transparent;
      text-decoration: none;
      cursor: pointer;
    }
    a.active,
    button[aria-pressed='true'] {
      color: var(--ds-color-accent);
      border-inline-start-color: var(--ds-color-accent);
    }
    a:focus-visible,
    button:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
    }
    .spacer {
      flex: 1;
    }
  `,
})
export class ActivityBar {
  readonly #store = inject(ShellLayoutStore);
  protected readonly entries = ACTIVITY_ENTRIES;
  protected readonly sidebarVisible = computed(
    () => this.#store.layout().sidebar.visible,
  );
  protected readonly panelVisible = computed(
    () => this.#store.layout().panel.visible,
  );

  protected show(id: ActivityId): void {
    this.#store.update((layout) => showActivity(layout, id));
  }

  protected toggleSidebar(): void {
    this.#store.update((layout) =>
      setSidebarVisible(layout, !layout.sidebar.visible),
    );
  }

  protected togglePanel(): void {
    this.#store.update((layout) =>
      setPanelVisible(layout, !layout.panel.visible),
    );
  }
}
