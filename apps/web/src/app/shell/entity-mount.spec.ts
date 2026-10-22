import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { encodeObjectKey } from '@app/contracts';
import { createFakeExplorerData } from '@app/explorer-model/testing';
import { describe, expect, it } from 'vitest';

import { createShellNavigation, tabLabel } from './explorer-navigation';
import { ShellLayoutStore } from './layout/shell-layout-store';
import { StatusBackend, brokerProfileBody } from './status-bar/status-fixtures';
import { mountShell, routed, settleShell, until, visit } from './test-fixtures';

/** The timeout of the specs that mount the real shell with the lazy explorer library (see explorer-mount.spec). */
const MOUNT_TEST_TIMEOUT_MS = 20_000;

const key = (vhost: string, name: string): string =>
  encodeObjectKey(vhost, name);
const bindingName = (source: string, destination: string, routingKey: string) =>
  [source, 'queue', destination, routingKey].join('\u0000');

/** The inventory the entity pages read: a queue, two exchanges, a connection and two bindings of `/`. */
function inventory() {
  const fake = createFakeExplorerData({
    rows: { queues: 0, exchanges: 0, connections: 0, bindings: 0 },
    vhosts: ['/'],
    autoSnapshot: true,
  });
  fake.bump((all) => {
    all.queues = [
      {
        key: key('/', 'orders.q'),
        vhost: '/',
        name: 'orders.q',
        type: 'quorum',
      },
    ] as never;
    all.exchanges = [
      {
        key: key('/', 'orders.x'),
        vhost: '/',
        name: 'orders.x',
        type: 'topic',
      },
    ] as never;
    all.connections = [
      {
        key: key('/', 'client one'),
        vhost: '/',
        name: 'client one',
        user: 'guest',
      },
    ] as never;
    all.bindings = [
      {
        key: key('/', bindingName('orders.x', 'orders.q', 'created')),
        vhost: '/',
        source: 'orders.x',
        destination: 'orders.q',
        destinationType: 'queue',
        routingKey: 'created',
        propertiesKey: 'created',
      },
    ] as never;
  });
  return fake;
}

async function mountEntities(layoutBackend = new StatusBackend()) {
  const feature = await import('@app/feature-explorer');
  const fake = inventory();
  layoutBackend.profiles.set('c1', brokerProfileBody('c1'));
  const bed = await mountShell(undefined, layoutBackend, undefined, [
    { provide: feature.EXPLORER_DATA, useValue: fake },
  ]);
  return { bed, fake, backend: layoutBackend };
}

const tabsOf = () =>
  TestBed.inject(ShellLayoutStore)
    .layout()
    .editor.groups.flatMap((group) => group.tabs);

const pageText = (bed: Awaited<ReturnType<typeof mountShell>>): string =>
  routed(bed).querySelector('main app-entity-page')?.textContent ?? '';

