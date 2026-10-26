import type { EnvironmentProviders, Provider } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { TransportRequest, TransportResponse } from '@app/ui-platform';
import { problemResponse } from '@app/ui-platform/testing';
import { describe, expect, it } from 'vitest';

import {
  SCOPE_LOADERS,
  provideI18n,
  provideScopes,
} from '../../i18n/i18n.config';
import { markerLoaders, settle } from '../../i18n/test-fixtures';
import { LayoutNotices } from '../notices/layout-notices';
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

/** An engine whose `layouts.put` waits for the spec while `hold` is set. */
class HeldBackend extends LayoutBackend {
  hold: Promise<void> | null = null;
  override handle(
    request: TransportRequest,
  ): TransportResponse | Promise<TransportResponse> {
    if (request.method !== 'GET' && this.hold !== null) {
      return this.hold.then(() => super.handle(request));
    }
    return super.handle(request);
  }
}

function start(
  backend: LayoutBackend,
  timer = new ManualTimer(),
  extra: readonly (EnvironmentProviders | Provider)[] = [],
) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [...layoutProviders(backend, timer, VIEWPORT_1280), ...extra],
  });
  return { store: TestBed.inject(ShellLayoutStore), timer };
}

/** The words a spec sees: every key is answered as `[[key]]`; engine data is shown as it is. */
const noticeProviders: readonly (EnvironmentProviders | Provider)[] = [
  provideI18n(),
  provideScopes('shell'),
  { provide: SCOPE_LOADERS, useValue: markerLoaders() },
];

/** Whether a person can see the element: no `hidden`, `aria-hidden`, `display: none` or `visibility: hidden` on it or above it. */
function isVisible(element: Element | null): boolean {
  for (let node = element; node !== null; node = node.parentElement) {
    if (node.hasAttribute('hidden') || node.hasAttribute('aria-hidden')) {
      return false;
    }
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
  }
  return element !== null;
}

/** The save-failure alert of the shell, or null when it is not there. */
function alertOf(fixture: ComponentFixture<LayoutNotices>): HTMLElement | null {
  return (fixture.nativeElement as HTMLElement).querySelector('[role="alert"]');
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
    const { store, timer } = start(backend, new ManualTimer(), noticeProviders);
    await store.open(cidOf('c1'));
    expect(store.saveState()).toBe('ready');
    const notices = TestBed.createComponent(LayoutNotices);
    await settle(notices);
    expect(alertOf(notices)).toBeNull();

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

    // The shell shows it: an alert, in words the person can see, with the engine's own text.
    await settle(notices);
    const first = alertOf(notices);
    expect(first).not.toBeNull();
    expect(isVisible(first)).toBe(true);
    expect(first?.textContent).toContain('[[shell.saveFailed.title]]');
    expect(first?.textContent).not.toContain('[[shell.saveFailed.loadTitle]]');
    for (const shown of [
      'Blocked by the guardrail',
      'Writes are locked on this connection.',
      'prod-lock',
      'guardrail',
    ]) {
      const part = [...(first?.querySelectorAll('span') ?? [])].find(
        (span) => span.textContent.trim() === shown,
      );
      expect(part, shown).toBeDefined();
      expect(isVisible(part ?? null), shown).toBe(true);
    }
    const retryButton = first?.querySelector('button');
    expect(retryButton?.textContent).toContain('[[shell.saveFailed.retry]]');
    expect(isVisible(retryButton ?? null)).toBe(true);
    expect(retryButton?.disabled).toBe(false);

    // A change after the failure arms the timer again; the next save carries the latest layout.
    store.update((layout) => setSidebarWidth(layout, 230));
    expect(store.saveState()).toBe('save-failed');
    timer.fire();
    await store.flush();
    expect(backend.puts).toHaveLength(2);
    expect(backend.puts[1]?.layout).toMatchObject({ sidebar: { width: 230 } });
    expect(store.saveProblem()?.code).toBe('ENGINE_SHUTTING_DOWN');
    expect(store.saveState()).toBe('save-failed');
    await settle(notices);
    expect(alertOf(notices)?.textContent).toContain('Going away');
    expect(alertOf(notices)?.textContent).not.toContain(
      'Blocked by the guardrail',
    );

    // The Retry button sends the latest document at once (it is `retrySave`); a 200 clears the
    // failure, and with it the alert.
    alertOf(notices)?.querySelector('button')?.click();
    await store.flush();
    await settle(notices);
    expect(backend.puts).toHaveLength(3);
    expect(backend.puts[2]?.layout).toMatchObject({ sidebar: { width: 230 } });
    expect(store.saveState()).toBe('ready');
    expect(store.saveProblem()).toBeNull();
    expect(alertOf(notices)).toBeNull();
    expect(backend.docs.get('c1')).toMatchObject({ sidebar: { width: 230 } });
    expect(timer.pending).toBe(0);
  });

  it('keeps the save-failure alert, and a visible Retry button, while a retry is in flight (review N2)', async () => {
    const backend = new HeldBackend();
    const { store, timer } = start(backend, new ManualTimer(), noticeProviders);
    await store.open(cidOf('c1'));
    const notices = TestBed.createComponent(LayoutNotices);
    backend.putAnswers.push(
      problemResponse(problem(503, 'ENGINE_SHUTTING_DOWN', { title: 'Away' })),
    );
    store.update((layout) => setSidebarWidth(layout, 240));
    timer.fire();
    await store.flush();
    await settle(notices);
    expect(store.saveState()).toBe('save-failed');
    expect(alertOf(notices)?.textContent).toContain(
      '[[shell.saveFailed.title]]',
    );

    // The retry is sent and not answered yet: the state is `saving`, the failure is still the
    // story, and the button is still there (it cannot be pressed twice).
    let release: () => void = () => undefined;
    backend.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    alertOf(notices)?.querySelector('button')?.click();
    await settle(notices);
    expect(store.saveState()).toBe('saving');
    const during = alertOf(notices);
    expect(during).not.toBeNull();
    expect(during?.textContent).toContain('[[shell.saveFailed.title]]');
    expect(during?.textContent).not.toContain('[[shell.saveFailed.loadTitle]]');
    expect(during?.textContent).toContain('Away');
    const button = during?.querySelector('button');
    expect(button?.textContent).toContain('[[shell.saveFailed.retry]]');
    expect(isVisible(button ?? null)).toBe(true);
    expect(button?.disabled).toBe(true);

    release();
    await store.flush();
    await settle(notices);
    expect(store.saveState()).toBe('ready');
    expect(alertOf(notices)).toBeNull();
  });

  it('says the stored layout could not be loaded, without a Retry button, when the read failed (review N2)', async () => {
    const backend = new LayoutBackend();
    backend.getAnswer = problemResponse(
      problem(503, 'ENGINE_SHUTTING_DOWN', { title: 'Away' }),
    );
    const { store } = start(backend, new ManualTimer(), noticeProviders);
    await store.open(cidOf('c1'));
    const notices = TestBed.createComponent(LayoutNotices);
    await settle(notices);
    const shown = alertOf(notices);
    expect(shown?.textContent).toContain('[[shell.saveFailed.loadTitle]]');
    expect(shown?.textContent).not.toContain('[[shell.saveFailed.title]]');
    expect(shown?.querySelector('button')).toBeNull();
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
