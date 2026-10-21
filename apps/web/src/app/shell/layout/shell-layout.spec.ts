import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { LAYOUT_MAX_CHARS } from '@app/contracts';
import { describe, expect, it } from 'vitest';

import {
  SCOPE_LOADERS,
  provideI18n,
  provideScopes,
} from '../../i18n/i18n.config';
import { markerLoaders, settle } from '../../i18n/test-fixtures';
import { LayoutNotices } from '../notices/layout-notices';
import { mountShell, routed, visit } from '../test-fixtures';
import {
  openTab,
  splitEditor,
  tabCount,
  type LayoutResult,
} from './layout-ops';
import {
  LayoutBackend,
  cidOf,
  layoutProviders,
  ManualTimer,
} from './layout-fixtures';
import {
  SHELL_LAYOUT_LIMITS,
  ShellLayoutSchema,
  defaultLayout,
  isSafeTabUrl,
  parseLayout,
  type ShellLayout,
  type TabRef,
} from './shell-layout';
import { ShellLayoutStore } from './shell-layout-store';

const tab = (id: string, url: string): TabRef => ({
  id,
  url,
  label: `Tab ${id}`,
});

function withTabs(tabs: readonly TabRef[], extra?: Partial<ShellLayout>) {
  const layout = defaultLayout();
  return {
    ...layout,
    ...extra,
    editor: {
      ...layout.editor,
      groups: [{ weight: 1, tabs, activeTab: tabs[0]?.id ?? null }],
    },
  };
}

const UNSAFE_URLS = [
  'https://x.example/',
  '//x.example',
  'javascript:alert(1)',
  '/c/other/queues',
  '/c/c1',
  '/c/c1/queues\u0001x',
  '/c/c1/../c2/queues',
  '/c/c1/%2e%2e/c2/queues',
  '/c/c1\\evil',
  '/c/c1/' + 'x'.repeat(SHELL_LAYOUT_LIMITS.urlChars),
];

