import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { rovingIndex } from '../keyboard';
import { showPanelTab } from '../layout/layout-ops';
import { PANEL_IDS, type PanelId } from '../layout/shell-layout';
import { ShellLayoutStore } from '../layout/shell-layout-store';

/** The label key of each panel tab. Typed as a record so no panel can be left without one. */
const PANEL_LABELS: Readonly<Record<PanelId, string>> = {
  jobs: 'shell.panel.tab.jobs',
  receipts: 'shell.panel.tab.receipts',
  tap: 'shell.panel.tab.tap',
  problems: 'shell.panel.tab.problems',
  output: 'shell.panel.tab.output',
};

/**
 * The bottom panel hosts tabs and a labelled empty state only; each panel's content arrives with
 * the feature that owns it. The tabs follow the WAI-ARIA tabs pattern (roving tabindex, arrows,
 * Home and End, selection follows focus).
 */
@Component({
  selector: 'app-bottom-panel',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section [attr.aria-label]="'shell.panel.region' | transloco">
      <div role="tablist" [attr.aria-label]="'shell.panel.tabs' | transloco">
        @for (tab of tabs; track tab.id) {
          <button
            type="button"
            role="tab"
            [id]="'panel-tab-' + tab.id"
            aria-controls="panel-body"
            [attr.aria-selected]="tab.id === active()"
            [tabindex]="tab.id === active() ? 0 : -1"
            (click)="select(tab.id)"
            (keydown)="onKeydown($event)"
          >
            {{ tab.labelKey | transloco }}
          </button>
        }
      </div>
      <div
        id="panel-body"
        role="tabpanel"
        tabindex="0"
        [attr.aria-labelledby]="'panel-tab-' + active()"
      >
        <p>{{ 'shell.panel.empty' | transloco }}</p>
      </div>
    </section>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      background: var(--ds-color-surface-raised);
    }
    section {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
    }
    [role='tablist'] {
      display: flex;
      flex: none;
      border-block-end: 1px solid var(--ds-color-border);
      overflow: hidden;
    }
    [role='tab'] {
      min-height: var(--ds-row-height);
      padding: 0 var(--ds-space-3);
      font: inherit;
      color: var(--ds-color-text-muted);
      background: none;
      border: 0;
      border-block-end: 2px solid transparent;
      cursor: pointer;
    }
    [role='tab'][aria-selected='true'] {
      color: var(--ds-color-text);
      border-block-end-color: var(--ds-color-accent);
    }
    [role='tab']:focus-visible,
    [role='tabpanel']:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: -2px;
    }
    [role='tabpanel'] {
      flex: 1;
      min-height: 0;
      padding: var(--ds-space-2) var(--ds-space-3);
      overflow: auto;
      color: var(--ds-color-text-muted);
    }
  `,
})
export class BottomPanel {
  readonly #store = inject(ShellLayoutStore);
  protected readonly tabs = PANEL_IDS.map((id) => ({
    id,
    labelKey: PANEL_LABELS[id],
  }));
  protected readonly active = computed(() => this.#store.layout().panel.active);

  protected select(id: PanelId): void {
    this.#store.update((layout) => showPanelTab(layout, id));
  }

  protected onKeydown(event: KeyboardEvent): void {
    const current = PANEL_IDS.indexOf(this.active());
    const next = rovingIndex(
      event.key,
      current,
      PANEL_IDS.length,
      'horizontal',
    );
    const id = next === null ? undefined : PANEL_IDS[next];
    if (id === undefined) return;
    event.preventDefault();
    this.select(id);
    const list = (event.currentTarget as HTMLElement).parentElement;
    list?.querySelector<HTMLElement>(`#panel-tab-${id}`)?.focus();
  }
}
