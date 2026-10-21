import { TestBed } from '@angular/core/testing';
import { problemResponse } from '@app/ui-platform/testing';
import { describe, expect, it } from 'vitest';

import { fitLayout } from './fit-layout';
import {
  LayoutBackend,
  ManualTimer,
  VIEWPORT_1280,
  cidOf,
  layoutProviders,
  problem,
} from './layout-fixtures';
import { setSidebarWidth } from './layout-ops';
import { defaultLayout, type ShellLayout } from './shell-layout';
import { LAYOUT_SAVE_DELAY_MS, ShellLayoutStore } from './shell-layout-store';

/** A layout with tabs in two groups, a column split and sizes of its own, for profile `cid`. */
function storedFor(cid: string, extra: Partial<ShellLayout['sidebar']> = {}) {
  const base = defaultLayout();
  const tab = (id: string, path: string) => ({
    id,
    url: `/c/${cid}/${path}`,
    label: `${cid} ${path}`,
  });
  return {
    ...base,
    sidebar: { visible: true, width: 310, active: 'explorer', ...extra },
    editor: {
      orientation: 'column' as const,
      groups: [
        {
          weight: 3,
          tabs: [tab('t1', 'explorer'), tab('t2', 'a')],
          activeTab: 't2',
        },
        { weight: 1, tabs: [tab('t3', 'b')], activeTab: 't3' },
      ],
      activeGroup: 1,
    },
    panel: { visible: true, height: 220, active: 'tap' as const },
  } satisfies ShellLayout;
}

function start(backend: LayoutBackend, timer = new ManualTimer()) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: layoutProviders(backend, timer, VIEWPORT_1280),
  });
  return { store: TestBed.inject(ShellLayoutStore), timer };
}

