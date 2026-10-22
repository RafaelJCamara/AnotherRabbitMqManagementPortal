import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { encodeObjectKey } from '@app/contracts';
import {
  createFakeExplorerData,
  type FakeExplorerData,
} from '@app/explorer-model/testing';
import { ConnectionDirectory } from '@app/ui-data';
import { describe, expect, it } from 'vitest';

import {
  StatusBackend,
  brokerProfileBody,
  connectionBody,
} from '../status-bar/status-fixtures';
import {
  mountShell,
  routed,
  settleShell,
  until,
  visit,
} from '../test-fixtures';
import { ADDRESS_EXISTS, type AddressExists } from './switch-target';

function backendWith(): StatusBackend {
  const backend = new StatusBackend();
  for (const [cid, name, env] of [
    ['c1', 'Staging cluster', 'staging'],
    ['c2', 'Orders prod', 'prod'],
    ['c3', 'Lab', 'dev'],
  ] as const) {
    backend.connections.set(cid, connectionBody(cid, name, env));
    backend.profiles.set(cid, brokerProfileBody(cid));
  }
  return backend;
}

const select = (host: HTMLElement): HTMLSelectElement => {
  const found = host.querySelector<HTMLSelectElement>('#connection-switcher');
  if (found === null) throw new Error('the switcher is not there');
  return found;
};

async function choose(
  bed: Awaited<ReturnType<typeof mountShell>>,
  cid: string,
): Promise<void> {
  const el = select(routed(bed));
  el.value = cid;
  el.dispatchEvent(new Event('change'));
  await settleShell(bed);
}

