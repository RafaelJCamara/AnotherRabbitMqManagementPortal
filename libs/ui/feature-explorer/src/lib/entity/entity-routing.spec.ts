import { encodeObjectKey } from '@app/contracts';
import { createFakeExplorerData } from '@app/explorer-model/testing';
import { EngineProblemError } from '@app/ui-data';
import {
  eventually,
  restoreGridSpecEnvironment,
  warmUpGrid,
  WARM_UP_TIMEOUT_MS,
} from '@app/ui-grid/testing/components';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import en from '../../i18n/en.json';
import {
  EXPLORER_NAVIGATION,
  targetUrl,
  type NavigationTarget,
} from '../navigation';
import {
  fieldPairs,
  mountEntity,
  must,
  PAGE_TEST_TIMEOUT_MS,
  queueRow,
} from '../testing/entity-bed';

const SEP = '\u0000';

function binding(
  source: string,
  destination: string,
  destinationType: 'queue' | 'exchange',
  routingKey = '',
  vhost = '/',
) {
  return {
    key: encodeObjectKey(
      vhost,
      [source, destinationType, destination, routingKey].join(SEP),
    ),
    vhost,
    source,
    destination,
    destinationType,
    routingKey,
    propertiesKey: routingKey,
  };
}

const exchangeRow = (name: string) => ({
  key: encodeObjectKey('/', name),
  vhost: '/',
  name,
  type: 'topic',
});

/** A fake inventory with a queue, exchanges and bindings, the topic answering at once. */
function inventory(
  bindings: readonly ReturnType<typeof binding>[],
  queueNames: readonly string[] = ['orders.q'],
) {
  const fake = createFakeExplorerData({
    rows: { queues: 0, exchanges: 0, connections: 0, bindings: 0 },
    vhosts: ['/'],
    autoSnapshot: true,
  });
  fake.bump((all) => {
    all.queues = queueNames.map((name) => queueRow(name)) as never;
    all.exchanges = ['orders.x', 'audit.x', 'sink.x', 'src.x', ''].map(
      exchangeRow,
    );
    all.bindings = [...bindings] as never;
  });
  return fake;
}

function recorder() {
  const opened: { cid: string; target: NavigationTarget; label: string }[] = [];
  return {
    opened,
    provider: {
      provide: EXPLORER_NAVIGATION,
      useValue: {
        href: targetUrl,
        open: (cid: string, target: NavigationTarget, label: string) =>
          void opened.push({ cid, target, label }),
      },
    },
  };
}

async function routed(el: HTMLElement, fixture: { detectChanges(): void }) {
  await eventually(() => {
    fixture.detectChanges();
    expect(el.querySelector('app-routing-panel table, .note')).not.toBeNull();
  }, 8000);
}

const headings = (el: Element): string[] =>
  [...el.querySelectorAll('app-routing-panel h2')].map((h) =>
    h.textContent.trim(),
  );

const rowsOf = (table: Element | null): string[][] =>
  [...(table?.querySelectorAll('tbody tr') ?? [])].map((tr) =>
    [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()),
  );