describe('the entity pages under the shell', () => {
  it(
    'AC-14 a copied deep link opens the same entity and tab, with its workspace tab',
    async () => {
      const { bed } = await mountEntities();
      const queueKey = key('/', 'orders.q');

      // The link is opened cold, as after a reload or in a new window: the same entity, on the same tab.
      await visit(bed, `/c/c1/queues/${queueKey}/routing`);
      await until(
        bed,
        () => routed(bed).querySelector('main app-routing-panel') !== null,
        'the routing tab',
      );
      const host = routed(bed);
      expect(host.tagName.toLowerCase()).toBe('app-shell');
      expect(
        host.querySelector('main app-entity-page h1')?.textContent.trim(),
      ).toBe('orders.q');
      expect(
        host
          .querySelector('main [role="tab"][data-tab="routing"]')
          ?.getAttribute('aria-selected'),
      ).toBe('true');
      expect(TestBed.inject(Router).url).toBe(
        `/c/c1/queues/${queueKey}/routing`,
      );

      // The shell gave it a workspace tab named for the entity, and it is the active one.
      await until(bed, () => tabsOf().length === 1, 'the workspace tab');
      expect(tabsOf()).toEqual([
        {
          id: 't1',
          url: `/c/c1/queues/${queueKey}/routing`,
          label: 'orders.q',
        },
      ]);
      const layout = TestBed.inject(ShellLayoutStore).layout();
      expect(layout.editor.groups[0]?.activeTab).toBe('t1');

      // Visiting the same entity again (another tab of it, or its base address) does not add a second tab.
      await visit(bed, `/c/c1/queues/${queueKey}`);
      await until(
        bed,
        () =>
          routed(bed).querySelector('main app-entity-page dl.fields') !== null,
        'the overview',
      );
      expect(tabsOf()).toHaveLength(1);
      expect(
        routed(bed)
          .querySelector('main [role="tab"][data-tab="overview"]')
          ?.getAttribute('aria-selected'),
      ).toBe('true');

      // Every kind has its page under the shell.
      for (const [kind, name, marker] of [
        ['exchanges', 'orders.x', 'explorer.entity.kind.exchanges'],
        ['connections', 'client one', 'explorer.entity.kind.connections'],
      ] as const) {
        await visit(bed, `/c/c1/${kind}/${key('/', name)}`);
        await until(
          bed,
          () =>
            routed(bed).querySelector('main app-entity-page dl.fields') !==
            null,
          `the ${kind} page`,
        );
        expect(
          routed(bed).querySelector('main app-entity-page .kind')?.textContent,
        ).toBe(`[[${marker}]]`);
        expect(
          routed(bed)
            .querySelector('main app-entity-page h1')
            ?.textContent.trim(),
        ).toBe(name);
      }
      const bindingKey = key(
        '/',
        bindingName('orders.x', 'orders.q', 'created'),
      );
      await visit(bed, `/c/c1/bindings/${bindingKey}`);
      await until(
        bed,
        () =>
          routed(bed).querySelector('main app-entity-page ul.links') !== null,
        'the binding page',
      );
      expect(
        routed(bed)
          .querySelector('main app-entity-page h1')
          ?.textContent.trim(),
      ).toBe('orders.x -> orders.q');
      expect(tabsOf().map((tab) => tab.label)).toEqual([
        'orders.q',
        'orders.x',
        'client one',
        'orders.x -> orders.q',
      ]);

      // An object that is not there says so, with the key's own words; a bad key says it is not an address.
      await visit(bed, `/c/c1/queues/${key('/', 'gone')}`);
      await until(
        bed,
        () => pageText(bed).includes('explorer.entity.missing.certain'),
        'the not-found state',
      );
      await visit(bed, '/c/c1/queues/not*a*key');
      await until(
        bed,
        () => pageText(bed).includes('explorer.entity.invalid'),
        'the invalid-address state',
      );
      const before = tabsOf().length;
      expect(tabsOf().some((tab) => tab.url.includes('not*a*key'))).toBe(false); // no tab is kept for something that is not an address

      // An unknown kind, or an address with more segments, is the shell's own not-found view.
      await visit(bed, `/c/c1/things/${queueKey}`);
      expect(routed(bed).querySelector('main app-not-found')).not.toBeNull();
      await visit(bed, `/c/c1/queues/${queueKey}/routing/extra`);
      expect(routed(bed).querySelector('main app-not-found')).not.toBeNull();
      expect(routed(bed).querySelector('app-entity-page')).toBeNull();
      expect(tabsOf()).toHaveLength(before);
    },
    MOUNT_TEST_TIMEOUT_MS,
  );

  it(
    'AC-15 opening an entity opens one workspace tab and falls back when the shell refuses it',
    async () => {
      const { bed } = await mountEntities();
      const queueKey = key('/', 'orders.q');
      await visit(bed, `/c/c1/queues/${queueKey}/routing`);
      await until(
        bed,
        () =>
          routed(bed).querySelector('main app-routing-panel table') !== null,
        'the bindings',
      );
      await until(bed, () => tabsOf().length === 1, 'the first tab');

      // A plain click on the exchange in the list opens it as a workspace tab and shows it.
      const link = routed(bed).querySelector<HTMLAnchorElement>(
        'main app-routing-panel table td a',
      );
      expect(link?.getAttribute('href')).toBe(
        `/c/c1/exchanges/${key('/', 'orders.x')}`,
      );
      link?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
      );
      await until(bed, () => tabsOf().length === 2, 'the second tab');
      expect(tabsOf().map((tab) => [tab.url, tab.label])).toEqual([
        [`/c/c1/queues/${queueKey}/routing`, 'orders.q'],
        [`/c/c1/exchanges/${key('/', 'orders.x')}`, 'orders.x'],
      ]);
      await until(
        bed,
        () =>
          TestBed.inject(Router).url ===
          `/c/c1/exchanges/${key('/', 'orders.x')}`,
        'the exchange to be shown',
      );
      await until(
        bed,
        () =>
          routed(bed).querySelector('main app-entity-page .kind')
            ?.textContent === '[[explorer.entity.kind.exchanges]]',
        'the exchange page',
      );
      // Nothing but the address and the name is kept in a tab.
      expect(Object.keys(tabsOf()[1] ?? {}).sort()).toEqual([
        'id',
        'label',
        'url',
      ]);

      // The crumb back to the explorer opens a page the same way.
      const crumb =
        routed(bed).querySelector<HTMLAnchorElement>('main nav.crumbs a');
      expect(crumb?.getAttribute('href')).toBe('/c/c1/explorer');
      const click = (): void => {
        crumb?.dispatchEvent(
          new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            button: 0,
          }),
        );
      };
      click();
      await until(bed, () => tabsOf().length === 3, 'the third tab');
      expect(tabsOf()[2]?.url).toBe('/c/c1/explorer');
      expect(tabsOf()[2]?.label).toBe('[[explorer.overview.title]]');

      // An address the shell refuses for a tab (too long) is still shown: the person arrives.
      const long = 'n'.repeat(400);
      const longKey = key('/', long);
      expect(longKey.length).toBeGreaterThan(512 - '/c/c1/queues/'.length);
      await visit(bed, `/c/c1/queues/${longKey}`);
      await until(
        bed,
        () => routed(bed).querySelector('main app-entity-page h1') !== null,
        'the page of the long name',
      );
      expect(tabsOf()).toHaveLength(3);
      expect(TestBed.inject(ShellLayoutStore).refusal()).toBe('url-too-long');
    },
    MOUNT_TEST_TIMEOUT_MS,
  );

  it('AC-15 the shell navigation cuts a long label and falls back to the router when a tab is refused', () => {
    const opened: { url: string; label: string }[] = [];
    const navigated: string[] = [];
    let refusal: string | null = null;
    const navigation = createShellNavigation<{ id: string }>(
      {
        open: (tab) => {
          opened.push(tab);
          return refusal;
        },
      },
      {
        navigateByUrl: (url) => {
          navigated.push(url);
          return Promise.resolve(true);
        },
      },
      (cid, target) => `/c/${cid}/things/${target.id}`,
    );
    expect(navigation.href('c1', { id: 'a' })).toBe('/c/c1/things/a');
    navigation.open('c1', { id: 'a' }, 'x'.repeat(300));
    expect(opened).toEqual([
      { url: '/c/c1/things/a', label: tabLabel('x'.repeat(300)) },
    ]);
    expect(opened[0]?.label).toHaveLength(120);
    expect(opened[0]?.label.endsWith('…')).toBe(true);
    expect(navigated).toEqual([]); // the tab was opened, and the tab shows the address itself
    refusal = 'tabs-per-group';
    navigation.open('c1', { id: 'b' }, 'b');
    expect(navigated).toEqual(['/c/c1/things/b']); // no tab, but the person still arrives
    expect(tabLabel('short')).toBe('short');
  });

  it('a connection that is not a plain token shows no entity page and the explorer makes no call', async () => {
    const { bed, fake } = await mountEntities();
    await visit(bed, `/c/not%20an%20id/queues/${key('/', 'orders.q')}`);
    await settleShell(bed);
    expect(routed(bed).querySelector('main app-no-connection')).not.toBeNull();
    expect(routed(bed).querySelector('app-entity-page')).toBeNull();
    expect(fake.followers).toEqual([]);
    expect(fake.queries).toEqual([]);
  });
});
