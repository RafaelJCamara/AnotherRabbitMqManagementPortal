import {
  eventually,
  restoreGridSpecEnvironment,
  warmUpGrid,
  WARM_UP_TIMEOUT_MS,
} from '@app/ui-grid/testing/components';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PAGE_TEST_TIMEOUT_MS } from '../testing/dom';
import { FakeWorkspace, problemOf } from '../testing/fake-workspace';
import { ManualTimer } from '../testing/manual-timer';
import { mountPage } from '../testing/page-testbed';
import { EXPLORER_TIMER } from '../timer';
import { OverviewPage } from './overview.component';

const time = (ms: number): string => `T${String(ms)}`;

const FRESH = {
  state: 'live',
  sweptAt: 1000,
  complete: true,
  loaded: 12,
  truncated: false,
  dropped: 0,
  hazards: [],
  versionChanged: false,
};

const NODES = [
  { name: 'rabbit@a', running: true, beingDrained: false },
  { name: 'rabbit@b', running: false },
  { name: 'rabbit@c', running: true, beingDrained: true },
];

/** An `overview.get` answer; the parts a spec varies come in as `over`. */
function overview(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    product: 'RabbitMQ',
    version: '4.3.6',
    clusterName: 'rabbit@a',
    totals: { queues: 12, exchanges: 8, connections: 3, consumers: 5 },
    rates: { state: 'unavailable', reason: 'not-reported' },
    nodes: NODES,
    alarms: { state: 'none' },
    freshness: FRESH,
    ...over,
  };
}

async function open(
  body: Record<string, unknown>,
  options: { timer?: ManualTimer; workspace?: FakeWorkspace } = {},
) {
  const workspace = options.workspace ?? new FakeWorkspace();
  workspace.overview = () => body;
  const timer = options.timer ?? new ManualTimer();
  const bed = await mountPage(OverviewPage, {
    workspace,
    inputs: { time },
    providers: [{ provide: EXPLORER_TIMER, useValue: timer }],
  });
  await eventually(() => {
    bed.fixture.detectChanges();
    expect(bed.el.querySelector('.region')).not.toBeNull();
  });
  return { ...bed, workspace, timer };
}

