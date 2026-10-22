import { encodeObjectKey } from '@app/contracts';
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
  fieldPairs,
  followerAt,
  keyOf,
  must,
  mountEntity,
  PAGE_TEST_TIMEOUT_MS,
  queueRow,
} from '../testing/entity-bed';
import { FakeWorkspace } from '../testing/fake-workspace';

const numbers = new Intl.NumberFormat();
const NOT_REPORTED = en.cell.notReported;
const column = (id: keyof typeof en.columns): string => en.columns[id];

const FULL = queueRow(
  'orders.q',
  {
    type: 'quorum',
    state: 'running',
    node: 'rabbit@a',
    durable: true,
    autoDelete: false,
    exclusive: false,
    messages: 1234,
    messagesReady: 1000,
    messagesUnacknowledged: 234,
    consumers: 0,
    policy: 'ha-all',
    operatorPolicy: 'ttl-1h',
    deliveryLimit: 20,
  },
  'orders',
);

const SPARSE = queueRow('sparse', { durable: false });

async function loaded(
  el: HTMLElement,
  fixture: { detectChanges(): void },
): Promise<void> {
  await eventually(() => {
    fixture.detectChanges();
    expect(el.querySelector('dl.fields')).not.toBeNull();
  }, 8000);
}

describe('<app-entity-page>', () => {
  beforeAll(warmUpGrid, WARM_UP_TIMEOUT_MS);
  afterAll(restoreGridSpecEnvironment);

  it(
    'AC-9 an entity page shows the fields the broker sent and "not reported" for the rest',
    async () => {
      const hostile = queueRow(
        "<img src=x onerror='window.__pwned = 1'><b>q</b>",
      );
      const bed = await mountEntity({ rows: [FULL, SPARSE, hostile] });
      await loaded(bed.el, bed.fixture);
      const { el } = bed;

      // Identity, state, counts and the node, as sent; one h1, the name; the kind in words.
      expect(fieldPairs(el)).toEqual([
        [column('name'), 'orders.q'],
        [column('vhost'), 'orders'],
        [column('type'), 'quorum'],
        [column('state'), 'running'],
        [column('node'), 'rabbit@a'],
        [column('messages'), numbers.format(1234)],
        [column('messagesReady'), numbers.format(1000)],
        [column('messagesUnacknowledged'), numbers.format(234)],
        [column('consumers'), '0'], // a real zero reads as zero
      ]);
      expect(el.querySelectorAll('h1')).toHaveLength(1);
      expect(el.querySelector('h1')?.textContent.trim()).toBe('orders.q');
      expect(el.querySelector('.kind')?.textContent.trim()).toBe(
        en.entity.kind.queues,
      );

      // The breadcrumb links the explorer and the list of the kind, and names the vhost and the queue.
      const crumbs = [...el.querySelectorAll('nav.crumbs li')];
      expect(crumbs.map((li) => li.textContent.trim())).toEqual([
        en.breadcrumb.explorer,
        en.kinds.queues,
        en.breadcrumb.vhost.replace('{{vhost}}', 'orders'),
        'orders.q',
      ]);
      expect(
        [...el.querySelectorAll('nav.crumbs a')].map((a) =>
          a.getAttribute('href'),
        ),
      ).toEqual(['/c/c1/explorer', '/c/c1/explorer/queues']);
      expect(
        el
          .querySelector('nav.crumbs [aria-current="page"]')
          ?.textContent.trim(),
      ).toBe('orders.q');
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-9 the config tab, a sparse row, an exchange, a connection and a hostile name are shown as text',
    async () => {
      // Config of the full queue.
      const config = await mountEntity({ rows: [FULL], tab: 'config' });
      await loaded(config.el, config.fixture);
      expect(fieldPairs(config.el)).toEqual([
        [column('durable'), en.entity.yes],
        [column('autoDelete'), en.entity.no], // a real false reads as no
        [column('exclusive'), en.entity.no],
        [column('policy'), 'ha-all'],
        [column('operatorPolicy'), 'ttl-1h'],
        [column('deliveryLimit'), '20'],
      ]);
      expect(config.el.textContent).toContain(en.entity.notes.config);

      // A row the broker sent almost nothing for: every other field is "not reported", never 0 or blank.
      const sparse = await mountEntity({ rows: [SPARSE] });
      await loaded(sparse.el, sparse.fixture);
      const pairs = new Map(fieldPairs(sparse.el));
      expect(pairs.get(column('name'))).toBe('sparse');
      for (const id of [
        'type',
        'state',
        'node',
        'messages',
        'messagesReady',
        'messagesUnacknowledged',
        'consumers',
      ] as const) {
        expect(pairs.get(column(id)), id).toBe(NOT_REPORTED);
      }
      const sparseConfig = await mountEntity({
        rows: [SPARSE],
        tab: 'config',
      });
      await loaded(sparseConfig.el, sparseConfig.fixture);
      expect(new Map(fieldPairs(sparseConfig.el)).get(column('durable'))).toBe(
        en.entity.no,
      );
      expect(new Map(fieldPairs(sparseConfig.el)).get(column('policy'))).toBe(
        NOT_REPORTED,
      );

      // An exchange, the default exchange (empty name) and a connection.
      const exchange = {
        key: encodeObjectKey('/', 'orders.x'),
        vhost: '/',
        name: 'orders.x',
        type: 'topic',
        durable: true,
      } as never;
      const x = await mountEntity({ kind: 'exchanges', rows: [exchange] });
      await loaded(x.el, x.fixture);
      expect(fieldPairs(x.el)).toEqual([
        [column('name'), 'orders.x'],
        [column('vhost'), '/'],
        [column('type'), 'topic'],
      ]);
      expect(x.el.querySelector('.kind')?.textContent.trim()).toBe(
        en.entity.kind.exchanges,
      );
      const none = {
        key: encodeObjectKey('/', ''),
        vhost: '/',
        name: '',
        type: 'direct',
      } as never;
      const d = await mountEntity({ kind: 'exchanges', rows: [none] });
      await loaded(d.el, d.fixture);
      expect(d.el.querySelector('h1')?.textContent.trim()).toBe(
        '(AMQP default)',
      );
      const connection = {
        key: encodeObjectKey('', 'client one'),
        name: 'client one',
        user: 'guest',
        channels: 2,
        ssl: false,
      } as never;
      const c = await mountEntity({
        kind: 'connections',
        rows: [connection],
      });
      await loaded(c.el, c.fixture);
      const connPairs = new Map(fieldPairs(c.el));
      expect(connPairs.get(column('user'))).toBe('guest');
      expect(connPairs.get(column('channels'))).toBe('2');
      expect(connPairs.get(column('ssl'))).toBe(en.entity.no);
      expect(connPairs.get(column('vhost'))).toBe(NOT_REPORTED);
      expect(connPairs.get(column('protocol'))).toBe(NOT_REPORTED);
      // A connection has one tab, so no strip; a vhost-less connection has no vhost crumb.
      expect(c.el.querySelector('[role="tablist"]')).toBeNull();
      expect(
        [...c.el.querySelectorAll('nav.crumbs li')].map((li) =>
          li.textContent.trim(),
        ),
      ).toEqual([en.breadcrumb.explorer, en.kinds.connections, 'client one']);

      // Markup in a name is text.
      const hostile = queueRow(
        "<img src=x onerror='window.__pwned = 1'><b>q</b>",
      );
      const h = await mountEntity({ rows: [hostile] });
      await loaded(h.el, h.fixture);
      expect(h.el.querySelector('img, b, script')).toBeNull();
      expect(h.el.querySelector('h1')?.textContent).toContain('<img src=x');
      expect(
        (window as unknown as { __pwned?: number }).__pwned,
      ).toBeUndefined();
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-10 every state of an entity page says what is known and what is not',
    async () => {
      const text = (el: HTMLElement): string =>
        el.textContent.replace(/\s+/g, ' ');

      // A connection nobody has probed: the probe prompt, and nothing of the inventory is read.
      const never = new FakeWorkspace();
      never.profile = null;
      const unprobed = await mountEntity({ rows: [FULL], workspace: never });
      await eventually(() => {
        unprobed.fixture.detectChanges();
        expect(unprobed.el.querySelector('app-probe-prompt')).not.toBeNull();
      });
      expect(unprobed.fake.followers).toEqual([]);
      expect(unprobed.fake.queries).toEqual([]);

      // No connection: nothing is shown and nothing is asked.
      const none = await mountEntity({ rows: [FULL], cid: null });
      await none.fixture.whenStable();
      expect(none.el.querySelector('h1')).toBeNull();
      expect(none.fake.followers).toEqual([]);
      expect(none.workspace.requestLines).toEqual([]);

      // An address that is not a key: said so, and the inventory is not read.
      const invalid = await mountEntity({ rows: [FULL], key: 'not*a*key' });
      await eventually(() => {
        invalid.fixture.detectChanges();
        expect(text(invalid.el)).toContain(
          en.entity.invalid.replace('{{noun}}', en.entity.noun.queues),
        );
      });
      expect(invalid.fake.followers).toEqual([]);
      expect(invalid.fake.queries).toEqual([]);

      // Loading: the topic has not answered; the name comes from the key.
      const loading = await mountEntity({
        rows: [FULL],
        autoSnapshot: false,
      });
      await eventually(() => {
        loading.fixture.detectChanges();
        expect(text(loading.el)).toContain(
          en.entity.loading
            .replace('{{noun}}', en.entity.noun.queues)
            .replace('{{name}}', 'orders.q'),
        );
      });
      expect(loading.el.querySelector('dl.fields')).toBeNull();
      expect(loading.el.querySelector('h1')?.textContent.trim()).toBe(
        'orders.q',
      );

      // Not found, certain: the inventory is live and complete.
      const gone = queueRow('gone', {}, 'orders');
      const certain = await mountEntity({
        rows: [FULL],
        key: keyOf(gone),
      });
      await eventually(() => {
        certain.fixture.detectChanges();
        expect(text(certain.el)).toContain(
          en.entity.missing.certain
            .replace('{{noun}}', en.entity.noun.queues)
            .replace('{{name}}', 'gone')
            .replace('{{vhost}}', 'orders'),
        );
      });
      expect(certain.el.querySelector('dl.fields')).toBeNull();

      // Not found, not certain: the inventory is stale, and the freshness lines are shown.
      const uncertain = await mountEntity({
        rows: [FULL],
        key: keyOf(gone),
        autoSnapshot: false,
        freshness: { state: 'stale', complete: false, sweptAt: 1000 },
      });
      await eventually(() => {
        expect(uncertain.fake.followers).toHaveLength(1);
      });
      uncertain.fake.emit(
        uncertain.fake.snapshotFor(followerAt(uncertain.fake).params),
      );
      await eventually(() => {
        uncertain.fixture.detectChanges();
        expect(text(uncertain.el)).toContain(
          en.entity.missing.uncertain
            .replace('{{noun}}', en.entity.noun.queues)
            .replace('{{name}}', 'gone'),
        );
      });
      expect(uncertain.el.querySelector('.banner li')).not.toBeNull();
      expect(text(uncertain.el)).not.toContain('is on this connection');
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-10 a removed object keeps its last values, a failed read shows the Problem as sent with a retry, and an ended topic is said',
    async () => {
      const text = (el: HTMLElement): string =>
        el.textContent.replace(/\s+/g, ' ');
      const problem = new EngineProblemError({
        type: 'about:blank',
        title: 'Broker unreachable',
        status: 503,
        code: 'BROKER_UNREACHABLE',
        detail: 'Connection refused by rabbit@a.',
        correlationId: 'c',
        retryable: true,
      });

      // Removed after it was read: the last values stay and are labelled.
      const bed = await mountEntity({ rows: [FULL] });
      await loaded(bed.el, bed.fixture);
      bed.fake.emit({ kind: 'delta', upserts: [], removes: [keyOf(FULL)] });
      await eventually(() => {
        bed.fixture.detectChanges();
        expect(text(bed.el)).toContain(
          en.entity.vanished.replace('{{noun}}', en.entity.noun.queues),
        );
      });
      expect(new Map(fieldPairs(bed.el)).get(column('name'))).toBe('orders.q');

      // The topic ends with a Problem after a row was read: the row stays, the loss is said, with the Problem.
      const ended = await mountEntity({ rows: [FULL] });
      await loaded(ended.el, ended.fixture);
      ended.fake.emit({ kind: 'error', error: problem });
      await eventually(() => {
        ended.fixture.detectChanges();
        expect(text(ended.el)).toContain(
          en.entity.liveEnded.replace('{{noun}}', en.entity.noun.queues),
        );
      });
      expect(text(ended.el)).toContain('Broker unreachable');
      expect(text(ended.el)).toContain('Connection refused by rabbit@a.');
      expect(ended.el.querySelector('dl.fields')).not.toBeNull();

      // Nothing could be read: an alert with the Problem as sent, its hint, and a retry that reads again.
      const failed = await mountEntity({
        rows: [FULL],
        autoSnapshot: false,
      });
      await eventually(() => {
        expect(failed.fake.followers).toHaveLength(1);
      });
      failed.fake.emit({ kind: 'error', error: problem });
      await eventually(() => {
        failed.fixture.detectChanges();
        expect(failed.el.querySelector('[role="alert"]')).not.toBeNull();
      });
      const alert = text(must(failed.el, '[role="alert"]'));
      expect(alert).toContain(
        en.entity.failed.replace('{{noun}}', en.entity.noun.queues),
      );
      expect(alert).toContain('Broker unreachable');
      expect(alert).toContain('Connection refused by rabbit@a.');
      expect(alert).toContain(en.hint.brokerUnreachable);
      failed.el
        .querySelector<HTMLButtonElement>('[role="alert"] button')
        ?.click();
      await eventually(() => {
        expect(failed.fake.followers).toHaveLength(2);
        expect(failed.fake.followers[0]?.active).toBe(false);
      });
      failed.fake.emit(
        failed.fake.snapshotFor(followerAt(failed.fake, 1).params),
      );
      await loaded(failed.el, failed.fixture);
      expect(failed.el.querySelector('[role="alert"]')).toBeNull();

      // A stale index with a row read: the freshness lines say so and the values stay.
      const old = await mountEntity({
        rows: [FULL],
        autoSnapshot: false,
        freshness: { state: 'stale', sweptAt: 1000 },
      });
      await eventually(() => {
        expect(old.fake.followers).toHaveLength(1);
      });
      old.fake.emit(old.fake.snapshotFor(followerAt(old.fake).params));
      await loaded(old.el, old.fixture);
      await eventually(() => {
        old.fixture.detectChanges();
        expect(old.el.querySelector('.banner li')).not.toBeNull();
      });
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-12 copy as text holds what the page shows and a refused clipboard is said',
    async () => {
      const bed = await mountEntity({ rows: [FULL] });
      await loaded(bed.el, bed.fixture);
      const button = (label: string): HTMLButtonElement => {
        const found = [
          ...bed.el.querySelectorAll<HTMLButtonElement>('.actions button'),
        ].find((b) => b.textContent.trim() === label);
        if (found === undefined) throw new Error(`no button ${label}`);
        return found;
      };
      button(en.entity.copyText).click();
      await eventually(() => {
        expect(bed.written).toHaveLength(1);
      });
      const lines = (bed.written[0] ?? '').split('\n');
      expect(lines).toEqual([
        `${column('name')}: orders.q`,
        `${column('vhost')}: orders`,
        `${column('type')}: quorum`,
        `${column('state')}: running`,
        `${column('node')}: rabbit@a`,
        `${column('messages')}: ${numbers.format(1234)}`,
        `${column('messagesReady')}: ${numbers.format(1000)}`,
        `${column('messagesUnacknowledged')}: ${numbers.format(234)}`,
        `${column('consumers')}: 0`,
        `${column('durable')}: ${en.entity.yes}`,
        `${column('autoDelete')}: ${en.entity.no}`,
        `${column('exclusive')}: ${en.entity.no}`,
        `${column('policy')}: ha-all`,
        `${column('operatorPolicy')}: ttl-1h`,
        `${column('deliveryLimit')}: 20`,
        `${en.entity.address}: ${window.location.origin}/c/c1/queues/${keyOf(FULL)}`,
      ]);
      await eventually(() => {
        bed.fixture.detectChanges();
        expect(bed.el.querySelector('.notice')?.textContent.trim()).toBe(
          en.entity.copied,
        );
      });
      button(en.entity.copyLink).click();
      await eventually(() => {
        expect(bed.written[1]).toBe(
          `${window.location.origin}/c/c1/queues/${keyOf(FULL)}`,
        );
        bed.fixture.detectChanges();
        expect(bed.el.querySelector('.notice')?.textContent.trim()).toBe(
          en.entity.linkCopied,
        );
      });

      // A clipboard that refuses is said, for the text and for the link.
      const refused = await mountEntity({
        rows: [FULL],
        refuseClipboard: true,
      });
      await loaded(refused.el, refused.fixture);
      const press = (label: string): void => {
        [...refused.el.querySelectorAll<HTMLButtonElement>('.actions button')]
          .find((b) => b.textContent.trim() === label)
          ?.click();
      };
      press(en.entity.copyText);
      await eventually(() => {
        refused.fixture.detectChanges();
        expect(refused.el.querySelector('.notice')?.textContent.trim()).toBe(
          en.entity.copyFailed,
        );
      });
      press(en.entity.copyLink);
      await eventually(() => {
        refused.fixture.detectChanges();
        expect(refused.el.querySelector('.notice')?.textContent.trim()).toBe(
          en.entity.linkCopyFailed,
        );
      });
      expect(refused.written).toEqual([]);
    },
    PAGE_TEST_TIMEOUT_MS,
  );
});