describe('the connection switcher', () => {
  it('AC-9 lists the connections grouped by class, production first, with the active one selected and a link to manage them', async () => {
    const backend = backendWith();
    const bed = await mountShell(undefined, backend);
    await visit(bed, '/c/c1/explorer');
    await until(
      bed,
      () =>
        routed(bed).querySelectorAll('#connection-switcher option').length >= 3,
      'the connections',
    );
    const host = routed(bed);
    const groups = [...host.querySelectorAll('#connection-switcher optgroup')];
    expect(groups.map((g) => g.getAttribute('label'))).toEqual([
      '[[status.env.prod]]',
      '[[status.env.staging]]',
      '[[status.env.dev]]',
    ]);
    expect(
      [...host.querySelectorAll('#connection-switcher option')].map((o) =>
        o.textContent.trim(),
      ),
    ).toEqual(['Orders prod', 'Staging cluster', 'Lab']);
    expect(select(host).value).toBe('c1');
    expect(
      host.querySelector('label[for="connection-switcher"]')?.textContent,
    ).toContain('[[shell.switcher.label]]');
    expect(host.querySelector('.switcher a')?.getAttribute('href')).toBe(
      '/connections',
    );
    // One list read serves the switcher; it is not read again by the shell opening another page.
    expect(backend.listRequests).toBe(1);
  });

  it('AC-2 switching from staging to prod opens the same explorer page on prod, and the tree follows', async () => {
    const bed = await mountShell(undefined, backendWith());
    await visit(bed, '/c/c1/explorer/bindings?vhost=%2F');
    await until(
      bed,
      () =>
        routed(bed).querySelectorAll('#connection-switcher option').length >= 3,
      'the connections',
    );
    await choose(bed, 'c2');
    expect(TestBed.inject(Router).url).toBe(
      '/c/c2/explorer/bindings?vhost=%2F',
    );
    const host = routed(bed);
    expect(select(host).value).toBe('c2');
    expect(host.querySelector('.switcher .notice')).toBeNull();
    // The tree is drawn for the connection now shown: the overview and the four kinds.
    expect(host.querySelectorAll('[role="treeitem"]')).toHaveLength(5);
  });

  it('AC-2 an address that does not exist on prod opens the explorer root there with a notice naming it, which can be dismissed', async () => {
    const asked: [string, string][] = [];
    const exists: AddressExists = (cid, address) => {
      asked.push([cid, address]);
      return Promise.resolve(false);
    };
    const bed = await mountShell(undefined, backendWith(), undefined, [
      { provide: ADDRESS_EXISTS, useValue: exists },
    ]);
    await visit(bed, '/c/c1/explorer/queues/orders.q');
    await until(
      bed,
      () =>
        routed(bed).querySelectorAll('#connection-switcher option').length >= 3,
      'the connections',
    );
    await choose(bed, 'c2');
    expect(TestBed.inject(Router).url).toBe('/c/c2/explorer');
    expect(asked).toEqual([['c2', '/explorer/queues/orders.q']]);
    const notice = routed(bed).querySelector('.switcher .notice');
    expect(notice?.textContent).toContain('[[shell.switcher.missing]]');
    // Dismissing it removes it.
    notice?.querySelector('button')?.click();
    await settleShell(bed);
    expect(routed(bed).querySelector('.switcher .notice')).toBeNull();
  });

  it('AC-2 an address that exists on prod is carried over without a notice', async () => {
    const bed = await mountShell(undefined, backendWith(), undefined, [
      { provide: ADDRESS_EXISTS, useValue: () => Promise.resolve(true) },
    ]);
    await visit(bed, '/c/c1/explorer/queues/orders.q');
    await until(
      bed,
      () =>
        routed(bed).querySelectorAll('#connection-switcher option').length >= 3,
      'the connections',
    );
    await choose(bed, 'c2');
    expect(TestBed.inject(Router).url).toBe('/c/c2/explorer/queues/orders.q');
    expect(routed(bed).querySelector('.switcher .notice')).toBeNull();
  });

  it('AC-16 switching carries an entity to the other connection when it exists there and says when it does not', async () => {
    const feature = await import('@app/feature-explorer');
    const key = encodeObjectKey('/', 'orders.q');
    const row = { key, vhost: '/', name: 'orders.q', type: 'quorum' };
    const fakeWith = (
      rows: unknown[],
      autoSnapshot: boolean,
    ): FakeExplorerData => {
      const fake = createFakeExplorerData({
        rows: { queues: 0, exchanges: 0, connections: 0, bindings: 0 },
        vhosts: ['/'],
        autoSnapshot,
      });
      fake.bump((all) => {
        all.queues = rows as never;
      });
      return fake;
    };
    // c2 has the queue; c3 has a complete inventory without it; c4 is still loading its inventory; c5 was
    // never probed, so its topic fails; c1 (where the person is) must not be asked anything.
    const fakes: Record<string, FakeExplorerData> = {
      c1: fakeWith([row], true),
      c2: fakeWith([row], true),
      c3: fakeWith([], true),
      c4: fakeWith([], false),
      c5: fakeWith([], false),
    };
    const deadlines: (() => void)[] = [];
    const exists: AddressExists = (cid, address) => {
      const fake = fakes[cid];
      if (fake === undefined) return Promise.resolve(false);
      return feature.addressExists(fake, cid, address, {
        after: (callback) => {
          deadlines.push(callback);
          return () => undefined;
        },
      });
    };
    const backend = backendWith();
    for (const [cid, name] of [
      ['c4', 'Loading'],
      ['c5', 'Never probed'],
    ] as const) {
      backend.connections.set(cid, connectionBody(cid, name, 'test'));
      backend.profiles.set(cid, brokerProfileBody(cid));
    }
    const bed = await mountShell(undefined, backend, undefined, [
      { provide: ADDRESS_EXISTS, useValue: exists },
    ]);
    const address = `/queues/${key}/routing`;
    await visit(bed, `/c/c1${address}`);
    await until(
      bed,
      () =>
        routed(bed).querySelectorAll('#connection-switcher option').length >= 5,
      'the connections',
    );
    const router = TestBed.inject(Router);
    const notice = (): Element | null =>
      routed(bed).querySelector('.switcher .notice');
    const pick = (cid: string): void => {
      const el = select(routed(bed));
      el.value = cid;
      el.dispatchEvent(new Event('change'));
    };
    const back = async (): Promise<void> => {
      await router.navigateByUrl(`/c/c1${address}`);
      await settleShell(bed);
    };

    // It exists on c2: the same entity and the same tab, no notice.
    pick('c2');
    await until(bed, () => router.url === `/c/c2${address}`, 'c2');
    expect(notice()).toBeNull();
    expect(fakes.c2?.followers[0]?.params).toEqual({
      cid: 'c2',
      kind: 'queues',
      keys: [key],
    });
    await back();

    // It is certainly not on c3: the explorer of c3 and a notice that names the queue.
    pick('c3');
    await until(bed, () => router.url === '/c/c3/explorer', 'c3');
    expect(notice()?.textContent).toContain('[[shell.switcher.missing]]');
    await back();
    await settleShell(bed);

    // c4 has not finished reading its inventory: the question cannot be answered, so the address is carried over
    // (the deadline passes) and the page there says what it knows.
    pick('c4');
    await until(bed, () => deadlines.length > 0, 'the deadline to be armed');
    expect(router.url).toBe(`/c/c1${address}`); // still waiting
    for (const fire of deadlines) fire();
    await until(bed, () => router.url === `/c/c4${address}`, 'c4');
    expect(notice()).toBeNull();
    await back();

    // c5's topic fails (never probed): unknown too, so it is carried over.
    pick('c5');
    await until(bed, () => fakes.c5?.followers.length === 1, 'c5 asked');
    fakes.c5?.emit({ kind: 'error', error: new Error('not found') });
    await until(bed, () => router.url === `/c/c5${address}`, 'c5');
    expect(notice()).toBeNull();

    // Only the other connection was asked, and only with reads of one key; the one the person is on was not.
    expect(fakes.c1?.followers).toEqual([]);
    expect(fakes.c1?.queries).toEqual([]);
    for (const [cid, fake] of Object.entries(fakes)) {
      for (const query of fake.queries) {
        expect(query.cid).toBe(cid);
        expect(query.window.limit).toBe(1);
      }
      for (const follower of fake.followers) {
        expect(follower.params.cid).toBe(cid);
        expect(follower.params.keys).toEqual([key]);
        expect(follower.active).toBe(false); // each question released its subscription
      }
    }
  }, 20_000);

  it('AC-9 a created or deleted connection shows after the directory is refreshed, and the active one that is not listed stands in', async () => {
    const backend = backendWith();
    const bed = await mountShell(undefined, backend);
    await visit(bed, '/c/c1/explorer');
    await until(
      bed,
      () =>
        routed(bed).querySelectorAll('#connection-switcher option').length >= 3,
      'the connections',
    );
    backend.connections.set('c4', connectionBody('c4', 'New broker', 'test'));
    backend.connections.delete('c3');
    await TestBed.inject(ConnectionDirectory).refresh();
    await settleShell(bed);
    expect(
      [...routed(bed).querySelectorAll('#connection-switcher option')].map(
        (o) => o.textContent.trim(),
      ),
    ).toEqual(['Orders prod', 'Staging cluster', 'New broker']);
    // An address whose connection is not in the list yet shows its id until the list has it.
    await visit(bed, '/c/c9/explorer');
    expect(select(routed(bed)).value).toBe('c9');
  });
});
