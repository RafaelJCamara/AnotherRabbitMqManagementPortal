// The first run (found by the first real-browser session of M0-52 and M0-54): a connection nobody has probed has no
// cached profile, so `profile.get` and every `inventory.query` answer NOT_FOUND until `probe.run` has stored one. The
// pages must say so in words and offer one button that probes and then loads, not fail in their own way. The specs run
// the real pages over the fake engine (`FakeWorkspace` answers `profile.get`, `probe.run` and `overview.get`) and the
// model's fake data port for the inventory; the engine's own answer to an unprobed connection is proved in
// `libs/testkit/src/explorer-ui/first-run.spec.ts`.
import {
  eventually,
  restoreGridSpecEnvironment,
  warmUpGrid,
  WARM_UP_TIMEOUT_MS,
} from '@app/ui-grid/testing/components';
import { createFakeExplorerData } from '@app/explorer-model/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InventoryPage } from '../grid/inventory-page.component';
import { OverviewPage } from '../overview/overview.component';
import { PAGE_TEST_TIMEOUT_MS } from '../testing/dom';
import { FakeWorkspace, problemOf } from '../testing/fake-workspace';
import { ManualTimer } from '../testing/manual-timer';
import { mountPage } from '../testing/page-testbed';
import { EXPLORER_TIMER } from '../timer';

const text = (el: HTMLElement): string =>
  el.textContent.replace(/\s+/g, ' ').trim();

const requireEl = (el: HTMLElement, selector: string): HTMLElement => {
  const found = el.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`no ${selector}`);
  return found;
};

const run = (el: HTMLElement): HTMLButtonElement => {
  const found = el.querySelector<HTMLButtonElement>('button.run');
  if (!found) throw new Error('no probe button');
  return found;
};

const probeCalls = (workspace: FakeWorkspace): string[] =>
  workspace.requestLines.filter((line) => line.includes('/probe'));

const OVERVIEW = {
  product: 'RabbitMQ',
  version: '4.3.6',
  totals: { queues: 12 },
  rates: { state: 'unavailable', reason: 'not-reported' },
  nodes: [{ name: 'rabbit@a', running: true }],
  alarms: { state: 'none' },
  freshness: {
    state: 'live',
    complete: true,
    loaded: 12,
    truncated: false,
    dropped: 0,
    hazards: [],
    versionChanged: false,
  },
};

