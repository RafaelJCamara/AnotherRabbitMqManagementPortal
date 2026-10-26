import { Component } from '@angular/core';
import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';

import { App } from '../../app';
import { PAGE_RELOAD } from '../../boot/page-reload';
import { SCOPE_LOADERS, provideI18n } from '../../i18n/i18n.config';
import { markerLoaders, settle } from '../../i18n/test-fixtures';
import {
  LayoutBackend,
  cidOf,
  layoutProviders,
} from '../layout/layout-fixtures';
import { setSidebarWidth } from '../layout/layout-ops';
import { ShellLayoutStore } from '../layout/shell-layout-store';
import {
  CHUNK_CLOCK,
  CHUNK_RELOAD_STATE,
  CHUNK_RELOAD_WINDOW_MS,
  PAGE_ASSIGN,
  isChunkLoadFailure,
  provideChunkReload,
} from './chunk-reload';

@Component({ selector: 'app-page', template: '' })
class Page {
  readonly routed = true;
}

class FakeStorage implements Storage {
  readonly data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

const gone = (): Promise<never> =>
  Promise.reject(
    new TypeError('Failed to fetch dynamically imported module: /chunk-ABC.js'),
  );

async function setup(storage: Storage | null = new FakeStorage()) {
  let now = 1_000_000;
  const backend = new LayoutBackend();
  const assign = vi.fn<(url: string) => void>();
  const reload = vi.fn<() => void>();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'ok', component: Page },
        { path: 'lazy', loadComponent: gone },
        {
          path: 'broken',
          loadComponent: () => Promise.reject(new Error('the route is broken')),
        },
      ]),
      provideChunkReload(),
      provideI18n(),
      ...layoutProviders(backend),
      { provide: SCOPE_LOADERS, useValue: markerLoaders() },
      { provide: CHUNK_RELOAD_STATE, useValue: storage },
      { provide: CHUNK_CLOCK, useValue: () => now },
      { provide: PAGE_ASSIGN, useValue: assign },
      { provide: PAGE_RELOAD, useValue: reload },
    ],
  });
  const fixture = TestBed.createComponent(App);
  await settle(fixture);
  const router = TestBed.inject(Router);
  const go = async (url: string): Promise<void> => {
    await router.navigateByUrl(url).catch(() => false);
    await TestBed.inject(ApplicationRef).whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settle(fixture);
  };
  const failure = () =>
    (fixture.nativeElement as HTMLElement).querySelector(
      'app-chunk-failure [role="alert"]',
    );
  return {
    assign,
    backend,
    reload,
    storage,
    go,
    failure,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('chunk reload', () => {
  it('AC-13 a failed lazy chunk causes one controlled reload that keeps the route and never loops', async () => {
    const t = await setup();

    // The first failure reloads once, at the address that was being opened (route and query kept).
    await t.go('/lazy?tab=2#top');
    expect(t.assign).toHaveBeenCalledTimes(1);
    expect(t.assign).toHaveBeenCalledWith('/lazy?tab=2#top');
    expect(t.failure()).toBeNull();

    // The page came back, the chunk is still not there: no second reload, an error view instead,
    // with a manual reload.
    t.advance(5_000);
    await t.go('/lazy?tab=2#top');
    expect(t.assign).toHaveBeenCalledTimes(1);
    const view = t.failure();
    expect(view?.textContent).toContain('[[system.chunk.title]]');
    expect(view?.textContent).toContain('[[system.chunk.hint]]');
    expect(view?.textContent).not.toContain('chunk-ABC');
    view?.querySelector('button')?.click();
    expect(t.reload).toHaveBeenCalledTimes(1);

    // An unrelated navigation error never reloads and shows no chunk view.
    await t.go('/broken');
    expect(t.assign).toHaveBeenCalledTimes(1);

    // A successful navigation clears the state and the view.
    await t.go('/ok');
    expect(t.failure()).toBeNull();
    expect((t.storage as FakeStorage).data.size).toBe(0);

    // After a success, a new failure may reload once again.
    t.advance(1_000);
    await t.go('/lazy');
    expect(t.assign).toHaveBeenCalledTimes(2);
    expect(t.assign).toHaveBeenLastCalledWith('/lazy');

    // Inside the window it does not; after the window it does.
    t.advance(CHUNK_RELOAD_WINDOW_MS - 1);
    await t.go('/lazy');
    expect(t.assign).toHaveBeenCalledTimes(2);
    expect(t.failure()).not.toBeNull();
    t.advance(2);
    await t.go('/lazy');
    expect(t.assign).toHaveBeenCalledTimes(3);

    // An unrelated navigation error never reloads. Proved from a fresh start, with no reload
    // behind it: inside the window after a reload the window alone would stop it.
    TestBed.resetTestingModule();
    const fresh = await setup();
    await fresh.go('/broken');
    expect(fresh.assign).not.toHaveBeenCalled();
    expect(fresh.failure()).toBeNull();
    expect((fresh.storage as FakeStorage).data.size).toBe(0);

    // No layout loss: a change still waiting for its idle delay is sent before the page is
    // opened again, and the reload goes to the same address.
    TestBed.resetTestingModule();
    const dirty = await setup();
    const store = TestBed.inject(ShellLayoutStore);
    await store.open(cidOf('c1'));
    store.update((layout) => setSidebarWidth(layout, 250));
    expect(dirty.backend.puts).toEqual([]);
    const sentBeforeReload: number[] = [];
    dirty.assign.mockImplementation(() => {
      sentBeforeReload.push(dirty.backend.puts.length);
    });
    await dirty.go('/lazy?tab=2');
    await vi.waitFor(() => {
      expect(dirty.assign).toHaveBeenCalledTimes(1);
    });
    expect(sentBeforeReload).toEqual([1]);
    expect(dirty.backend.puts[0]?.layout).toMatchObject({
      sidebar: { width: 250 },
    });
    expect(dirty.assign).toHaveBeenCalledWith('/lazy?tab=2');
  });

  it('never reloads when the reload cannot be remembered (it could loop)', async () => {
    const blocked = await setup(null);
    await blocked.go('/lazy');
    expect(blocked.assign).not.toHaveBeenCalled();
    expect(blocked.failure()).not.toBeNull();

    TestBed.resetTestingModule();
    const full = new FakeStorage();
    full.setItem = () => {
      throw new Error('quota');
    };
    const quota = await setup(full);
    await quota.go('/lazy');
    expect(quota.assign).not.toHaveBeenCalled();
    expect(quota.failure()).not.toBeNull();
  });

  it('recognises the shapes of a failed dynamic import', () => {
    const named = new Error('x');
    named.name = 'ChunkLoadError';
    expect(isChunkLoadFailure(named)).toBe(true);
    for (const message of [
      'Failed to fetch dynamically imported module: https://h/chunk-1.js',
      'error loading dynamically imported module: https://h/chunk-1.js',
      'Importing a module script failed.',
      'Loading chunk 12 failed.',
      'Unable to preload CSS for /styles.css',
    ]) {
      expect(isChunkLoadFailure(new TypeError(message)), message).toBe(true);
    }
    expect(isChunkLoadFailure(new Error('wrapped', { cause: named }))).toBe(
      true,
    );
    for (const other of [
      new Error('NG04002: Cannot match any routes'),
      new TypeError('x is not a function'),
      'Failed to fetch dynamically imported module',
      undefined,
      null,
      { message: 'Failed to fetch dynamically imported module' },
    ]) {
      expect(isChunkLoadFailure(other)).toBe(false);
    }
    // A cause cycle terminates.
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    a.cause = b;
    expect(isChunkLoadFailure(a)).toBe(false);
  });
});
