import { signal, type Signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { BootstrapErrorCode } from '@app/ui-platform';
import { problemResponse } from '@app/ui-platform/testing';
import { describe, expect, it, vi } from 'vitest';

import { BOOT_FAILURE, BootFailed } from '../boot/boot-failed';
import { PAGE_RELOAD } from '../boot/page-reload';
import {
  EXPLORER_TREE_SOURCE,
  type ExplorerNode,
} from '../shell/explorer-tree/explorer-tree-source';
import {
  LayoutBackend,
  problem,
  twoGroupLayout,
} from '../shell/layout/layout-fixtures';
import {
  setPanelVisible,
  setSidebarVisible,
  setSidebarWidth,
  type LayoutRefusal,
} from '../shell/layout/layout-ops';
import { ShellLayoutStore } from '../shell/layout/shell-layout-store';
import { ChunkFailure } from '../shell/skew/chunk-failure';
import { ChunkReload } from '../shell/skew/chunk-reload';
import {
  FakeLive,
  StatusBackend,
  brokerProfileBody,
  connectionBody,
} from '../shell/status-bar/status-fixtures';
import { LOCK_STATE, type LockState } from '../shell/status-bar/status-source';
import {
  mountShell,
  routed,
  settleShell,
  visit,
  type ShellTestbed,
} from '../shell/test-fixtures';
import { SCOPE_LOADERS, provideI18n } from './i18n.config';
import {
  englishKeys,
  markerLoaders,
  settle,
  visibleStrings,
} from './test-fixtures';

const MARKER = /^\[\[([A-Za-z0-9.-]+)\]\]$/;

/** Engine data the fixtures supply: a connection id, a Problem's title, reason and source. */
const ENGINE_DATA: readonly string[] = [
  'c1',
  'c2',
  'c3',
  'c4',
  'c5',
  'c6',
  'c7',
  'Staging cluster',
  'Test cluster',
  'Dev cluster',
  'Local cluster',
  '4.3.6',
  '4.3.7',
  '4.4.0',
  '4.3',
  '4.0-4.2',
  '4.4',
  'One',
  'Two',
  'Three',
  'Four',
  'n',
  'Blocked by the guardrail',
  'Writes are locked on this connection.',
  'prod-lock',
  'guardrail',
  'Not found', // the title of the 404 the fake engine answers for what it does not serve
];

const REFUSALS: readonly LayoutRefusal[] = [
  'groups',
  'tabs-per-group',
  'tabs-total',
  'url-too-long',
  'label-too-long',
  'unsafe-url',
  'document-too-large',
];

describe('shell i18n', () => {
  it('AC-2 every visible string is a Transloco key or engine data', async () => {
    const known = new Set(englishKeys());
    const seen = new Set<string>();
    const strangers: string[] = [];
    const take = (strings: readonly string[]): void => {
      for (const text of strings) {
        const key = MARKER.exec(text)?.[1];
        if (key !== undefined && known.has(key)) seen.add(key);
        // The explorer's words are its own feature's (proved by its i18n spec): here only that it asked for a key.
        else if (key?.startsWith('explorer.') === true) continue;
        else if (!ENGINE_DATA.includes(text)) strangers.push(text);
      }
    };
    const takeShell = (bed: ShellTestbed): void => {
      take(visibleStrings(routed(bed)));
    };

    // The shell in each state it can be in, with every text replaced by its key.
    const backend = new StatusBackend();
    // What the status bar shows for each connection: every class, stats mode and verification.
    const envs = ['staging', 'test', 'dev', 'local'] as const;
    const verifications = [
      'verified',
      'unverified-patch',
      'unverified-minor',
    ] as const;
    const statsModes = [
      { disabled: true, queueTotals: true },
      { disabled: false, queueTotals: true },
      { disabled: true, queueTotals: false },
    ];
    envs.forEach((env, i) => {
      const cid = `c${String(i + 1)}`;
      const names = [
        'Staging cluster',
        'Test cluster',
        'Dev cluster',
        'Local cluster',
      ];
      backend.connections.set(cid, connectionBody(cid, names[i] ?? cid, env));
      backend.profiles.set(
        cid,
        brokerProfileBody(cid, {
          version: ['4.3.6', '4.3.7', '4.4.0', '4.3.6'][i] ?? '4.3.6',
          era: i === 2 ? '4.4' : i === 1 ? '4.0-4.2' : '4.3',
          conservative: i === 1,
          verification: verifications[i % 3] ?? 'verified',
          stats: statsModes[i % 3] ?? { disabled: false, queueTotals: true },
        }),
      );
    });
    backend.docs.set('c1', { version: 1 }); // not a layout: the "invalid" notice
    backend.docs.set('c3', { version: 2 });
    backend.docs.set('c4', {
      version: 1,
      sidebar: { visible: true, width: 260, active: 'explorer' },
      editor: {
        orientation: 'row',
        groups: [
          {
            weight: 1,
            tabs: [{ id: 'x', url: 'https://x.example/', label: 'x' }],
            activeTab: 'x',
          },
        ],
        activeGroup: 0,
      },
      panel: { visible: false, height: 200, active: 'jobs' },
    });
    backend.docs.set('c5', {
      version: 1,
      sidebar: { visible: true, width: 260, active: 'explorer' },
      editor: {
        orientation: 'row',
        groups: [1, 2, 3, 4].map(() => ({
          weight: 1,
          tabs: [],
          activeTab: null,
        })),
        activeGroup: 0,
      },
      panel: { visible: false, height: 200, active: 'jobs' },
    });
    // Three editor groups: the active one, one with a tab and one without.
    const crowded = twoGroupLayout('c6');
    backend.docs.set('c6', {
      ...crowded,
      editor: {
        ...crowded.editor,
        groups: [
          ...crowded.editor.groups,
          { weight: 100, tabs: [], activeTab: null },
        ],
      },
    });
    const live = new FakeLive();
    const lock = signal<LockState>('locked');
    const bed = await mountShell(markerLoaders(), backend, undefined, [
      live.provider,
      { provide: LOCK_STATE, useValue: lock as Signal<LockState> },
    ]);
    for (const url of [
      '/c/c1/explorer', // invalid
      '/c/c2/explorer', // absent
      '/c/c3/explorer', // newer-version
      '/c/c4/explorer', // tabs-dropped
      '/c/c5/explorer', // over-limit
      '/c/c6/explorer', // tabs and groups
      '/c/c1/nope',
      '/c/not%20an%20id/explorer',
      '/',
    ]) {
      await visit(bed, url);
      takeShell(bed);
    }

    // The status bar while the profile is on its way, and for each lock and health state.
    backend.hold();
    await bed.harness.navigateByUrl('/c/c7/explorer');
    for (let round = 0; round < 5; round += 1) {
      bed.harness.detectChanges();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    takeShell(bed);
    backend.release();
    await settleShell(bed);
    for (const state of ['armed', 'unknown', 'locked'] as const) {
      lock.set(state);
      await settleShell(bed);
      takeShell(bed);
    }
    for (const state of ['ready', 'reconnecting', 'down', 'idle'] as const) {
      live.state.set(state);
      await settleShell(bed);
      takeShell(bed);
    }
    // The engine is newer than this page.
    live.engineVersion.set('1.0.0');
    await settleShell(bed);
    live.engineVersion.set('1.1.0');
    await settleShell(bed);
    takeShell(bed);

    // The panel, the refusals and a failed save, with the engine's own words.
    await visit(bed, '/c/c1/explorer');
    const store = TestBed.inject(ShellLayoutStore);
    store.update((layout) => setPanelVisible(layout, true));
    for (const refusal of REFUSALS) {
      store.apply(() => ({ ok: false, refusal }));
      await settleShell(bed);
      takeShell(bed);
    }
    backend.putAnswers.push(
      problemResponse(
        problem(422, 'GATE_BLOCKED', {
          title: 'Blocked by the guardrail',
          detail: 'Writes are locked on this connection.',
          gate: { enabled: false, reason: 'prod-lock', source: 'guardrail' },
        }),
      ),
      { status: 503, headers: {} },
    );
    store.update((layout) => setSidebarWidth(layout, 300));
    bed.timer.fire();
    await store.flush();
    await settleShell(bed);
    takeShell(bed);
    await store.retrySave(); // the second answer: no Problem, the UI says the engine did not answer
    await settleShell(bed);
    takeShell(bed);
    store.update((layout) => setSidebarVisible(layout, false));
    await settleShell(bed);
    takeShell(bed);

    // A tree with more nodes than it draws.
    TestBed.resetTestingModule();
    const nodes: readonly ExplorerNode[] = Array.from(
      { length: 600 },
      (_, i) => ({
        id: `n${String(i)}`,
        label: 'n',
        url: null,
        children: 'none',
      }),
    );
    const bedBig = await mountShell(
      markerLoaders(),
      new LayoutBackend(),
      undefined,
      [
        {
          provide: EXPLORER_TREE_SOURCE,
          useValue: {
            roots: () => signal(nodes).asReadonly(),
            children: () => signal<readonly ExplorerNode[]>([]).asReadonly(),
          },
        },
      ],
    );
    await visit(bedBig, '/c/c1/explorer');
    takeShell(bedBig);

    // A part of the app that could not be loaded, twice.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideI18n(),
        { provide: SCOPE_LOADERS, useValue: markerLoaders() },
        { provide: ChunkReload, useValue: { failure: signal('/lazy') } },
        { provide: PAGE_RELOAD, useValue: vi.fn() },
      ],
    });
    const failure = TestBed.createComponent(ChunkFailure);
    await settle(failure);
    take(visibleStrings(failure.nativeElement as HTMLElement));

    // A layout that cannot be loaded.
    const failing = new LayoutBackend();
    failing.getAnswer = problemResponse(
      problem(500, 'INTERNAL', { title: 'Blocked by the guardrail' }),
    );
    TestBed.resetTestingModule();
    const bedFailing = await mountShell(markerLoaders(), failing);
    await visit(bedFailing, '/c/c1/explorer');
    takeShell(bedFailing);

    // The cannot-start view for each cause it can name.
    const causes: readonly (BootstrapErrorCode | 'unknown')[] = [
      'bridge-invalid',
      'bridge-version',
      'port-timeout',
      'bootstrap-unavailable',
      'bootstrap-invalid',
      'unknown',
    ];
    for (const cause of causes) {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          provideI18n(),
          { provide: SCOPE_LOADERS, useValue: markerLoaders() },
          { provide: BOOT_FAILURE, useValue: cause },
          { provide: PAGE_RELOAD, useValue: vi.fn() },
        ],
      });
      const fixture = TestBed.createComponent(BootFailed);
      await settle(fixture);
      // The page title is a visible string too.
      take([
        ...visibleStrings(fixture.nativeElement as HTMLElement),
        document.title,
      ]);
    }

    // Nothing visible is raw text, and no key of the files is left without a use.
    expect(strangers).toEqual([]);
    expect(englishKeys().filter((key) => !seen.has(key))).toEqual([]);
  });
});
