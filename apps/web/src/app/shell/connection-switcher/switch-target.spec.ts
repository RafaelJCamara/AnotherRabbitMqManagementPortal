import { describe, expect, it } from 'vitest';

import { resolveSwitchTarget, type AddressExists } from './switch-target';

const never: AddressExists = () => Promise.resolve(false);
const always: AddressExists = () => Promise.resolve(true);

describe('resolveSwitchTarget', () => {
  it('AC-2 an explorer page opens on the other connection, with its query', async () => {
    for (const [from, to] of [
      ['/c/staging/explorer', '/c/prod/explorer'],
      ['/c/staging/explorer/queues', '/c/prod/explorer/queues'],
      ['/c/staging/explorer/exchanges', '/c/prod/explorer/exchanges'],
      ['/c/staging/explorer/connections', '/c/prod/explorer/connections'],
      [
        '/c/staging/explorer/bindings?vhost=%2F',
        '/c/prod/explorer/bindings?vhost=%2F',
      ],
      [
        '/c/staging/explorer/queues?view=v1#top',
        '/c/prod/explorer/queues?view=v1',
      ],
    ] as const) {
      expect(
        await resolveSwitchTarget({
          currentUrl: from,
          toCid: 'prod',
          exists: never,
        }),
        from,
      ).toEqual({ url: to, missing: null });
    }
  });

  it('AC-2 an address that is not under a connection, or is the bare connection, opens the explorer root without a notice', async () => {
    for (const from of [
      '/',
      '/connections',
      '/c/staging',
      '/c/staging/',
      '/gallery',
    ]) {
      expect(
        await resolveSwitchTarget({
          currentUrl: from,
          toCid: 'prod',
          exists: never,
        }),
        from,
      ).toEqual({ url: '/c/prod/explorer', missing: null });
    }
  });

  it('AC-2 orders.q open on staging opens on prod when it exists there', async () => {
    const asked: [string, string][] = [];
    const exists: AddressExists = (cid, address) => {
      asked.push([cid, address]);
      return Promise.resolve(
        cid === 'prod' && address === '/explorer/queues/orders.q',
      );
    };
    expect(
      await resolveSwitchTarget({
        currentUrl: '/c/staging/explorer/queues/orders.q',
        toCid: 'prod',
        exists,
      }),
    ).toEqual({ url: '/c/prod/explorer/queues/orders.q', missing: null });
    // The question names the connection it is about and the address under it, and nothing else.
    expect(asked).toEqual([['prod', '/explorer/queues/orders.q']]);
  });

  it('AC-2 orders.q open on staging opens the explorer root on prod, with a notice naming it, when it does not exist there', async () => {
    expect(
      await resolveSwitchTarget({
        currentUrl: '/c/staging/explorer/queues/orders.q?tab=1',
        toCid: 'prod',
        exists: never,
      }),
    ).toEqual({
      url: '/c/prod/explorer',
      missing: '/explorer/queues/orders.q',
    });
  });

  it('AC-2 an address of any other shape is asked, and the default answer is no, so nothing unknown is carried over', async () => {
    expect(
      await resolveSwitchTarget({
        currentUrl: '/c/staging/explorer/queues/orders.q',
        toCid: 'prod',
        exists: always,
      }),
    ).toEqual({ url: '/c/prod/explorer/queues/orders.q', missing: null });
    expect(
      await resolveSwitchTarget({
        currentUrl: '/c/staging/settings',
        toCid: 'prod',
        exists: never,
      }),
    ).toEqual({ url: '/c/prod/explorer', missing: '/settings' });
  });
});
