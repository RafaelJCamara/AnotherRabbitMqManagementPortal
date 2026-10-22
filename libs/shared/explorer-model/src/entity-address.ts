// The address of one entity (M1-42, R1): `/c/:cid/{queues|exchanges|connections|bindings}/:key[/:tab]`,
// where `:key` is the object key (base64url of the vhost, a NUL and the name, ADR-003), so a `/` vhost,
// unicode and names with `/` survive any proxy. This file builds and reads the part under `/c/:cid`
// (the "path") and the whole url; it never talks to the engine and never invents a name: the vhost and
// the name are what the key says.
import {
  decodeObjectKey,
  encodeObjectKey,
  ObjectKeySchema,
} from '@app/contracts';

import { EXPLORER_KINDS } from './inventory-model';
import type { ExplorerKind } from './ports';
import type { EntityTabId } from './entity-tabs';

/** Which entity an address names: a kind and the object key. */
export interface EntityRef {
  readonly kind: ExplorerKind;
  readonly key: string;
}

export interface ParsedEntityAddress {
  readonly ref: EntityRef;
  /** The tab segment as written, or `null` when the address has none (the Overview). */
  readonly tab: string | null;
  /** The vhost and name the key holds. For a binding the name is `source NUL type NUL destination NUL key`. */
  readonly vhost: string;
  readonly name: string;
}

/** What a tab segment may look like: a word, so nothing else ever reaches a route or a url. */
const TAB_SEGMENT = /^[a-z][a-z-]{0,31}$/;

/** What the tab of a workspace shows for the default exchange, whose name is empty. */
export const DEFAULT_EXCHANGE_LABEL = '(AMQP default)';

/** `/queues/<key>` or `/queues/<key>/<tab>` (the Overview has no segment). */
export function entityPath(ref: EntityRef, tab?: EntityTabId): string {
  const base = `/${ref.kind}/${ref.key}`;
  return tab === undefined || tab === 'overview' ? base : `${base}/${tab}`;
}

/** The address under a connection: `/c/<cid>/queues/<key>[/<tab>]`. */
export function entityUrl(
  cid: string,
  ref: EntityRef,
  tab?: EntityTabId,
): string {
  return `/c/${cid}${entityPath(ref, tab)}`;
}

/**
 * Reads `/queues/<key>[/<tab>]` (a query, a fragment and trailing slashes are ignored). `null` for
 * anything that is not an entity address: an unknown kind, a key that is not the canonical encoding of
 * a vhost and a name, or more segments than a tab.
 */
export function parseEntityPath(path: string): ParsedEntityAddress | null {
  const bare = path.split('#', 1)[0]?.split('?', 1)[0] ?? '';
  if (!bare.startsWith('/')) return null;
  const segments = bare.replace(/\/+$/, '').split('/');
  // ['', kind, key] or ['', kind, key, tab]
  if (segments.length < 3 || segments.length > 4) return null;
  const [, kind, key, tab] = segments;
  const known = EXPLORER_KINDS.find((candidate) => candidate === kind);
  if (known === undefined || key === undefined || key === '') return null;
  if (tab !== undefined && !TAB_SEGMENT.test(tab)) return null;
  const parsed = ObjectKeySchema.safeParse(key);
  if (!parsed.success) return null;
  let held: { vhost: string; name: string };
  try {
    held = decodeObjectKey(parsed.data);
    // Only the canonical form is an address: the same object has one url, so a tab is never duplicated.
    if (encodeObjectKey(held.vhost, held.name) !== key) return null;
  } catch {
    return null;
  }
  return {
    ref: { kind: known, key },
    tab: tab ?? null,
    vhost: held.vhost,
    name: held.name,
  };
}

/** The four parts of a binding's identity; `null` when the name is not the identity of a binding. */
export function bindingParts(name: string): {
  readonly source: string;
  readonly destinationType: string;
  readonly destination: string;
  readonly propertiesKey: string;
} | null {
  const parts = name.split('\u0000');
  if (parts.length !== 4) return null;
  const [source, destinationType, destination, propertiesKey] = parts;
  if (
    source === undefined ||
    destinationType === undefined ||
    destination === undefined ||
    propertiesKey === undefined
  ) {
    return null;
  }
  return { source, destinationType, destination, propertiesKey };
}

/**
 * A short name for a tab or a heading before the row is read: the object's name, for a binding
 * `source -> destination`; the default exchange (empty name) is named as the broker names it.
 */
export function entityLabel(address: ParsedEntityAddress): string {
  if (address.ref.kind === 'bindings') {
    const parts = bindingParts(address.name);
    if (parts !== null) {
      const from = parts.source === '' ? DEFAULT_EXCHANGE_LABEL : parts.source;
      return `${from} -> ${parts.destination}`;
    }
  }
  return address.name === '' ? DEFAULT_EXCHANGE_LABEL : address.name;
}
