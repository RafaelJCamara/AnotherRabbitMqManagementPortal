import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterOutlet } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { map } from 'rxjs';

import { ActiveConnection, parseConnectionParam } from './active-connection';
import { ActivityBar, ACTIVITY_ENTRIES } from './activity-bar/activity-bar';
import { BottomPanel } from './bottom-panel/bottom-panel';
import {
  FIT,
  panelBounds,
  sidebarBounds,
  type Viewport,
} from './layout/fit-layout';
import { setPanelHeight, setSidebarWidth } from './layout/layout-ops';
import { ShellLayoutStore, VIEWPORT } from './layout/shell-layout-store';
import { LayoutNotices } from './notices/layout-notices';
import { Splitter } from './splitter/splitter';
import { NoConnection } from './views/no-connection';

/**
 * The host of everything under `/c/:cid`: the regions of the IDE layout as landmarks. It opens
 * the layout of the connection profile (`ShellLayoutStore`), fits it to the window and renders
 * the activity bar, the sidebar, the workspace outlet, the bottom panel and the status bar slot.
 * The sizes are numbers from a validated, clamped layout and are bound as CSS custom properties.
 * An id that fails validation leaves the connection unset and shows the no-connection view; the
 * shell never asks the engine anything for it.
 */
@Component({
  selector: 'app-shell',
  imports: [
    ActivityBar,
    BottomPanel,
    LayoutNotices,
    NoConnection,
    RouterOutlet,
    Splitter,
    TranslocoPipe,
  ],
  templateUrl: './shell.html',
  styleUrl: './shell.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(window:resize)': 'onResize()',
    '(document:visibilitychange)': 'onVisibility()',
    '(window:pagehide)': 'onVisibility()',
  },
})
export class Shell {
  readonly #connection = inject(ActiveConnection);
  readonly #store = inject(ShellLayoutStore);
  readonly #viewportOf = inject(VIEWPORT);
  readonly #param = toSignal(
    inject(ActivatedRoute).paramMap.pipe(map((params) => params.get('cid'))),
    { initialValue: null },
  );
  readonly #viewport = signal<Viewport>(this.#viewportOf());

  protected readonly cid = computed(() => parseConnectionParam(this.#param()));
  protected readonly layout = this.#store.layout;
  protected readonly frame = FIT;
  protected readonly sidebarBounds = computed(() =>
    sidebarBounds(this.layout(), this.#viewport()),
  );
  protected readonly panelBounds = computed(() =>
    panelBounds(this.layout(), this.#viewport()),
  );
  /** The title of the sidebar's active container; unknown ids show the first entry's. */
  protected readonly sidebarTitle = computed(() => {
    const active = this.layout().sidebar.active;
    return (
      ACTIVITY_ENTRIES.find((entry) => entry.id === active) ??
      ACTIVITY_ENTRIES[0]
    )?.titleKey;
  });

  constructor() {
    effect(() => {
      const cid = this.cid();
      this.#connection.select(cid);
      if (cid !== null) untracked(() => void this.#store.open(cid));
    });
    inject(DestroyRef).onDestroy(() => {
      this.#connection.select(null);
      void this.#store.flush();
    });
  }

  protected onResize(): void {
    this.#viewport.set(this.#viewportOf());
    this.#store.fit();
  }

  /** The page goes to the background or is closing: send a pending layout, best effort. */
  protected onVisibility(): void {
    if (document.visibilityState === 'hidden') void this.#store.flush();
  }

  protected resizeSidebar(width: number): void {
    this.#store.update((layout) => setSidebarWidth(layout, width));
  }

  protected resizePanel(height: number): void {
    this.#store.update((layout) => setPanelHeight(layout, height));
  }
}
