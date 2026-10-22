import { encodeObjectKey } from '@app/contracts';
import { describe, expect, it } from 'vitest';

import {
  bindingParts,
  DEFAULT_EXCHANGE_LABEL,
  entityLabel,
  entityPath,
  entityUrl,
  parseEntityPath,
} from './entity-address';

const NAMES: readonly (readonly [string, string])[] = [
  ['/', 'orders.q'],
  ['orders', 'a/b/c'],
  ['vhü', '名前 🐇'],
  ['/', 'n'.repeat(255)],
  ['v'.repeat(255), 'n'.repeat(255)],
  ['/', ''],
  ['', 'amq.gen-JzTY20BRgKO-HjmUJj0wLg'],
  ['/', '<img src=x onerror=alert(1)>'],
];

describe('entity addresses (R1)', () => {
  it('AC-1 an entity address round-trips every vhost and name and refuses what is not one', () => {
    for (const kind of ['queues', 'exchanges', 'connections'] as const) {
      for (const [vhost, name] of NAMES) {
        const key = encodeObjectKey(vhost, name);
        const ref = { kind, key };
        const path = entityPath(ref);
        expect(path).toBe(`/${kind}/${key}`);
        expect(entityUrl('c1', ref)).toBe(`/c/c1${path}`);
        const parsed = parseEntityPath(path);
        expect(parsed).toEqual({ ref, tab: null, vhost, name });
        // The tab is optional; the Overview is the address without one.
        expect(entityPath(ref, 'overview')).toBe(path);
        expect(entityPath(ref, 'routing')).toBe(`${path}/routing`);
        expect(parseEntityPath(`${path}/routing`)?.tab).toBe('routing');
        // A query, a fragment and trailing slashes are not part of the address.
        expect(parseEntityPath(`${path}/routing/?x=1#top`)).toEqual({
          ref,
          tab: 'routing',
          vhost,
          name,
        });
      }
    }

    const key = encodeObjectKey('/', 'orders.q');
    const noSeparator = btoa('no-nul-here')
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
    for (const bad of [
      '',
      'queues',
      '/',
      '/queues',
      `/queues/`,
      `/unknown/${key}`,
      `/Queues/${key}`,
      `/queues/${key}/routing/extra`,
      `/queues/${key}/Routing`, // a tab is lower case words
      `/queues/${key}/ro uting`,
      `/queues/${key}/..`,
      `queues/${key}`, // not rooted
      `/queues/${key}=`, // not the canonical encoding
      '/queues/not*base64',
      `/queues/${noSeparator}`, // decodes, but holds no vhost separator
      '/queues/%2F',
      '/c/c1/queues/' + key, // the part under /c/:cid only
    ]) {
      expect(parseEntityPath(bad), bad).toBeNull();
    }
    // A key whose spare bits are re-spelled decodes to the same bytes but is not the canonical address:
    // of the 64 spellings of the last character, only the true one (and those that name another object,
    // which are canonical themselves) are addresses.
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let refused = 0;
    for (const last of alphabet) {
      const spelled = `/queues/${key.slice(0, -1)}${last}`;
      const parsed = parseEntityPath(spelled);
      if (parsed === null) refused += 1;
      else
        expect(parsed.ref.key, spelled).toBe(spelled.slice('/queues/'.length));
    }
    expect(key.length % 4).toBe(2);
    expect(refused).toBeGreaterThan(0);
    expect(parseEntityPath(`/queues/${key}A`)).not.toBeNull(); // an extra byte is another object
  });

  it('AC-1 a binding names its ends and the default exchange is named as the broker names it', () => {
    const identity = ['amq.direct', 'queue', 'orders.q', 'rk'].join('\u0000');
    const key = encodeObjectKey('/', identity);
    const parsed = parseEntityPath(`/bindings/${key}`);
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(bindingParts(parsed.name)).toEqual({
      source: 'amq.direct',
      destinationType: 'queue',
      destination: 'orders.q',
      propertiesKey: 'rk',
    });
    expect(entityLabel(parsed)).toBe('amq.direct -> orders.q');
    expect(bindingParts('only-a-name')).toBeNull();

    const fromDefault = parseEntityPath(
      `/bindings/${encodeObjectKey('/', ['', 'queue', 'orders.q', 'orders.q'].join('\u0000'))}`,
    );
    expect(fromDefault && entityLabel(fromDefault)).toBe(
      `${DEFAULT_EXCHANGE_LABEL} -> orders.q`,
    );
    const exchange = parseEntityPath(`/exchanges/${encodeObjectKey('/', '')}`);
    expect(exchange && entityLabel(exchange)).toBe(DEFAULT_EXCHANGE_LABEL);
    const queue = parseEntityPath(`/queues/${encodeObjectKey('/', 'q1')}`);
    expect(queue && entityLabel(queue)).toBe('q1');
  });
});
