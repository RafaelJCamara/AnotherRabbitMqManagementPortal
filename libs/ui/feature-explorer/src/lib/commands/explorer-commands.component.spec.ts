import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { createFakeExplorerData } from '@app/explorer-model/testing';
import {
  COMMAND_CAPABILITIES,
  CommandRegistry,
  type CapabilitySnapshot,
} from '@app/ui-commands';
import { DataGrid, GRID_CLIPBOARD } from '@app/ui-grid';
import {
  eventually,
  restoreGridSpecEnvironment,
  warmUpGrid,
  WARM_UP_TIMEOUT_MS,
} from '@app/ui-grid/testing/components';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { InventoryPage } from '../grid/inventory-page.component';
import { OverviewPage } from '../overview/overview.component';
import { PAGE_TEST_TIMEOUT_MS } from '../testing/dom';
import { FakeWorkspace } from '../testing/fake-workspace';
import { ManualTimer } from '../testing/manual-timer';
import { mountPage } from '../testing/page-testbed';
import { EXPLORER_TIMER } from '../timer';
import {
  EXPLORER_DEFAULT_CHORDS,
  INVENTORY_COMMAND_IDS,
  OVERVIEW_COMMAND_ID,
} from './explorer-commands';

const NAME_CELLS = '.ag-row [col-id="name"]';

const ALLOWED: CapabilitySnapshot = {
  status: 'ready',
  allowedActions: ['views.create'],
  gates: {},
};
const NOT_ALLOWED: CapabilitySnapshot = {
  status: 'ready',
  allowedActions: [],
  gates: {},
};

function listed(id: string) {
  return TestBed.inject(CommandRegistry)
    .commands()
    .find((command) => command.id === id);
}

