import { createFakeExplorerData } from '@app/explorer-model/testing';
import {
  eventually,
  gridApiOf,
  restoreGridSpecEnvironment,
  warmUpGrid,
  WARM_UP_TIMEOUT_MS,
} from '@app/ui-grid/testing/components';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InventoryPage } from '../grid/inventory-page.component';
import {
  barReady,
  enter,
  textInput,
  type,
  PAGE_TEST_TIMEOUT_MS,
} from '../testing/dom';
import {
  brokerProfileBody,
  FakeWorkspace,
  problemOf,
} from '../testing/fake-workspace';
import { mountPage } from '../testing/page-testbed';
import { mountRoute } from '../testing/router-bed';
import { ProfileStore } from '../profile/profile-store';
import { ViewsControl } from './views-control.component';
import { ViewsStore } from './views-store';

const SAVED = {
  name: 'Quorum orders',
  kind: 'queues',
  definition: {
    version: 1,
    kind: 'queues',
    filter: { text: 'orders', types: ['quorum'], hasConsumers: false },
    columns: {
      version: 1,
      columns: [
        { id: 'messages' },
        { id: 'name' },
        { id: 'vhost' },
        { id: 'policy', hidden: true },
      ],
      sort: [{ columnId: 'messages', direction: 'desc' }],
    },
  },
};

const panel = (el: HTMLElement) =>
  el.querySelector<HTMLElement>('[role="group"][aria-label="Saved views"]');

async function openViews(el: HTMLElement): Promise<HTMLElement> {
  await eventually(() => {
    expect(el.querySelector('.views-toggle')).not.toBeNull();
  }, PAGE_TEST_TIMEOUT_MS);
  const toggle = el.querySelector<HTMLButtonElement>('.views-toggle');
  if (toggle?.getAttribute('aria-expanded') !== 'true') toggle?.click();
  await eventually(() => {
    expect(panel(el)).not.toBeNull();
  }, PAGE_TEST_TIMEOUT_MS);
  const found = panel(el);
  if (!found) throw new Error('no views panel');
  return found;
}

const names = (el: HTMLElement): string[] =>
  [...el.querySelectorAll('.views .list .apply')].map((b) =>
    b.textContent.trim(),
  );

const notices = (el: HTMLElement): string[] =>
  [...el.querySelectorAll('.views .notices li')].map((li) =>
    li.textContent.replace(/\s+/g, ' ').trim(),
  );

const chips = (el: HTMLElement): (string | null)[] =>
  [...el.querySelectorAll('.chip-remove')].map((b) =>
    b.getAttribute('aria-label'),
  );

const nameField = (el: HTMLElement): HTMLInputElement => {
  const found = el.querySelector<HTMLInputElement>('.name-input');
  if (!found) throw new Error('no view name field');
  return found;
};

const button = (el: HTMLElement, selector: string): HTMLButtonElement => {
  const found = el.querySelector<HTMLButtonElement>(selector);
  if (!found) throw new Error(`no ${selector}`);
  return found;
};