describe('ShellLayoutStore', () => {
  it('AC-5 tabs, splits and panel sizes are restored per profile', async () => {
    const backend = new LayoutBackend();
    const one = storedFor('c1');
    const two = {
      ...storedFor('c2', { width: 280, visible: false }),
      panel: { visible: true, height: 300, active: 'receipts' as const },
    };
    backend.docs.set('c1', one);
    backend.docs.set('c2', two);

    const run = async () => {
      const { store } = start(backend);
      await store.open(cidOf('c1'));
      const first = store.layout();
      await store.open(cidOf('c2'));
      return { first, second: store.layout() };
    };
    const before = await run();
    // The restart: a new store over the same engine.
    const after = await run();

    expect(before.first).toEqual(fitLayout(one, VIEWPORT_1280));
    expect(before.second).toEqual(fitLayout(two, VIEWPORT_1280));
    expect(after).toEqual(before);

    // What was restored, exactly (nothing here needed clamping at 1280x720).
    expect(before.first.editor.orientation).toBe('column');
    expect(before.first.editor.groups.map((g) => g.weight)).toEqual([3, 1]);
    expect(before.first.editor.groups.map((g) => g.activeTab)).toEqual([
      't2',
      't3',
    ]);
    expect(before.first.editor.activeGroup).toBe(1);
    expect(before.first.sidebar.width).toBe(310);
    expect(before.first.panel).toEqual({
      visible: true,
      height: 220,
      active: 'tap',
    });
    expect(before.second.sidebar).toEqual({
      visible: false,
      width: 280,
      active: 'explorer',
    });
    expect(before.second.panel).toEqual({
      visible: true,
      height: 300,
      active: 'receipts',
    });

    // One profile's tabs never appear under the other.
    const urls = (layout: ShellLayout) =>
      layout.editor.groups.flatMap((g) => g.tabs.map((t) => t.url));
    expect(urls(before.first).every((u) => u.startsWith('/c/c1/'))).toBe(true);
    expect(urls(before.second).every((u) => u.startsWith('/c/c2/'))).toBe(true);

    // layouts.get once per open, and nothing was written back.
    expect(backend.gets).toEqual(['c1', 'c2', 'c1', 'c2']);
    expect(backend.puts).toEqual([]);
  });

  it("AC-7 saves are debounced, failures are shown with the engine's reason and nothing is lost", async () => {
    const backend = new LayoutBackend();
    const { store, timer } = start(backend);
    await store.open(cidOf('c1'));
    expect(store.saveState()).toBe('ready');

    // A burst of 20 splitter moves inside the idle delay is one save.
    backend.putAnswers.push(
      problemResponse(
        problem(422, 'GATE_BLOCKED', {
          title: 'Blocked by the guardrail',
          detail: 'Writes are locked on this connection.',
          gate: { enabled: false, reason: 'prod-lock', source: 'guardrail' },
        }),
      ),
      problemResponse(
        problem(503, 'ENGINE_SHUTTING_DOWN', { title: 'Going away' }),
      ),
    );
    for (let width = 200; width < 220; width += 1) {
      store.update((layout) => setSidebarWidth(layout, width));
    }
    expect(store.layout().sidebar.width).toBe(219);
    expect(timer.delays.every((ms) => ms === LAYOUT_SAVE_DELAY_MS)).toBe(true);
    expect(timer.pending).toBe(1);
    expect(backend.puts).toEqual([]);
    timer.fire();
    await store.flush();

    // 422 GATE_BLOCKED: the layout stays applied, the Problem is the engine's, as sent.
    expect(backend.puts).toHaveLength(1);
    expect(backend.puts[0]?.layout).toMatchObject({ sidebar: { width: 219 } });
    expect(store.saveState()).toBe('save-failed');
    expect(store.saveProblem()?.code).toBe('GATE_BLOCKED');
    expect(store.saveProblem()?.problem.title).toBe('Blocked by the guardrail');
    expect(store.saveProblem()?.gate?.reason).toBe('prod-lock');
    expect(store.layout().sidebar.width).toBe(219);

    // A change after the failure arms the timer again; the next save carries the latest layout.
    store.update((layout) => setSidebarWidth(layout, 230));
    expect(store.saveState()).toBe('save-failed');
    timer.fire();
    await store.flush();
    expect(backend.puts).toHaveLength(2);
    expect(backend.puts[1]?.layout).toMatchObject({ sidebar: { width: 230 } });
    expect(store.saveProblem()?.code).toBe('ENGINE_SHUTTING_DOWN');
    expect(store.saveState()).toBe('save-failed');

    // retrySave sends the latest document at once; a 200 clears the failure.
    await store.retrySave();
    expect(backend.puts).toHaveLength(3);
    expect(backend.puts[2]?.layout).toMatchObject({ sidebar: { width: 230 } });
    expect(store.saveState()).toBe('ready');
    expect(store.saveProblem()).toBeNull();
    expect(backend.docs.get('c1')).toMatchObject({ sidebar: { width: 230 } });
    expect(timer.pending).toBe(0);
  });

  it('flushes a pending save when asked (the page becomes hidden)', async () => {
    const backend = new LayoutBackend();
    const { store, timer } = start(backend);
    await store.open(cidOf('c1'));
    store.update((layout) => setSidebarWidth(layout, 250));
    expect(backend.puts).toEqual([]);
    await store.flush();
    expect(backend.puts).toHaveLength(1);
    expect(timer.pending).toBe(0);
    // Nothing pending: nothing is sent.
    await store.flush();
    expect(backend.puts).toHaveLength(1);
  });

  it('keeps a stored layout it could not use until the person changes the layout', async () => {
    const backend = new LayoutBackend();
    const newer = { ...storedFor('c1'), version: 2 };
    backend.docs.set('c1', newer);
    const { store, timer } = start(backend);
    await store.open(cidOf('c1'));
    expect(store.notice()).toBe('newer-version');
    expect(store.layout()).toEqual(fitLayout(defaultLayout(), VIEWPORT_1280));
    // Looking, resizing the window and flushing write nothing.
    store.fit();
    await store.flush();
    timer.fire();
    expect(backend.puts).toEqual([]);
    expect(backend.docs.get('c1')).toBe(newer);
    // A change by the person replaces it.
    store.update((layout) => setSidebarWidth(layout, 240));
    await store.flush();
    expect(backend.puts).toHaveLength(1);
  });

  it('shows the default and writes nothing when layouts.get fails', async () => {
    const backend = new LayoutBackend();
    backend.getAnswer = problemResponse(problem(500, 'INTERNAL'));
    const { store } = start(backend);
    await store.open(cidOf('c1'));
    expect(store.notice()).toBe('load-failed');
    expect(store.saveProblem()?.code).toBe('INTERNAL');
    expect(store.saveState()).toBe('ready');
    await store.flush();
    expect(backend.puts).toEqual([]);
  });

  it('ignores the answer of a profile the person has already left', async () => {
    const backend = new LayoutBackend();
    backend.docs.set('c1', storedFor('c1'));
    backend.docs.set('c2', storedFor('c2', { width: 200 }));
    const { store } = start(backend);
    const first = store.open(cidOf('c1'));
    const second = store.open(cidOf('c2'));
    await Promise.all([first, second]);
    expect(store.layout().sidebar.width).toBe(200);
    expect(store.layout().editor.groups[0]?.tabs[0]?.url).toBe(
      '/c/c2/explorer',
    );
  });
});