describe('shell layout document', () => {
  it('AC-6 an unusable stored layout falls back to the default with a visible notice and unsafe tab URLs are dropped', async () => {
    const fallback = defaultLayout();
    const over = (groups: number, perGroup: number) => ({
      ...fallback,
      editor: {
        ...fallback.editor,
        groups: Array.from({ length: groups }, (_, g) => ({
          weight: 1,
          tabs: Array.from({ length: perGroup }, (_, t) =>
            tab(`g${String(g)}t${String(t)}`, `/c/c1/x${String(t)}`),
          ),
          activeTab: null,
        })),
      },
    });

    // Documents that cannot be used at all: the default, the matching notice, no throw.
    const unusable: readonly [unknown, string][] = [
      [null, 'absent'],
      [undefined, 'absent'],
      ['text', 'invalid'],
      [[], 'invalid'],
      [{}, 'invalid'],
      [{ version: 1 }, 'invalid'],
      [{ ...fallback, version: 0 }, 'invalid'],
      [{ ...fallback, surprise: true }, 'invalid'],
      [{ ...fallback, sidebar: { ...fallback.sidebar, width: -5 } }, 'invalid'],
      [{ ...fallback, version: 2 }, 'newer-version'],
      [over(4, 1), 'over-limit'],
      [over(1, SHELL_LAYOUT_LIMITS.tabsPerGroup + 1), 'over-limit'],
      [over(3, 21), 'over-limit'],
    ];
    for (const [stored, notice] of unusable) {
      const parsed = parseLayout(stored, 'c1');
      expect(parsed.notice, JSON.stringify(stored)).toBe(notice);
      expect(parsed.layout).toEqual(fallback);
    }

    // A usable document comes back as it is, without a notice.
    const good = withTabs([tab('t1', '/c/c1/explorer?x=1#top')], {
      sidebar: { visible: false, width: 300, active: 'explorer' },
    });
    expect(parseLayout(good, 'c1')).toEqual({ layout: good, notice: null });

    // Unsafe addresses are dropped one by one; the rest of the document survives.
    for (const url of UNSAFE_URLS) {
      expect(isSafeTabUrl(url, 'c1'), url).toBe(false);
      const stored = withTabs([tab('bad', url), tab('t1', '/c/c1/explorer')]);
      const parsed = parseLayout(stored, 'c1');
      expect(parsed.notice, url).toBe('tabs-dropped');
      expect(parsed.layout.editor.groups[0]?.tabs.map((t) => t.url)).toEqual([
        '/c/c1/explorer',
      ]);
      expect(parsed.layout.editor.groups[0]?.activeTab).toBe('t1');
      expect(ShellLayoutSchema.safeParse(parsed.layout).success).toBe(true);
    }
    // A tab with neither title nor label, a repeated id and a control character in the label.
    const odd = parseLayout(
      withTabs([
        { id: 'a', url: '/c/c1/a' },
        tab('b', '/c/c1/b'),
        tab('b', '/c/c1/c'),
        { id: 'd', url: '/c/c1/d', label: 'bad\u0007label' },
      ]),
      'c1',
    );
    expect(odd.layout.editor.groups[0]?.tabs.map((t) => t.id)).toEqual(['b']);
    expect(odd.notice).toBe('tabs-dropped');

    // The shell shows the notice and does not go to the dropped address.
    const backend = new LayoutBackend();
    backend.docs.set('c1', withTabs([tab('bad', 'https://x.example/')]));
    const bed = await mountShell(markerLoaders(), backend);
    await visit(bed, '/c/c1/explorer');
    expect(routed(bed).querySelector('[role="status"]')?.textContent).toContain(
      '[[shell.notice.tabsDropped]]',
    );
    expect(
      TestBed.inject(ShellLayoutStore).layout().editor.groups[0]?.tabs,
    ).toEqual([]);
    expect(TestBed.inject(Router).url).toBe('/c/c1/explorer');
  });

  it('AC-8 every collection in the layout is bounded and a refusal is visible', async () => {
    const limits = SHELL_LAYOUT_LIMITS;
    const ok = (result: LayoutResult): ShellLayout => {
      if (!result.ok) throw new Error(`refused: ${result.refusal}`);
      return result.layout;
    };
    const refusal = (result: LayoutResult): string =>
      result.ok ? 'accepted' : result.refusal;

    // Tabs per group: the next one is refused, nothing is evicted.
    let layout = defaultLayout();
    for (let i = 0; i < limits.tabsPerGroup; i += 1) {
      layout = ok(
        openTab(layout, 'c1', { url: `/c/c1/q${String(i)}`, label: 'q' }),
      );
    }
    const full = layout;
    const extra = { url: '/c/c1/one-more', label: 'more' };
    expect(refusal(openTab(layout, 'c1', extra))).toBe('tabs-per-group');
    // An address a group already has is activated, not duplicated.
    expect(
      ok(openTab(layout, 'c1', { url: '/c/c1/q3', label: 'q' })).editor
        .groups[0]?.activeTab,
    ).toBe('t4');

    // Groups, then tabs in total.
    layout = ok(splitEditor(layout));
    layout = ok(splitEditor(layout));
    expect(layout.editor.groups).toHaveLength(limits.groups);
    expect(refusal(splitEditor(layout))).toBe('groups');
    for (let i = 0; i < limits.tabsPerGroup; i += 1) {
      layout = ok(
        openTab(layout, 'c1', { url: `/c/c1/r${String(i)}`, label: 'r' }, 1),
      );
    }
    expect(tabCount(layout)).toBe(limits.tabsTotal);
    expect(refusal(openTab(layout, 'c1', extra, 2))).toBe('tabs-total');
    expect(tabCount(layout)).toBeLessThanOrEqual(limits.tabsTotal);

    // Over-long text and addresses that do not belong to the connection.
    const fresh = defaultLayout();
    expect(
      refusal(
        openTab(fresh, 'c1', {
          url: `/c/c1/${'x'.repeat(limits.urlChars)}`,
          label: 'x',
        }),
      ),
    ).toBe('url-too-long');
    expect(
      refusal(
        openTab(fresh, 'c1', {
          url: '/c/c1/x',
          label: 'x'.repeat(limits.labelChars + 1),
        }),
      ),
    ).toBe('label-too-long');
    expect(refusal(openTab(fresh, 'c1', { url: '/c/c2/x', label: 'x' }))).toBe(
      'unsafe-url',
    );
    expect(refusal(openTab(fresh, 'c1', { url: '/c/c1/x' }))).toBe(
      'unsafe-url',
    );

    // The store counts and shows a refusal, and never sends a document above the contract limit.
    const backend = new LayoutBackend();
    const timer = new ManualTimer();
    TestBed.configureTestingModule({
      providers: [
        ...layoutProviders(backend, timer),
        provideI18n(),
        provideScopes('shell'),
        { provide: SCOPE_LOADERS, useValue: markerLoaders() },
      ],
    });
    const store = TestBed.inject(ShellLayoutStore);
    await store.open(cidOf('c1'));
    store.update(() => full);
    expect(store.refusals()).toBe(0);
    expect(store.apply((l) => openTab(l, 'c1', extra))).toBe('tabs-per-group');
    expect(store.refusals()).toBe(1);
    expect(store.refusal()).toBe('tabs-per-group');
    expect(store.layout()).toBe(full);

    const fixture = TestBed.createComponent(LayoutNotices);
    await settle(fixture);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      '[[shell.refusal.tabsPerGroup]]',
    );

    const huge: ShellLayout = withTabs([
      { id: 'big', url: '/c/c1/x', label: 'y'.repeat(LAYOUT_MAX_CHARS) },
    ]);
    store.update(() => huge);
    expect(store.refusal()).toBe('document-too-large');
    expect(store.refusals()).toBe(2);
    expect(store.layout()).toBe(full);
    timer.fire();
    await store.flush();
    for (const put of backend.puts) {
      expect(JSON.stringify(put.layout).length).toBeLessThanOrEqual(
        LAYOUT_MAX_CHARS,
      );
    }
    expect(backend.puts).toHaveLength(1);
  });

  it('keeps ids unique and never hands out an id a tab already has', () => {
    let layout = defaultLayout();
    const ids = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      const result = openTab(layout, 'c1', {
        url: `/c/c1/${String(i)}`,
        label: 'x',
      });
      if (!result.ok) throw new Error('refused');
      layout = result.layout;
    }
    for (const t of layout.editor.groups[0]?.tabs ?? []) ids.add(t.id);
    expect(ids.size).toBe(10);
  });
});