describe('<app-views-control>', () => {
  beforeAll(warmUpGrid, WARM_UP_TIMEOUT_MS);
  afterAll(restoreGridSpecEnvironment);

  it(
    'AC-17 a saved view reopened on another connection applies its filters, sort and columns',
    async () => {
      const workspace = new FakeWorkspace();
      const saved = workspace.add(SAVED);

      // Opened on connection c2: the list is the same (a view is not bound to a connection).
      const first = await mountRoute('/queues', { cid: 'c2', workspace });
      const control = await openViews(first.el);
      expect(names(first.el)).toEqual(['Quorum orders']);
      const listCalls = workspace.requestLines.filter((l) =>
        l.includes('/views'),
      );
      expect(listCalls.length).toBeGreaterThan(0);
      expect(listCalls.every((l) => !l.includes('/connections/'))).toBe(true);
      expect(control.getAttribute('aria-label')).toBe('Saved views');

      // Choosing it: the first read carries exactly the saved filter and sort, the chips show the filter,
      // the columns are the saved ones, and the address keeps the view.
      await eventually(() => {
        expect(first.fake.queries.length).toBeGreaterThan(0);
      });
      await eventually(() => {
        expect(
          first.el.querySelectorAll('.ag-row [col-id="name"]').length,
        ).toBeGreaterThan(1);
      }, 8000);
      const before = first.fake.queries.length;
      button(first.el, '.views .list .apply').click();
      // A block of the list shown before the click may still be answered after it, so the first read that
      // carries a filter is the view's; from then on every read carries it (a slow runner showed the
      // earlier block arriving after the click, which is not what is under test).
      await eventually(() => {
        expect(
          first.fake.queries.slice(before).some((q) => q.filter !== undefined),
        ).toBe(true);
      });
      const at = first.fake.queries.findIndex(
        (q, i) => i >= before && q.filter !== undefined,
      );
      const query = first.fake.queries[at];
      expect(query?.filter).toEqual(SAVED.definition.filter);
      expect(query?.sort).toEqual({ column: 'messages', dir: 'desc' });
      expect(query?.cid).toBe('c2');
      expect(
        first.fake.queries.slice(at).every((q) => q.filter !== undefined),
      ).toBe(true);
      await eventually(() => {
        expect(chips(first.el)).toEqual([
          'Remove filter: Name contains "orders"',
          'Remove filter: Queue type quorum',
          'Remove filter: Without consumers',
        ]);
        expect(first.router.url).toBe(`/queues?view=${saved.id}`);
      });
      await eventually(() => {
        const state = gridApiOf(first.el)
          .getColumnState()
          .map((c) => ({ id: c.colId, hide: c.hide === true, sort: c.sort }));
        expect(state.slice(0, 4)).toEqual([
          { id: 'messages', hide: false, sort: 'desc' },
          { id: 'name', hide: false, sort: null },
          { id: 'vhost', hide: false, sort: null },
          { id: 'policy', hide: true, sort: null },
        ]);
      });
      // Focus is back on the button that opened the list, and the list is closed.
      expect(panel(first.el)).toBeNull();
      expect(document.activeElement).toBe(button(first.el, '.views-toggle'));

      // And again through the address: the page reads nothing until the view is in, so its first read is the view's.
      const second = await mountRoute(`/queues?view=${saved.id}`, {
        cid: 'c2',
        workspace,
      });
      await eventually(() => {
        expect(second.fake.queries.length).toBeGreaterThan(0);
      });
      expect(second.fake.queries[0]?.filter).toEqual(SAVED.definition.filter);
      expect(second.fake.queries[0]?.sort).toEqual({
        column: 'messages',
        dir: 'desc',
      });
      expect(second.router.url).toBe(`/queues?view=${saved.id}`);
      await eventually(() => {
        expect(chips(second.el)).toHaveLength(3);
      });
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-18 what a view names and this kind cannot apply is dropped and said, never applied silently',
    async () => {
      const workspace = new FakeWorkspace();
      const exchange = (name: string, definition: Record<string, unknown>) =>
        workspace.add({ name, kind: 'exchanges', definition });
      exchange('Newer', { version: 2, kind: 'exchanges' });
      exchange('Other kind', { version: 1, kind: 'queues', filter: {} });
      exchange('Mixed', {
        version: 1,
        kind: 'exchanges',
        filter: { text: 'zzz', states: ['running'], hasConsumers: true },
        columns: {
          version: 1,
          columns: [{ id: 'bogus' }, { id: 'name' }],
          sort: [{ columnId: 'messages', direction: 'asc' }],
        },
      });
      exchange('Many vhosts', {
        version: 1,
        kind: 'exchanges',
        filter: {
          vhosts: Array.from({ length: 100 }, (_, i) => `vhost-${String(i)}`),
        },
      });
      exchange('Empty', {});
      const fake = createFakeExplorerData({ autoSnapshot: true });
      const { el, fixture } = await mountPage(InventoryPage, {
        fake,
        workspace,
        inputs: { kind: 'exchanges' },
      });
      const apply = async (name: string): Promise<void> => {
        await openViews(el);
        const target = [
          ...el.querySelectorAll<HTMLButtonElement>('.views .list .apply'),
        ].find((b) => b.textContent.trim() === name);
        if (!target) throw new Error(`no view ${name}`);
        target.click();
        fixture.detectChanges();
        await fixture.whenStable();
      };
      await eventually(() => {
        expect(fake.queries.length).toBeGreaterThan(0);
      });
      const queries = fake.queries.length;

      // A newer version and another kind apply nothing, and say so, and nothing is read again.
      await apply('Newer');
      expect(notices(el)).toEqual([
        'Nothing in this view applies to this list, so nothing changed.',
        'Not applied: the view was saved by a newer version.',
      ]);
      await apply('Other kind');
      expect(notices(el)).toEqual([
        'Nothing in this view applies to this list, so nothing changed.',
        'Not applied: the view is for another list (queues).',
      ]);
      await apply('Empty');
      expect(notices(el)[0]).toBe(
        'Nothing in this view applies to this list, so nothing changed.',
      );
      expect(fake.queries).toHaveLength(queries);

      // A facet the kind cannot apply and a column it does not have are dropped, each one named; the rest applies.
      await apply('Mixed');
      expect(notices(el)).toEqual([
        'Not applied: the filter states does not apply to this list.',
        'Not applied: the filter hasConsumers does not apply to this list.',
        'Not applied: the column bogus is not available in this list.',
        'Not applied: the column messages is not available in this list.',
      ]);
      await eventually(() => {
        expect(fake.queries.at(-1)?.filter).toEqual({ text: 'zzz' }); // never states or hasConsumers
      });
      // A filter that matches no row lists the chips that caused it, and only those.
      await eventually(() => {
        expect(el.querySelector('.no-match')?.textContent.trim()).toBe(
          'No rows match these filters: Name contains "zzz"',
        );
      });
      expect(chips(el)).toEqual(['Remove filter: Name contains "zzz"']);
      expect(
        [...el.querySelectorAll('.ag-header-cell-text')][0]?.textContent.trim(),
      ).toBe('Name');

      // Values over a cap are cut and said.
      await apply('Many vhosts');
      expect(notices(el)).toEqual([
        'Not applied: the filter vhosts has more values than the list allows; the extra values were left out.',
      ]);
      await eventually(() => {
        expect(fake.queries.at(-1)?.filter?.vhosts).toHaveLength(25);
      });
      expect(chips(el)).toHaveLength(25);
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    "AC-19 saving a view is bounded, a refusal shows the engine's reason, and replacing never loses a view",
    async () => {
      // A definition over the contract's limit is refused before any call (the control is given one directly:
      // the UI itself cannot make one this large).
      const big = new FakeWorkspace();
      const huge = await mountPage(ViewsControl, {
        workspace: big,
        providers: [ProfileStore, ViewsStore],
        inputs: {
          kind: 'queues',
          current: {
            version: 1,
            kind: 'queues',
            filter: { text: 'x'.repeat(16_500) },
            columns: { version: 1, columns: [], sort: [] },
          },
        },
      });
      await openViews(huge.el);
      await eventually(() => {
        expect(
          huge.el
            .querySelector('.save app-gated button.control')
            ?.getAttribute('aria-disabled'),
        ).toBeNull(); // the gate opened once the profile was read
      });
      nameField(huge.el).value = 'Huge';
      button(huge.el, '.save app-gated button.control').click();
      await eventually(() => {
        expect(notices(huge.el)).toEqual([
          'This view is too large to save (at most 16384 characters).',
        ]);
      });
      expect(big.requestLines.some((l) => l.startsWith('POST'))).toBe(false);

      // A page with a filter applied; the engine refuses the save: its Problem as sent, and nothing is lost.
      const workspace = new FakeWorkspace();
      const fake = createFakeExplorerData({ autoSnapshot: true });
      const page = await mountPage(InventoryPage, {
        fake,
        workspace,
        inputs: { kind: 'queues' },
      });
      // The filter is typed once the page has made its first read. `queries.at(-1)` is also undefined when no
      // query has been made yet, so a runner that was slow to render the page read as "the filter was not
      // applied" (macOS CI); the first read is awaited on its own, with the bound the other page specs use.
      await eventually(() => {
        expect(fake.queries.length).toBeGreaterThan(0);
      }, 8000);
      await barReady(page.fixture, page.el);
      type(textInput(page.el), 'orders');
      enter(textInput(page.el));
      await eventually(() => {
        expect(fake.queries.at(-1)?.filter).toEqual({ text: 'orders' });
      });
      await openViews(page.el);
      await eventually(() => {
        expect(
          page.el
            .querySelector('.save app-gated button.control')
            ?.getAttribute('aria-disabled'),
        ).toBeNull();
      });
      const save = async (name: string): Promise<void> => {
        await openViews(page.el);
        nameField(page.el).value = name;
        button(page.el, '.save app-gated button.control').click();
      };
      workspace.failure.create = problemOf(422, 'GATE_BLOCKED', {
        title: 'Blocked by the production lock',
        detail: 'Saving views is blocked until the lock is lifted.',
      });
      await save('Mine');
      await eventually(() => {
        expect(notices(page.el)).toEqual([
          'The view could not be saved. Blocked by the production lock Saving views is blocked until the lock is lifted.',
        ]);
      });
      expect(workspace.views).toEqual([]);
      expect(chips(page.el)).toEqual(['Remove filter: Name contains "orders"']); // the filter stays applied
      workspace.failure.create = problemOf(503, 'INTERNAL', {
        title: 'Workspace unavailable',
      });
      await save('Mine');
      await eventually(() => {
        expect(notices(page.el)[0]).toContain('Workspace unavailable');
      });

      // A save that succeeds is listed; the view stores the filter in force.
      delete workspace.failure.create;
      await save('Mine');
      await eventually(() => {
        expect(names(page.el)).toEqual(['Mine']);
        expect(notices(page.el)).toEqual(['View saved.']);
      });
      expect(workspace.views[0]?.definition).toMatchObject({
        version: 1,
        kind: 'queues',
        filter: { text: 'orders' },
      });
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'deleting asks first, and replacing creates the new view before it deletes the old one',
    async () => {
      const workspace = new FakeWorkspace();
      workspace.add({
        name: 'Mine',
        kind: 'queues',
        definition: { version: 1, kind: 'queues', filter: { text: 'orders' } },
      });
      const page = await mountPage(InventoryPage, {
        workspace,
        inputs: { kind: 'queues' },
      });
      await openViews(page.el);
      await eventually(() => {
        expect(names(page.el)).toEqual(['Mine']);
        expect(
          page.el.querySelector('.views-toggle')?.getAttribute('aria-expanded'),
        ).toBe('true');
      });

      // Delete asks first, inline; Cancel changes nothing.
      button(page.el, '.delete-ask').click();
      await eventually(() => {
        expect(page.el.querySelector('.confirm')?.textContent).toContain(
          'Delete the view Mine?',
        );
      });
      expect(workspace.requestLines.some((l) => l.startsWith('DELETE'))).toBe(
        false,
      );
      button(page.el, '.confirm .cancel').click();
      await eventually(() => {
        expect(page.el.querySelector('.confirm')).toBeNull();
      });
      // Replacing creates the new view first and deletes the old one second; a failed delete leaves both, listed.
      workspace.failure.delete = problemOf(503, 'INTERNAL', {
        title: 'Delete failed',
      });
      const posts = workspace.requestLines.filter((l) =>
        l.startsWith('POST'),
      ).length;
      button(page.el, '.replace-ask').click();
      await eventually(() => {
        expect(page.el.querySelector('.confirm')).not.toBeNull();
      });
      button(page.el, '.confirm app-gated button.control').click();
      await eventually(() => {
        expect(names(page.el)).toEqual(['Mine', 'Mine']);
        expect(notices(page.el)[0]).toContain(
          'The new view was saved but the old one could not be deleted, so both are listed.',
        );
      });
      const lines = workspace.requestLines;
      const lastOf = (method: string): number =>
        lines.reduce((at, l, i) => (l.startsWith(method) ? i : at), -1);
      const create = lastOf('POST');
      const remove = lastOf('DELETE');
      expect(lines.filter((l) => l.startsWith('POST'))).toHaveLength(posts + 1);
      expect(create).toBeLessThan(remove); // create first, delete second
      // With the engine's refusal lifted the delete goes through, after the inline confirmation.
      delete workspace.failure.delete;
      button(page.el, '.delete-ask').click();
      await eventually(() => {
        expect(page.el.querySelector('.confirm')).not.toBeNull();
      });
      button(page.el, '.confirm app-gated button.control').click();
      await eventually(() => {
        expect(names(page.el)).toEqual(['Mine']);
        expect(notices(page.el)).toEqual(['View deleted.']);
      });
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'Save and Delete are closed with a stated reason when the engine does not list the action or the profile is unknown',
    async () => {
      // The profile lists delete but not create: Save is closed, with the reason, and a click does nothing.
      const workspace = new FakeWorkspace();
      workspace.profile = (cid) =>
        brokerProfileBody(cid, { allowedActions: ['views.delete'] });
      workspace.add(SAVED);
      const page = await mountPage(InventoryPage, {
        workspace,
        inputs: { kind: 'queues' },
      });
      await openViews(page.el);
      await eventually(() => {
        const save = page.el.querySelector('.save app-gated');
        expect(
          save?.querySelector('button')?.getAttribute('aria-disabled'),
        ).toBe('true');
        expect(save?.querySelector('.reason-text')?.textContent.trim()).toBe(
          'The engine does not allow you to save views.',
        );
      });
      button(page.el, '.save app-gated button.control').click();
      expect(workspace.requestLines.some((l) => l.startsWith('POST'))).toBe(
        false,
      );
      // Delete is open; replacing needs both, so its confirmation is closed.
      button(page.el, '.replace-ask').click();
      await eventually(() => {
        expect(
          page.el
            .querySelector('.confirm app-gated button')
            ?.getAttribute('aria-disabled'),
        ).toBe('true');
      });

      // A profile that is not known closes both, and says it is not known (never "available").
      const unknown = new FakeWorkspace();
      unknown.failure.profile = problemOf(404, 'NOT_FOUND', {
        title: 'Not probed',
      });
      unknown.add(SAVED);
      const other = await mountPage(InventoryPage, {
        workspace: unknown,
        inputs: { kind: 'queues' },
      });
      await openViews(other.el);
      await eventually(() => {
        expect(
          other.el
            .querySelector('.save app-gated .reason-text')
            ?.textContent.trim(),
        ).toBe('The permissions of this connection are not known.');
      });
      button(other.el, '.delete-ask').click();
      await eventually(() => {
        const gate = other.el.querySelector('.confirm app-gated');
        expect(
          gate?.querySelector('button')?.getAttribute('aria-disabled'),
        ).toBe('true');
        expect(gate?.querySelector('.reason-text')?.textContent.trim()).toBe(
          'The permissions of this connection are not known.',
        );
      });

      // A profile that does not parse is unknown too, and a list that is absent is not "allowed".
      const odd = new FakeWorkspace();
      odd.profile = (cid) => ({ ...brokerProfileBody(cid), schemaVersion: 2 });
      const third = await mountPage(InventoryPage, {
        workspace: odd,
        inputs: { kind: 'queues' },
      });
      await openViews(third.el);
      await eventually(() => {
        expect(
          third.el
            .querySelector('.save app-gated button')
            ?.getAttribute('aria-disabled'),
        ).toBe('true');
      });
      const absent = new FakeWorkspace();
      absent.profile = (cid) => brokerProfileBody(cid); // no allowedActions at all
      const fourth = await mountPage(InventoryPage, {
        workspace: absent,
        inputs: { kind: 'queues' },
      });
      await openViews(fourth.el);
      await eventually(() => {
        expect(
          fourth.el
            .querySelector('.save app-gated .reason-text')
            ?.textContent.trim(),
        ).toBe('The permissions of this connection are not known.');
      });
    },
    PAGE_TEST_TIMEOUT_MS,
  );
});
