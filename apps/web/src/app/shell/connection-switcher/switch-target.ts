// Where the app goes when the person switches from one connection to another (M0-52, R9, AC-2): the same page on the
// other connection when it exists there, otherwise the explorer root of the other connection and a notice that
// names the address that was left behind. Today the only addresses are the explorer's pages (the overview and one
// grid per kind), which exist on every connection; an address of any other shape (an object page, which M1-42 adds)
// is asked of `ADDRESS_EXISTS`, whose default says no, so it falls back to the explorer root with the notice. The
// pure part is `resolveSwitchTarget`; nothing here calls the engine.
import { InjectionToken } from '@angular/core';

/** Whether an address under a connection exists there. A feature that owns object pages provides this (M1-42). */
export type AddressExists = (cid: string, address: string) => Promise<boolean>;

export const ADDRESS_EXISTS = new InjectionToken<AddressExists>(
  'ADDRESS_EXISTS',
  { factory: () => () => Promise.resolve(false) },
);

export interface SwitchTarget {
  /** The router URL to open. */
  readonly url: string;
  /** Set when the address could not be carried over: the address that was left behind. */
  readonly missing: string | null;
}

/** The pages the explorer has on every connection: its overview and one grid per kind. */
const PAGE_ADDRESS =
  /^\/explorer(?:\/(?:queues|exchanges|connections|bindings))?$/;

const CURRENT = /^\/c\/([^/?#]+)((?:\/[^?#]*)?)(\?[^#]*)?(?:#.*)?$/;

/**
 * The URL to open on connection `toCid` when the app is at `currentUrl`. An address that is not under a connection
 * (no `/c/<cid>`) opens the explorer root of the other one, with nothing missing.
 */
export async function resolveSwitchTarget(options: {
  readonly currentUrl: string;
  readonly toCid: string;
  readonly exists: AddressExists;
}): Promise<SwitchTarget> {
  const { currentUrl, toCid, exists } = options;
  const root = `/c/${toCid}/explorer`;
  const match = CURRENT.exec(currentUrl);
  const path = (match?.[2] ?? '').replace(/\/+$/, '');
  const query = match?.[3] ?? '';
  if (path === '') return { url: root, missing: null };
  if (PAGE_ADDRESS.test(path)) {
    return { url: `/c/${toCid}${path}${query}`, missing: null };
  }
  if (await exists(toCid, `${path}${query}`)) {
    return { url: `/c/${toCid}${path}${query}`, missing: null };
  }
  return { url: root, missing: path };
}