describe('the explorer commands', () => {
  beforeAll(warmUpGrid, WARM_UP_TIMEOUT_MS);
  afterAll(restoreGridSpecEnvironment);

  it(
    'M1-41 AC-16 the inventory page registers its commands while it lives',
    async () => {
      const fake = createFakeExplorerData({
        rows: { queues: 30 },
        autoSnapshot: true,
      });
      const capabilities = signal<CapabilitySnapshot>(ALLOWED);
      const writeText = vi.fn(() => Promise.resolve());
      const bed = await mountPage(InventoryPage, {
        fake,
        inputs: { kind: 'queues' },
        providers: [
          { provide: COMMAND_CAPABILITIES, useValue: capabilities },
          { provide: GRID_CLIPBOARD, useValue: { writeText } },
        ],
      });
      const registry = TestBed.inject(CommandRegistry);
      await eventually(() => {
        expect(bed.el.querySelectorAll(NAME_CELLS).length).toBeGreaterThan(1);
      }, 8000);

      // All five are listed while the page lives, with English titles, one default chord and no other.
      const ids = registry.commands().map((command) => command.id);
      for (const id of INVENTORY_COMMAND_IDS) expect(ids).toContain(id);
      expect(ids).not.toContain('overview.refresh');
      expect(listed('inventory.focus-filter')?.chords).toEqual(
        EXPLORER_DEFAULT_CHORDS,
      );
      expect(listed('inventory.focus-filter')?.title).toBe('Focus the filter');
      expect(
        INVENTORY_COMMAND_IDS.filter(
          (id) => (listed(id)?.chords.length ?? 0) > 0,
        ),
      ).toEqual(['inventory.focus-filter']);

      // Focus the filter: focus lands on the name field.
      await registry.execute('inventory.focus-filter');
      expect(document.activeElement?.classList.contains('text-input')).toBe(
        true,
      );

      // Reload: the list is asked for again.
      const asked = fake.queries.length;
      await registry.execute('inventory.reload');
      await eventually(() => {
        expect(fake.queries.length).toBeGreaterThan(asked);
      });
      await eventually(() => {
        bed.fixture.detectChanges();
        expect(bed.el.querySelectorAll(NAME_CELLS).length).toBeGreaterThan(1);
      }, 8000);

      // Choose the columns: the grid's chooser opens and takes focus.
      await registry.execute('inventory.columns');
      await eventually(() => {
        bed.fixture.detectChanges();
        expect(
          bed.el.querySelector('app-grid-column-chooser [role="group"]'),
        ).not.toBeNull();
        expect(
          document.activeElement?.closest('app-grid-column-chooser'),
        ).not.toBeNull();
      });

      // Save the view: open when the engine's list has views.create, with focus on the name field.
      expect(listed('inventory.save-view')?.availability.enabled).toBe(true);
      await registry.execute('inventory.save-view');
      await eventually(() => {
        bed.fixture.detectChanges();
        expect(document.activeElement?.classList.contains('name-input')).toBe(
          true,
        );
      });

      // Copy needs a selection: closed with the reason, then it copies through the grid.
      expect(listed('inventory.copy')?.availability).toEqual({
        enabled: false,
        reason: { kind: 'own', text: 'No row is selected.' },
      });
      const grid = bed.fixture.debugElement.query(By.directive(DataGrid))
        .componentInstance as DataGrid<{ key: string }>;
      const rowId = bed.el
        .querySelector<HTMLElement>('.ag-row[row-id]')
        ?.getAttribute('row-id');
      expect(rowId).toBeTruthy();
      grid.selection.set(new Set([rowId ?? '']));
      bed.fixture.detectChanges();
      expect(listed('inventory.copy')?.availability.enabled).toBe(true);
      await registry.execute('inventory.copy');
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(String((writeText.mock.calls as unknown[][])[0]?.[0])).toContain(
        'queue-',
      );

      // The engine does not allow views.create: the command is closed with its reason and does not open the panel.
      capabilities.set(NOT_ALLOWED);
      expect(listed('inventory.save-view')?.availability).toEqual({
        enabled: false,
        reason: { kind: 'not-allowed', action: 'views.create' },
      });
      bed.el.querySelector<HTMLElement>('.name-input')?.blur();
      await registry.execute('inventory.save-view');
      expect(document.activeElement?.classList.contains('name-input')).toBe(
        false,
      );

      // Leaving the page removes all five.
      bed.fixture.destroy();
      const after = registry.commands().map((command) => command.id);
      for (const id of INVENTORY_COMMAND_IDS) expect(after).not.toContain(id);
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'M1-41 AC-17 the overview refresh command respects the floor',
    async () => {
      const timer = new ManualTimer();
      const workspace = new FakeWorkspace();
      workspace.overview = () => ({
        product: 'RabbitMQ',
        version: '4.3.6',
        clusterName: 'rabbit@a',
        totals: { queues: 1, exchanges: 1, connections: 1, consumers: 1 },
        rates: { state: 'unavailable', reason: 'not-reported' },
        nodes: [{ name: 'rabbit@a', running: true, beingDrained: false }],
        alarms: { state: 'none' },
        freshness: {
          state: 'live',
          sweptAt: 1000,
          complete: true,
          loaded: 1,
          truncated: false,
          dropped: 0,
          hazards: [],
          versionChanged: false,
        },
      });
      const bed = await mountPage(OverviewPage, {
        workspace,
        providers: [{ provide: EXPLORER_TIMER, useValue: timer }],
      });
      const registry = TestBed.inject(CommandRegistry);
      const reads = (): number =>
        workspace.requestLines.filter((l) => l.includes('/overview')).length;
      await eventually(() => {
        bed.fixture.detectChanges();
        expect(reads()).toBe(1);
      });

      // Only the overview's command is listed, and inside the floor it is closed with the page's own reason.
      const ids = registry.commands().map((command) => command.id);
      expect(ids).toContain(OVERVIEW_COMMAND_ID);
      for (const id of INVENTORY_COMMAND_IDS) expect(ids).not.toContain(id);
      expect(listed(OVERVIEW_COMMAND_ID)?.availability).toEqual({
        enabled: false,
        reason: {
          kind: 'own',
          text: 'Refresh opens again shortly: each read asks the broker up to three questions.',
        },
      });
      expect((await registry.execute(OVERVIEW_COMMAND_ID)).status).toBe(
        'closed',
      );
      expect(reads()).toBe(1);

      // After the floor it is open, and one run is one read.
      timer.advance(10_000);
      bed.fixture.detectChanges();
      expect(listed(OVERVIEW_COMMAND_ID)?.availability.enabled).toBe(true);
      expect((await registry.execute(OVERVIEW_COMMAND_ID)).status).toBe('ran');
      await eventually(() => {
        expect(reads()).toBe(2);
      });
    },
    PAGE_TEST_TIMEOUT_MS,
  );
});