describe('the first run of the explorer', () => {
  beforeAll(warmUpGrid, WARM_UP_TIMEOUT_MS);
  afterAll(restoreGridSpecEnvironment);

  it(
    'AC-29 a never-probed connection shows a prompt and reads nothing; one press probes, a refusal is shown as sent with help, and the next press loads the list',
    async () => {
      const workspace = new FakeWorkspace();
      workspace.profile = null; // NOT_FOUND, as the engine answers before the first probe
      const fake = createFakeExplorerData({ autoSnapshot: true });
      const page = await mountPage(InventoryPage, {
        fake,
        workspace,
        inputs: { kind: 'queues' },
      });
      await eventually(() => {
        page.fixture.detectChanges();
        expect(page.el.querySelector('button.run')).not.toBeNull();
      });
      // In words, and with the one way forward; no grid, no filter bar, no read, no subscription.
      expect(text(page.el)).toContain(
        'This connection has not been checked yet',
      );
      expect(text(page.el)).toContain('has not looked at this broker yet');
      expect(text(page.el)).toContain('Check capabilities and load');
      expect(page.el.querySelector('.ag-root-wrapper')).toBeNull();
      expect(page.el.querySelector('form[role="search"]')).toBeNull();
      expect(fake.queries).toEqual([]);
      expect(fake.followers).toEqual([]);

      // The broker refuses the stored login: the engine's Problem as sent, a sentence of help, still no read, and
      // the button stays so that a fixed login can be tried again.
      workspace.failure.probe = problemOf(401, 'UNAUTHENTICATED', {
        title: 'The broker refused the login',
        detail: 'The management API answered 401.',
      });
      run(page.el).click();
      await eventually(() => {
        page.fixture.detectChanges();
        expect(page.el.querySelector('.failure')).not.toBeNull();
      });
      const failure = text(requireEl(page.el, '.failure'));
      expect(failure).toContain('The check did not finish.');
      expect(failure).toContain('The broker refused the login');
      expect(failure).toContain('The management API answered 401.');
      expect(failure).toContain('launch link of this page is no longer valid');
      expect(fake.queries).toEqual([]);
      expect(page.el.querySelector('button.run')).not.toBeNull();
      expect(probeCalls(workspace)).toHaveLength(1);

      // The next press succeeds: the profile the probe answered opens the page, which reads the first block.
      workspace.failure = {};
      run(page.el).click();
      await eventually(() => {
        page.fixture.detectChanges();
        expect(
          page.el.querySelectorAll('.ag-row [col-id="name"]').length,
        ).toBeGreaterThan(1);
      }, 8000);
      expect(probeCalls(workspace)).toHaveLength(2);
      expect(page.el.querySelector('button.run')).toBeNull();
      expect(text(page.el)).not.toContain('has not been checked yet');
      expect(fake.queries.length).toBeGreaterThan(0);
      // The probe's own answer was used: profile.get was asked once, when the page opened, and not again.
      expect(
        workspace.requestLines.filter((l) => l.endsWith('/profile')),
      ).toHaveLength(1);
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-29 a stored profile this version cannot read is said to be out of date and offers the same probe',
    async () => {
      const workspace = new FakeWorkspace();
      workspace.profile = () => ({ schemaVersion: 0, notAProfile: true });
      const fake = createFakeExplorerData();
      const page = await mountPage(InventoryPage, {
        fake,
        workspace,
        inputs: { kind: 'exchanges' },
      });
      await eventually(() => {
        page.fixture.detectChanges();
        expect(page.el.querySelector('button.run')).not.toBeNull();
      });
      expect(text(page.el)).toContain('were written by another version');
      expect(fake.queries).toEqual([]);
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-29 the capability card of the overview offers the probe for a never-probed connection and shows the gates after it',
    async () => {
      const workspace = new FakeWorkspace();
      workspace.profile = null;
      workspace.overview = () => OVERVIEW;
      const page = await mountPage(OverviewPage, {
        workspace,
        providers: [{ provide: EXPLORER_TIMER, useValue: new ManualTimer() }],
      });
      await eventually(() => {
        page.fixture.detectChanges();
        expect(page.el.querySelector('button.run')).not.toBeNull();
      });
      // The overview itself reads the broker and does not need a profile; the card says what is not known.
      expect(text(page.el)).toContain('RabbitMQ');
      expect(text(page.el)).toContain(
        'The capabilities of this connection are not known.',
      );
      expect(page.el.querySelector('table.gates')).toBeNull();

      run(page.el).click();
      await eventually(() => {
        page.fixture.detectChanges();
        expect(page.el.querySelector('button.run')).toBeNull();
      });
      expect(probeCalls(workspace)).toHaveLength(1);
      // A probed profile of this fake has no gates: the card says so rather than "everything is available".
      expect(text(page.el)).toContain(
        'The capabilities of this connection are not known.',
      );
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-29 a connection the engine cannot probe (no such connection) shows the engine problem and no list',
    async () => {
      const workspace = new FakeWorkspace();
      workspace.profile = null;
      workspace.failure.probe = problemOf(404, 'NOT_FOUND', {
        title: 'Not found',
        detail: 'There is no such connection.',
      });
      const fake = createFakeExplorerData();
      const page = await mountPage(InventoryPage, {
        fake,
        workspace,
        inputs: { kind: 'queues' },
      });
      await eventually(() => {
        page.fixture.detectChanges();
        expect(page.el.querySelector('button.run')).not.toBeNull();
      });
      run(page.el).click();
      await eventually(() => {
        page.fixture.detectChanges();
        expect(text(page.el)).toContain('There is no such connection.');
      });
      expect(fake.queries).toEqual([]);
    },
    PAGE_TEST_TIMEOUT_MS,
  );
});
