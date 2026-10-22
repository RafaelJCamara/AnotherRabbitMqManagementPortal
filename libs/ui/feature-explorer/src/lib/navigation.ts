// How the explorer opens an entity (M1-42, R6). The feature cannot import the shell, so it asks a token:
// the default navigates the router; the web shell provides one that opens (or activates) a workspace tab
// for the entity and shows it. A name that links to another entity is a real anchor (`href`), so
// middle-click and "copy link" work, and its plain click calls `open`.
import { inject, InjectionToken } from '@angular/core';
import { Router } from '@angular/router';
import {
  DEFAULT_EXCHANGE_LABEL,
  entityUrl,
  type EntityRef,
  type EntityTabId,
  type InventoryRow,
} from '@app/explorer-model';

/** What to open: a kind and a key, and optionally a tab (none is the Overview). */
export interface EntityTarget extends EntityRef {
  readonly tab?: EntityTabId;
}

export interface ExplorerNavigation {
  /** The address of the target under the connection (a path, for `href`). */
  href(cid: string, target: EntityTarget): string;
  /** Opens the target and shows it; `label` names it in a workspace tab. */
  open(cid: string, target: EntityTarget, label: string): void;
}

export const EXPLORER_NAVIGATION = new InjectionToken<ExplorerNavigation>(
  'EXPLORER_NAVIGATION',
  {
    providedIn: 'root',
    factory: (): ExplorerNavigation => {
      const router = inject(Router);
      return {
        href: (cid, target) => entityUrl(cid, target, target.tab),
        open: (cid, target) => {
          void router.navigateByUrl(entityUrl(cid, target, target.tab));
        },
      };
    },
  },
);

/** The absolute address of a path of this app, for "copy link". */
export function absoluteAddress(document: Document, path: string): string {
  return new URL(path, document.location.origin).toString();
}

/** The name a workspace tab or a heading shows for a row: its name, a binding as `source -> destination`. */
export function rowLabel(row: InventoryRow): string {
  const named = (name: string): string =>
    name === '' ? DEFAULT_EXCHANGE_LABEL : name;
  if ('source' in row) return `${named(row.source)} -> ${row.destination}`;
  return named(row.name);
}