describe('the routing tab and the binding page', () => {
  beforeAll(warmUpGrid, WARM_UP_TIMEOUT_MS);
  afterAll(restoreGridSpecEnvironment);

  it(
    'AC-13 routing lists the exact bindings with links and says what was not scanned',
    async () => {
      const queue = queueRow('orders.q');
      const feeding = [
        binding('orders.x', 'orders.q', 'queue', 'created'),
        binding('audit.x', 'orders.q', 'queue'),
      ];
      const noise = [
        binding('orders.x', 'orders.q.dlq', 'queue', 'dead'), // a longer name that contains this one
        binding('src.x', 'orders.q', 'exchange', 'x'), // an exchange called the same
        binding('orders.q', 'sink.x', 'exchange'), // a source called the same
      ];
      const { opened, provider } = recorder();
      const fake = inventory(
        [...feeding, ...noise],
        ['orders.q', 'orders.q.dlq'],
      );
      const bed = await mountEntity({
        fake,
        kind: 'queues',
        key: queue.key,
        tab: 'routing',
        providers: [provider],
      });
      await routed(bed.el, bed.fixture);
      const { el } = bed;

      // A queue has bindings in and no bindings out; only the two exact ones are listed.
      expect(headings(el)).toEqual([
        en.entity.routing.in.replace('{{count}}', '2'),
      ]);
      expect(rowsOf(el.querySelector('app-routing-panel table'))).toEqual([
        ['audit.x', en.entity.empty, en.entity.routing.open],
        ['orders.x', 'created', en.entity.routing.open],
      ]);
      expect(
        el.querySelector('app-routing-panel table caption'),
      ).not.toBeNull();

      // Each source is a real link to the exchange, each binding a link to the binding.
      const links = [
        ...el.querySelectorAll<HTMLAnchorElement>('app-routing-panel a'),
      ];
      const sources = links.filter((a) => !a.getAttribute('aria-label'));
      expect(sources.map((a) => a.getAttribute('href'))).toEqual([
        `/c/c1/exchanges/${encodeObjectKey('/', 'audit.x')}`,
        `/c/c1/exchanges/${encodeObjectKey('/', 'orders.x')}`,
      ]);
      const named = links.filter((a) => a.getAttribute('aria-label') !== null);
      expect(named.map((a) => a.getAttribute('aria-label'))).toEqual([
        en.entity.routing.openNamed.replace('{{name}}', 'audit.x -> orders.q'),
        en.entity.routing.openNamed.replace('{{name}}', 'orders.x -> orders.q'),
      ]);
      expect(named[1]?.getAttribute('href')).toBe(
        `/c/c1/bindings/${feeding[0]?.key ?? ''}`,
      );

      // A plain click opens it as the shell opens pages; a click with a modifier is left to the browser.
      const plain = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
      });
      sources[1]?.dispatchEvent(plain);
      expect(plain.defaultPrevented).toBe(true);
      expect(opened).toEqual([
        {
          cid: 'c1',
          target: { kind: 'exchanges', key: encodeObjectKey('/', 'orders.x') },
          label: 'orders.x',
        },
      ]);
      const ctrl = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
        ctrlKey: true,
      });
      sources[0]?.dispatchEvent(ctrl);
      expect(ctrl.defaultPrevented).toBe(false);
      expect(opened).toHaveLength(1);
      named[1]?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
      );
      expect(opened[1]).toEqual({
        cid: 'c1',
        target: { kind: 'bindings', key: feeding[0]?.key },
        label: 'orders.x -> orders.q',
      });
      // Only reads of one vhost, in windows of at most 200 rows.
      for (const query of fake.queries.filter((q) => q.kind === 'bindings')) {
        expect(query.filter?.vhosts).toEqual(['/']);
        expect(query.window.limit).toBeLessThanOrEqual(200);
      }
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-13 an exchange lists bindings in and out, a flood says what it did not read, a failure shows the Problem, and the default exchange asks nothing',
    async () => {
      // An exchange: in from an exchange, out to a queue and to an exchange; each end links by its type.
      const exchange = exchangeRow('orders.x');
      const bindings = [
        binding('src.x', 'orders.x', 'exchange', '#'),
        binding('orders.x', 'orders.q', 'queue', 'created'),
        binding('orders.x', 'sink.x', 'exchange', 'all'),
      ];
      const fake = inventory(bindings);
      const bed = await mountEntity({
        fake,
        kind: 'exchanges',
        key: exchange.key,
        tab: 'routing',
      });
      await routed(bed.el, bed.fixture);
      expect(headings(bed.el)).toEqual([
        en.entity.routing.in.replace('{{count}}', '1'),
        en.entity.routing.out.replace('{{count}}', '2'),
      ]);
      const tables = bed.el.querySelectorAll('app-routing-panel table');
      expect(rowsOf(tables[0] ?? null)).toEqual([
        ['src.x', '#', en.entity.routing.open],
      ]);
      // Both leave orders.x, so the engine orders them by key; the page keeps that order.
      expect(
        rowsOf(tables[1] ?? null).sort((a, b) =>
          (a[0] ?? '').localeCompare(b[0] ?? ''),
        ),
      ).toEqual([
        ['orders.q', 'queue', 'created', en.entity.routing.open],
        ['sink.x', 'exchange', 'all', en.entity.routing.open],
      ]);
      const out = [
        ...(tables[1]?.querySelectorAll<HTMLAnchorElement>(
          'td:first-child a',
        ) ?? []),
      ];
      expect(out.map((a) => a.getAttribute('href')).sort()).toEqual(
        [
          `/c/c1/queues/${encodeObjectKey('/', 'orders.q')}`,
          `/c/c1/exchanges/${encodeObjectKey('/', 'sink.x')}`,
        ].sort(),
      );

      // A flood: more matches than five windows hold. The page says how many it read and of how many.
      const flood = Array.from({ length: 1_500 }, (_, i) =>
        binding(
          `a-${String(i).padStart(5, '0')}`,
          `orders.q-${String(i)}`,
          'queue',
        ),
      );
      const big = await mountEntity({
        fake: inventory(flood),
        kind: 'queues',
        key: queueRow('orders.q').key,
        tab: 'routing',
      });
      await eventually(() => {
        big.fixture.detectChanges();
        expect(big.el.querySelector('app-routing-panel .warn')).not.toBeNull();
      }, 8000);
      expect(
        big.el.querySelector('app-routing-panel .warn')?.textContent.trim(),
      ).toBe(
        en.entity.routing.truncated
          .replace('{{scanned}}', '1000')
          .replace('{{matched}}', '1500'),
      );
      expect(
        big.el.querySelector('app-routing-panel .note')?.textContent.trim(),
      ).toBe(
        en.entity.routing.noneIn.replace('{{noun}}', en.entity.noun.queues),
      );
      expect(
        big.fake.queries.filter((q) => q.kind === 'bindings'),
      ).toHaveLength(5);

      // A failure: the Problem as sent, with its hint; nothing is invented in place of the rows.
      const failing = inventory(bindings);
      const page = await mountEntity({
        fake: failing,
        kind: 'exchanges',
        key: exchange.key,
      });
      await eventually(() => {
        page.fixture.detectChanges();
        expect(page.el.querySelector('dl.fields')).not.toBeNull();
      }, 8000);
      failing.failNext(
        new EngineProblemError({
          type: 'about:blank',
          title: 'Broker unreachable',
          status: 503,
          code: 'BROKER_UNREACHABLE',
          detail: 'The bindings could not be read.',
          correlationId: 'c',
          retryable: true,
        }),
      );
      must(page.el, '[data-tab="routing"]').click();
      page.fixture.componentRef.setInput('tab', 'routing');
      await eventually(() => {
        page.fixture.detectChanges();
        expect(
          page.el.querySelector('app-routing-panel [role="alert"]'),
        ).not.toBeNull();
      }, 8000);
      const alert = must(
        page.el,
        'app-routing-panel [role="alert"]',
      ).textContent;
      expect(alert).toContain('Broker unreachable');
      expect(alert).toContain('The bindings could not be read.');
      expect(alert).toContain(en.hint.brokerUnreachable);
      // Reading again reads again, and the rows come.
      must(page.el, 'app-routing-panel .reload').click();
      await eventually(() => {
        page.fixture.detectChanges();
        expect(page.el.querySelector('app-routing-panel table')).not.toBeNull();
      }, 8000);
      expect(
        page.el.querySelector('app-routing-panel [role="alert"]'),
      ).toBeNull();

      // The default exchange has implicit bindings the broker does not list: it says so and asks nothing.
      const none = inventory([]);
      const implicit = await mountEntity({
        fake: none,
        kind: 'exchanges',
        key: encodeObjectKey('/', ''),
        tab: 'routing',
      });
      await eventually(() => {
        implicit.fixture.detectChanges();
        expect(
          implicit.el
            .querySelector('app-routing-panel .note')
            ?.textContent.trim(),
        ).toBe(en.entity.routing.defaultExchange);
      }, 8000);
      expect(none.queries.filter((q) => q.kind === 'bindings')).toEqual([]);
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-13 a binding has its own page with links to both of its ends',
    async () => {
      const row = binding('orders.x', 'orders.q', 'queue', 'created');
      const toExchange = binding('src.x', 'orders.x', 'exchange', '#');
      const { opened, provider } = recorder();
      const fake = inventory([row, toExchange]);
      const bed = await mountEntity({
        fake,
        kind: 'bindings',
        key: row.key,
        providers: [provider],
      });
      await eventually(() => {
        bed.fixture.detectChanges();
        expect(bed.el.querySelector('dl.fields')).not.toBeNull();
      }, 8000);
      const { el } = bed;
      const pairs = new Map(fieldPairs(el));
      expect(pairs.get(en.columns.source)).toBe('orders.x');
      expect(pairs.get(en.columns.destination)).toBe('orders.q');
      expect(pairs.get(en.columns.destinationType)).toBe('queue');
      expect(pairs.get(en.columns.routingKey)).toBe('created');
      expect(el.querySelector('h1')?.textContent.trim()).toBe(
        'orders.x -> orders.q',
      );
      expect(el.querySelector('.kind')?.textContent.trim()).toBe(
        en.entity.kind.bindings,
      );
      // A binding has one tab, so no strip; the page was found without a topic.
      expect(el.querySelector('[role="tablist"]')).toBeNull();
      expect(fake.followers).toEqual([]);

      const ends = [...el.querySelectorAll<HTMLAnchorElement>('ul.links a')];
      expect(ends.map((a) => a.getAttribute('href'))).toEqual([
        `/c/c1/exchanges/${encodeObjectKey('/', 'orders.x')}`,
        `/c/c1/queues/${encodeObjectKey('/', 'orders.q')}`,
      ]);
      expect(el.querySelector('ul.links')?.textContent).toContain(
        en.entity.links.destinationQueue,
      );
      ends[1]?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
      );
      expect(opened).toEqual([
        {
          cid: 'c1',
          target: { kind: 'queues', key: encodeObjectKey('/', 'orders.q') },
          label: 'orders.q',
        },
      ]);

      // A binding to an exchange links an exchange; one that is gone is not found, certainly.
      const second = await mountEntity({
        fake,
        kind: 'bindings',
        key: toExchange.key,
      });
      await eventually(() => {
        second.fixture.detectChanges();
        expect(second.el.querySelector('ul.links')).not.toBeNull();
      }, 8000);
      expect(second.el.querySelector('ul.links')?.textContent).toContain(
        en.entity.links.destinationExchange,
      );
      const gone = await mountEntity({
        fake,
        kind: 'bindings',
        key: binding('orders.x', 'orders.q', 'queue', 'other').key,
      });
      await eventually(() => {
        gone.fixture.detectChanges();
        expect(gone.el.textContent).toContain(
          en.entity.missing.certain
            .replace('{{noun}}', en.entity.noun.bindings)
            .replace('{{name}}', 'orders.x -> orders.q')
            .replace('{{vhost}}', '/'),
        );
      }, 8000);
    },
    PAGE_TEST_TIMEOUT_MS,
  );
});
