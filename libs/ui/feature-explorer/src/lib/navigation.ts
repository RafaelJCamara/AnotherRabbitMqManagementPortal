// How the explorer opens an entity or a page (M1-42, R6). The feature cannot import the shell, so it asks a
// token: the default navigates the router; the web shell provides one that opens (or activates) a workspace tab
// for the target and shows it. A name that links to another entity is a real anchor (`href`), so middle-click and
// "copy link" work, and its plain click calls `open`.
import { inject, InjectionToken } from '@angular/core';
import { Router } from '@angular/router';
import {
  DEFAULT_EXCHANGE_LABEL,
  entityUrl,
  type EntityRef,
  type EntityTabId,
  type ExplorerKind,
  type InventoryRow,
} from '@app/explorer-model';

/** One entity: a kind and a key, and optionally a tab (none is the Overview). */
export interface EntityTarget extends EntityRef {
  readonly tab?: EntityTabId;
}

/** A page of the explorer: its overview, or the grid of a kind (a bindings grid names its vhost). */
export interface PageTarget {
  readonly page: 'overview' | ExplorerKind;
  readonly vhost?: string;
}

export type NavigationTarget = EntityTarget | PageTarget;

/** The address of a target under a connection. */
export function targetUrl(cid: string, target: NavigationTarget): string {
  if ('page' in target) {
    if (target.page === 'overview') return `/c/${cid}/explorer`;
    const base = `/c/${cid}/explorer/${target.page}`;
    return target.page === 'bindings' &&
      target.vhost !== undefined &&
      target.vhost !== ''
      ? `${base}?vhost=${encodeURIComponent(target.vhost)}`
      : base;
  }
  return entityUrl(cid, target, target.tab);
}

export interface ExplorerNavigation {
  /** The address of the target under the connection (a path, for `href`). */
  href(cid: string, target: NavigationTarget): string;
  /** Opens the target and shows it; `label` names it in a workspace tab. */
  open(cid: string, target: NavigationTarget, label: string): void;
}

export const EXPLORER_NAVIGATION = new InjectionToken<ExplorerNavigation>(
  'EXPLORER_NAVIGATION',
  {
    providedIn: 'root',
    factory: (): ExplorerNavigation => {
      const router = inject(Router);
      return {
        href: targetUrl,
        open: (cid, target) => {
          void router.navigateByUrl(targetUrl(cid, target));
        },
      };
    },
  },
);

/** A click the browser should handle itself (new tab, new window, download): any modifier or other button. */
export function isPlainClick(event: MouseEvent): boolean {
  return (
    event.button === 0 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

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
