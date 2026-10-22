// A deep link (a copied address, a reload, a link from another window) lands on an entity page with no workspace
// tab for it (M1-42, R6). The keeper adds one for the address the person is on, once the layout of the connection
// is loaded, without navigating: they are already there. An entity that already has a tab (whatever sub-tab it
// shows) is not given a second one. Only entity addresses are kept; every other address is left alone.
import { effect, inject, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import {
  entityLabel,
  parseEntityPath,
  type EntityRef,
} from '@app/explorer-model/entity';
import { filter, map } from 'rxjs';

import { ActiveConnection } from '../active-connection';
import { tabLabel } from '../explorer-navigation';
import { ShellLayoutStore } from '../layout/shell-layout-store';
import { WorkspaceTabs } from './workspace-tabs';

/** The part of an address under `/c/<cid>`, without query and fragment; `null` for another connection. */
function underConnection(url: string, cid: string): string | null {
  const path = url.split('#', 1)[0]?.split('?', 1)[0] ?? '';
  const prefix = `/c/${cid}`;
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : null;
}

function isEntity(url: string, cid: string, ref: EntityRef): boolean {
  const rest = underConnection(url, cid);
  const parsed = rest === null ? null : parseEntityPath(rest);
  return parsed?.ref.kind === ref.kind && parsed.ref.key === ref.key;
}

/**
 * Starts keeping a tab for the entity page the person is on. Call it from an injection context that lives as long
 * as the shell (its constructor); the watch ends with it.
 */
export function keepEntityTab(): void {
  const router = inject(Router);
  const connection = inject(ActiveConnection);
  const store = inject(ShellLayoutStore);
  const tabs = inject(WorkspaceTabs);
  const url = toSignal(
    router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
    ),
    { initialValue: router.url },
  );
  effect(() => {
    const cid = connection.cid();
    const current = url();
    // The layout is not known until it is loaded: a tab added before would be lost, or double.
    if (cid === null || store.saveState() === 'loading') return;
    untracked(() => {
      const rest = underConnection(current, cid);
      const parsed = rest === null ? null : parseEntityPath(rest);
      if (rest === null || parsed === null) return;
      const kept = store
        .layout()
        .editor.groups.some((group) =>
          group.tabs.some((tab) => isEntity(tab.url, cid, parsed.ref)),
        );
      if (kept) return;
      tabs.keep({
        url: `/c/${cid}${rest}`,
        label: tabLabel(entityLabel(parsed)),
      });
    });
  });
}
