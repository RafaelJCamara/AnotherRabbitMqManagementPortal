// What a person does with tabs and editor groups, joined to the router: opening a tab shows it,
// activating a tab shows its address, closing the active tab shows its neighbour. The layout
// changes themselves are pure (layout-ops.ts) and go through the store; this service only adds the
// connection, the refusal and the navigation, so the tree and the tab strip share one behaviour.
import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';

import { ActiveConnection } from '../active-connection';
import { resizeGroups } from '../layout/fit-layout';
import {
  activateTab,
  closeEmptyGroup,
  closeTab,
  neighbourOf,
  openTab,
  setOrientation,
  splitEditor,
  type LayoutRefusal,
  type NewTab,
} from '../layout/layout-ops';
import { isSafeTabUrl } from '../layout/shell-layout';
import { ShellLayoutStore } from '../layout/shell-layout-store';
import { ShellViewport } from '../layout/shell-viewport';

@Injectable({ providedIn: 'root' })
export class WorkspaceTabs {
  readonly #store = inject(ShellLayoutStore);
  readonly #connection = inject(ActiveConnection);
  readonly #router = inject(Router);
  readonly #viewport = inject(ShellViewport);

  /** Opens a tab in the active group and shows it. Returns why it was refused, or null. */
  open(tab: NewTab): LayoutRefusal | null {
    const cid = this.#connection.cid();
    if (cid === null) return 'unsafe-url';
    const refusal = this.#store.apply((layout) => openTab(layout, cid, tab));
    if (refusal === null) this.#show(tab.url);
    return refusal;
  }

  /** Makes a tab the active one of its group and shows its address. */
  activate(groupIndex: number, tabId: string): void {
    const tab = this.#store
      .layout()
      .editor.groups[groupIndex]?.tabs.find((t) => t.id === tabId);
    if (tab === undefined) return;
    this.#store.update((layout) => activateTab(layout, groupIndex, tabId));
    this.#show(tab.url);
  }

  /**
   * Closes a tab. When it was the active tab of the active group, its neighbour is shown.
   * Returns the neighbour (the tab focus goes to), or null when the group has no tab left.
   */
  close(groupIndex: number, tabId: string): string | null {
    const before = this.#store.layout();
    const group = before.editor.groups[groupIndex];
    const neighbour = neighbourOf(before, groupIndex, tabId);
    const wasShown =
      group?.activeTab === tabId && before.editor.activeGroup === groupIndex;
    this.#store.update((layout) => closeTab(layout, groupIndex, tabId));
    if (wasShown && neighbour !== null) {
      const url = group.tabs.find((tab) => tab.id === neighbour)?.url;
      if (url !== undefined) this.#show(url);
    }
    return neighbour;
  }

  split(): LayoutRefusal | null {
    return this.#store.apply((layout) => splitEditor(layout));
  }

  closeGroup(groupIndex: number): void {
    this.#store.update((layout) => closeEmptyGroup(layout, groupIndex));
  }

  toggleOrientation(): void {
    this.#store.update((layout) =>
      setOrientation(
        layout,
        layout.editor.orientation === 'row' ? 'column' : 'row',
      ),
    );
  }

  /** Moves the splitter between group `index` and the next one. */
  resizeGroup(index: number, pixels: number): void {
    this.#store.update((layout) =>
      resizeGroups(layout, this.#viewport.size(), index, pixels),
    );
  }

  /** Goes to a tab's address, if it still belongs to the connection (a stored tab is data). */
  #show(url: string): void {
    const cid = this.#connection.cid();
    if (cid !== null && isSafeTabUrl(url, cid)) {
      void this.#router.navigateByUrl(url);
    }
  }
}
