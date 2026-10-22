// A link from outside the page, delivered by the platform bridge on the desktop (`PlatformBridge.onDeepLink`,
// M1-42, R10). The path is untrusted input: only navigation to the explorer or to an entity of a connection is
// accepted, as an allow-list of whole shapes; everything else is dropped. A deep link never carries an action:
// the handler only navigates, and the page it lands on asks the engine for what it shows. Registering a coined URL
// scheme with the operating system is the desktop shell's work (M2), never `app`.
import {
  DestroyRef,
  inject,
  provideAppInitializer,
  type EnvironmentProviders,
} from '@angular/core';
import { Router } from '@angular/router';
import { EXPLORER_KINDS, parseEntityPath } from '@app/explorer-model/entity';
import { PLATFORM_BRIDGE } from '@app/ui-platform';

import { parseConnectionParam } from './active-connection';

/** The longest link accepted; a tab address is at most 512 characters (the shell's own limit). */
const DEEP_LINK_MAX = 1024;

/** The query keys a link to an explorer page may carry: the vhost of the bindings and a saved view. */
const PAGE_QUERY_KEYS: readonly string[] = ['vhost', 'view'];

/**
 * The router address a deep link names, or `null` when it is not one of the shapes:
 * `/c/<cid>/explorer`, `/c/<cid>/explorer/<kind>[?vhost=..&view=..]` and `/c/<cid>/<kind>/<key>[/<tab>]`.
 */
export function parseDeepLink(link: string): string | null {
  if (link.length === 0 || link.length > DEEP_LINK_MAX) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(link)) return null;
  if (link.includes('#')) return null;
  const [path, query, ...extra] = link.split('?');
  if (path === undefined || extra.length > 0) return null;
  const segments = path.split('/');
  // ['', 'c', cid, ...rest]
  if (segments[0] !== '' || segments[1] !== 'c') return null;
  const cid = parseConnectionParam(segments[2]);
  if (cid === null || segments.length < 4) return null;
  if (segments.some((segment, i) => i > 0 && segment === '')) return null;
  if (segments.includes('.') || segments.includes('..')) return null;
  const rest = `/${segments.slice(3).join('/')}`;

  if (segments[3] === 'explorer') {
    const kind = segments[4];
    if (segments.length > 5) return null;
    if (kind !== undefined && !EXPLORER_KINDS.some((known) => known === kind)) {
      return null;
    }
    const kept = new URLSearchParams();
    if (query !== undefined) {
      for (const [name, value] of new URLSearchParams(query)) {
        if (!PAGE_QUERY_KEYS.includes(name)) return null;
        if (value.length > 255 || kept.has(name)) return null;
        kept.set(name, value);
      }
    }
    const search = kept.toString();
    return `/c/${cid}${rest}${search === '' ? '' : `?${search}`}`;
  }

  // An entity address has no query: nothing but the entity and its tab is named.
  if (query !== undefined) return null;
  return parseEntityPath(rest) === null ? null : `/c/${cid}${rest}`;
}

/** Navigates for the links the bridge delivers, when it has that method; stops with the application. */
export function provideDeepLinks(): EnvironmentProviders {
  return provideAppInitializer(() => {
    const bridge = inject(PLATFORM_BRIDGE, { optional: true });
    const router = inject(Router);
    if (bridge?.onDeepLink === undefined) return;
    const stop = bridge.onDeepLink((link) => {
      const url = parseDeepLink(link);
      if (url !== null) void router.navigateByUrl(url);
    });
    inject(DestroyRef).onDestroy(stop);
  });
}