const text = (el: HTMLElement, selector: string): string =>
  (el.querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();

const region = (el: HTMLElement, name: string): HTMLElement => {
  const found = [...el.querySelectorAll<HTMLElement>('section.region')].find(
    (s) => s.querySelector('h2')?.textContent.trim().startsWith(name),
  );
  if (!found) throw new Error(`no region ${name}`);
  return found;
};

const reads = (workspace: FakeWorkspace): number =>
  workspace.requestLines.filter((l) => l.includes('/overview')).length;

describe('<app-overview>', () => {
  beforeAll(warmUpGrid, WARM_UP_TIMEOUT_MS);
  afterAll(restoreGridSpecEnvironment);

  it(
    'M0-54 AC-20 the overview shows totals as sent and labels unavailable rates with their reason',
    async () => {
      // A 4.2.9 broker with statistics off: counts without channels, a partial sum, and no rates.
      const off = await open(
        overview({
          version: '4.2.9',
          totals: {
            queues: 12,
            exchanges: 8,
            connections: 3,
            consumers: 0,
            messages: {
              total: 1234,
              ready: 1000,
              unacknowledged: 234,
              source: 'queue-sweep',
              asOf: 5000,
              complete: false,
            },
          },
          rates: { state: 'unavailable', reason: 'statistics-off' },
          freshness: { ...FRESH, state: 'loading', complete: false },
        }),
      );
      const totals = region(off.el, 'Totals');
      expect(text(totals, 'dl')).toContain('Queues 12');
      expect(text(totals, 'dl')).toContain('Exchanges 8');
      expect(text(totals, 'dl')).toContain('Connections 3');
      // A real 0 reads as 0; a total the broker did not send reads "not reported", never 0.
      expect(text(totals, 'dl')).toContain('Consumers 0');
      expect(text(totals, 'dl')).toContain('Channels not reported');
      // The messages say where they come from, what they describe, and that the sum is partial.
      expect(text(totals, '.source')).toBe(
        'Summed from the last queue read, as of T5000.',
      );
      expect(text(totals, '.partial')).toBe(
        'Partial: some queues did not report a count.',
      );
      expect(text(totals, 'dl:nth-of-type(2)')).toContain('Total 1,234');
      // Rates are off: the reason in words and no number at all.
      const rates = region(off.el, 'Rates');
      expect(text(rates, '.unavailable')).toBe(
        'Statistics are off on this broker, so it does not report rates.',
      );
      expect(rates.querySelector('dl')).toBeNull();
      expect(rates.textContent).not.toMatch(/\d/);
      expect(off.el.textContent).not.toMatch(/prometheus/i);
      // The inventory's freshness is the banner's, so a partial read is never called complete.
      expect(text(region(off.el, 'Inventory'), '.banner')).toContain(
        'Loading the inventory',
      );

      // Statistics on: the broker's totals and rates as sent, a reported 0 rate stays 0.
      const on = await open(
        overview({
          totals: {
            queues: 1_000,
            exchanges: 8,
            connections: 3,
            channels: 7,
            consumers: 5,
            messages: {
              total: 10,
              ready: 6,
              unacknowledged: 4,
              source: 'broker-overview',
              asOf: 6000,
              complete: true,
            },
          },
          rates: {
            state: 'available',
            source: 'broker-overview',
            publishPerSec: 12.5,
            deliverPerSec: 0,
          },
        }),
      );
      expect(text(region(on.el, 'Totals'), 'dl')).toContain('Queues 1,000');
      expect(text(region(on.el, 'Totals'), 'dl')).toContain('Channels 7');
      expect(text(region(on.el, 'Totals'), '.source')).toBe(
        'Reported by the broker, as of T6000.',
      );
      expect(region(on.el, 'Totals').querySelector('.partial')).toBeNull();
      expect(text(region(on.el, 'Rates'), 'dl')).toBe(
        'Published per second 12.5 Delivered per second 0',
      );
      expect(on.el.textContent).not.toMatch(/prometheus/i);

      // A rate the broker did not send reads "not reported", never 0; no messages total reads the same.
      const partial = await open(
        overview({
          totals: { queues: 1 },
          rates: {
            state: 'available',
            source: 'broker-overview',
            publishPerSec: 1,
          },
        }),
      );
      expect(text(region(partial.el, 'Rates'), 'dl')).toBe(
        'Published per second 1 Delivered per second not reported',
      );
      expect(text(region(partial.el, 'Totals'), 'dl')).toContain(
        'Exchanges not reported',
      );
      expect(text(region(partial.el, 'Totals'), 'h3 + p')).toBe('not reported');
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'M0-54 AC-21 an alarm names its node and resource, and an unreadable alarm state is never shown as none',
    async () => {
      const active = await open(
        overview({
          alarms: {
            state: 'active',
            active: [
              { node: 'rabbit@a', resource: 'memory' },
              { node: 'rabbit@b', resource: 'disk' },
            ],
          },
        }),
      );
      const alert = region(active.el, 'Alarms').querySelector('[role="alert"]');
      expect(alert?.textContent).toContain('rabbit@a: memory');
      expect(alert?.textContent).toContain('rabbit@b: disk');
      expect(region(active.el, 'Alarms').textContent).not.toContain(
        'No alarm is reported',
      );

      const none = await open(overview({ alarms: { state: 'none' } }));
      expect(text(region(none.el, 'Alarms'), '.none')).toBe(
        'No alarm is reported.',
      );
      expect(none.el.querySelector('[role="alert"]')).toBeNull();

      const unknown = await open(
        overview({
          alarms: {
            state: 'unknown',
            reason: 'The alarm state could not be read.',
          },
        }),
      );
      const words = text(region(unknown.el, 'Alarms'), '.unknown');
      expect(words).toContain('it is not known whether an alarm is active');
      expect(words).toContain('The alarm state could not be read.'); // the engine's reason, as sent
      expect(region(unknown.el, 'Alarms').textContent).not.toContain(
        'No alarm is reported',
      );
      expect(unknown.el.querySelector('[role="alert"]')).toBeNull();

      // The nodes are a real table with named columns: running or stopped, draining or not, as text.
      const table = region(none.el, 'Nodes').querySelector('table');
      expect(table?.querySelector('caption')?.textContent.trim()).toBe(
        'Nodes of the cluster',
      );
      expect(
        [...(table?.querySelectorAll('thead th') ?? [])].map((h) =>
          h.textContent.trim(),
        ),
      ).toEqual(['Node', 'State', 'Draining']);
      expect(
        [...(table?.querySelectorAll('tbody tr') ?? [])].map((row) =>
          row.textContent.replace(/\s+/g, ' ').trim(),
        ),
      ).toEqual([
        'rabbit@a Running Not being drained',
        'rabbit@b Stopped not reported',
        'rabbit@c Running Being drained',
      ]);
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'M0-54 AC-23 the overview loads on open and on a spaced refresh and never polls',
    async () => {
      const timer = new ManualTimer();
      const bed = await open(overview({ product: 'First read' }), { timer });
      const { workspace } = bed;
      const refresh = (): HTMLButtonElement => {
        const button = bed.el.querySelector<HTMLButtonElement>('.refresh');
        if (!button) throw new Error('no refresh button');
        return button;
      };

      // One read on open. Inside the floor the control is closed and says why; pressing it does nothing.
      expect(reads(workspace)).toBe(1);
      expect(refresh().getAttribute('aria-disabled')).toBe('true');
      expect(text(bed.el, '.why')).toBe(
        'Refresh opens again shortly: each read asks the broker up to three questions.',
      );
      expect(refresh().getAttribute('aria-describedby')).toBe(
        bed.el.querySelector('.why')?.id,
      );
      refresh().click();
      refresh().click();
      await bed.fixture.whenStable();
      expect(reads(workspace)).toBe(1);

      // After the floor it opens again, and one press is one read.
      timer.advance(9_999);
      bed.fixture.detectChanges();
      expect(refresh().getAttribute('aria-disabled')).toBe('true');
      timer.advance(1);
      bed.fixture.detectChanges();
      expect(refresh().getAttribute('aria-disabled')).toBeNull();
      expect(bed.el.querySelector('.why')).toBeNull();
      workspace.overview = () => overview({ product: 'Second read' });
      refresh().click();
      await eventually(() => {
        bed.fixture.detectChanges();
        expect(text(bed.el, '.identity')).toContain('Second read');
      });
      expect(reads(workspace)).toBe(2);

      // A refresh that fails shows the engine's Problem as sent and keeps the last answer, marked as earlier.
      timer.advance(10_000);
      bed.fixture.detectChanges();
      workspace.failure.overview = problemOf(503, 'BROKER_ERROR', {
        title: 'The broker did not answer',
        detail: 'The overview could not be read.',
      });
      refresh().click();
      await eventually(() => {
        bed.fixture.detectChanges();
        expect(bed.el.querySelector('[role="alert"].failure')).not.toBeNull();
      });
      const failure = text(bed.el, '[role="alert"].failure');
      expect(failure).toContain(
        'This is the answer of an earlier read. The last read failed:',
      );
      expect(failure).toContain('The broker did not answer');
      expect(text(bed.el, '.identity')).toContain('Second read'); // the last good answer is still there
      expect(reads(workspace)).toBe(3);

      // Ten minutes pass with the page open: no read is made by the clock.
      timer.advance(600_000);
      await bed.fixture.whenStable();
      expect(reads(workspace)).toBe(3);

      // Every region is labelled by its heading.
      for (const section of bed.el.querySelectorAll<HTMLElement>(
        'section.region',
      )) {
        const label = section.getAttribute('aria-labelledby');
        expect(label).toBeTruthy();
        expect(
          label ? bed.el.querySelector(`#${label}`)?.textContent.trim() : '',
        ).toBeTruthy();
      }
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'M0-54 AC-29 a first read that fails says so with the engine problem and a sentence of help for an unreachable broker and a refused login, and shows no numbers',
    async () => {
      const cases = [
        {
          problem: problemOf(502, 'BROKER_UNREACHABLE', {
            title: 'Broker unreachable',
            detail: 'The management API did not answer.',
          }),
          help: 'The engine could not reach the broker.',
        },
        {
          problem: problemOf(401, 'UNAUTHENTICATED', {
            title: 'Login refused',
            detail: 'The broker answered 401.',
          }),
          help: 'the broker refused the login stored for this connection',
        },
        {
          problem: problemOf(500, 'INTERNAL', { title: 'Something broke' }),
          help: null,
        },
      ];
      for (const { problem, help } of cases) {
        const workspace = new FakeWorkspace();
        workspace.overview = () => overview();
        workspace.failure.overview = problem;
        const bed = await mountPage(OverviewPage, {
          workspace,
          providers: [{ provide: EXPLORER_TIMER, useValue: new ManualTimer() }],
        });
        await eventually(() => {
          bed.fixture.detectChanges();
          expect(bed.el.querySelector('[role="alert"].failure')).not.toBeNull();
        });
        const failure = text(bed.el, '[role="alert"].failure');
        expect(failure).toContain('The overview could not be read.');
        expect(failure).toContain(problem.title);
        if (problem.detail) expect(failure).toContain(problem.detail);
        if (help === null) {
          expect(bed.el.querySelector('.hint')).toBeNull();
        } else {
          expect(text(bed.el, '.hint')).toContain(help);
        }
        // Nothing is shown as if it were read.
        expect(bed.el.querySelector('section.region')).toBeNull();
        expect(bed.el.querySelector('.identity')).toBeNull();
      }
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it('shows no content and makes no call without a connection', async () => {
    const workspace = new FakeWorkspace();
    const bed = await mountPage(OverviewPage, { workspace, cid: null });
    await bed.fixture.whenStable();
    expect(bed.el.querySelector('h1')).toBeNull();
    expect(reads(workspace)).toBe(0);
  });
});
