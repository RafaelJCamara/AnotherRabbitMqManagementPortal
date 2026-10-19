import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MATCH_MEDIA,
  THEME_STORAGE,
  THEME_STORAGE_KEYS,
  ThemeService,
  type MatchMedia,
  type ThemeStorage,
} from './theme.service';

const FORCED = '(forced-colors: active)';
const CONTRAST = '(prefers-contrast: more)';
const DARK = '(prefers-color-scheme: dark)';

function fakeMedia(initial: Record<string, boolean> = {}) {
  const state = { ...initial };
  const listeners = new Map<string, Set<() => void>>();
  const matchMedia: MatchMedia = (query) => ({
    get matches() {
      return state[query] ?? false;
    },
    addEventListener: (_type, listener) => {
      const set = listeners.get(query) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(query, set);
    },
    removeEventListener: (_type, listener) => {
      listeners.get(query)?.delete(listener);
    },
  });
  return {
    matchMedia,
    set(query: string, value: boolean) {
      state[query] = value;
      for (const listener of listeners.get(query) ?? []) listener();
    },
    listenerCount: () =>
      [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const writes: [string, string][] = [];
  const storage: ThemeStorage = {
    read: (key) => data.get(key) ?? null,
    write: (key, value) => {
      writes.push([key, value]);
      data.set(key, value);
    },
  };
  return { storage, data, writes };
}

function create(
  options: {
    media?: ReturnType<typeof fakeMedia>;
    storage?: ReturnType<typeof fakeStorage>;
  } = {},
) {
  const media = options.media ?? fakeMedia();
  const store = options.storage ?? fakeStorage();
  TestBed.configureTestingModule({
    providers: [
      { provide: MATCH_MEDIA, useValue: media.matchMedia },
      { provide: THEME_STORAGE, useValue: store.storage },
    ],
  });
  return { service: TestBed.inject(ThemeService), media, store };
}

const root = (): HTMLElement => document.documentElement;
const attrs = () => ({
  theme: root().getAttribute('data-theme'),
  density: root().getAttribute('data-density'),
});

beforeEach(() => {
  root().removeAttribute('data-theme');
  root().removeAttribute('data-density');
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('ThemeService', () => {
  it('starts on the system theme and the comfortable density', () => {
    const { service } = create();
    expect(service.preference()).toBe('system');
    expect(service.resolved()).toBe('light');
    expect(service.density()).toBe('comfortable');
    expect(attrs()).toEqual({ theme: 'light', density: 'comfortable' });
  });

  it('restores the stored choice, and ignores a stored value it does not know', () => {
    const stored = create({
      storage: fakeStorage({
        [THEME_STORAGE_KEYS.theme]: 'dark',
        [THEME_STORAGE_KEYS.density]: 'compact',
      }),
    });
    expect(stored.service.preference()).toBe('dark');
    expect(attrs()).toEqual({ theme: 'dark', density: 'compact' });

    TestBed.resetTestingModule();
    const garbage = create({
      storage: fakeStorage({
        [THEME_STORAGE_KEYS.theme]: 'neon',
        [THEME_STORAGE_KEYS.density]: '<script>',
      }),
    });
    expect(garbage.service.preference()).toBe('system');
    expect(garbage.service.density()).toBe('comfortable');
    expect(attrs()).toEqual({ theme: 'light', density: 'comfortable' });
  });

  it('follows the system: dark, then high contrast beats dark, forced colours too', () => {
    const media = fakeMedia({ [DARK]: true });
    const { service } = create({ media });
    expect(service.resolved()).toBe('dark');
    expect(attrs().theme).toBe('dark');

    media.set(CONTRAST, true);
    expect(service.resolved()).toBe('high-contrast');
    expect(attrs().theme).toBe('high-contrast');

    media.set(CONTRAST, false);
    media.set(FORCED, true);
    expect(attrs().theme).toBe('high-contrast');

    media.set(FORCED, false);
    media.set(DARK, false);
    expect(attrs().theme).toBe('light');
  });

  it('an explicit choice wins over the system, which keeps changing underneath it', () => {
    const media = fakeMedia({ [DARK]: true });
    const { service } = create({ media });
    service.setPreference('light');
    expect(attrs().theme).toBe('light');
    media.set(CONTRAST, true);
    expect(attrs().theme).toBe('light');
    service.setPreference('system');
    expect(attrs().theme).toBe('high-contrast');
  });

  it('setPreference and setDensity apply at once, persist, and bump the revision', () => {
    const { service, store } = create();
    const before = service.revision();
    service.setPreference('high-contrast');
    service.setDensity('compact');
    expect(attrs()).toEqual({ theme: 'high-contrast', density: 'compact' });
    expect(store.writes).toEqual([
      [THEME_STORAGE_KEYS.theme, 'high-contrast'],
      [THEME_STORAGE_KEYS.density, 'compact'],
    ]);
    expect(service.revision()).toBe(before + 2);
  });

  it('a system change bumps the revision too, so widgets re-read their tokens', () => {
    const media = fakeMedia();
    const { service } = create({ media });
    const before = service.revision();
    media.set(DARK, true);
    expect(service.revision()).toBe(before + 1);
  });

  it('refuses a value that is not a preference and changes nothing', () => {
    const { service, store } = create();
    service.setPreference('dark');
    const writes = store.writes.length;
    const revision = service.revision();
    expect(() => {
      service.setPreference('neon' as never);
    }).toThrow(RangeError);
    expect(() => {
      service.setDensity('huge' as never);
    }).toThrow(RangeError);
    expect(service.preference()).toBe('dark');
    expect(service.density()).toBe('comfortable');
    expect(attrs()).toEqual({ theme: 'dark', density: 'comfortable' });
    expect(store.writes).toHaveLength(writes);
    expect(service.revision()).toBe(revision);
  });

  it('works when storage is missing or throws', () => {
    const getItem = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('blocked');
      });
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('blocked');
      });
    // The real storage token, with a media fake only.
    TestBed.configureTestingModule({
      providers: [{ provide: MATCH_MEDIA, useValue: fakeMedia().matchMedia }],
    });
    const service = TestBed.inject(ThemeService);
    expect(getItem).toHaveBeenCalled();
    expect(() => {
      service.setPreference('dark');
    }).not.toThrow();
    expect(setItem).toHaveBeenCalled();
    expect(attrs().theme).toBe('dark');
  });

  it('copes with a window that has no matchMedia', () => {
    TestBed.configureTestingModule({});
    const service = TestBed.inject(ThemeService);
    expect(service.resolved()).toBe('light');
  });

  it('token() reads a design token from the page, and only design tokens', () => {
    const { service } = create();
    root().style.setProperty('--ds-color-text', '  #123456 ');
    expect(service.token('--ds-color-text')).toBe('#123456');
    root().style.removeProperty('--ds-color-text');
    expect(service.token('--ds-color-text')).toBe('');
    for (const bad of [
      'color',
      '--other-color',
      '--ds-',
      '--ds-x; background: red',
      '--DS-color-text',
      '',
    ]) {
      expect(() => service.token(bad), bad).toThrow(RangeError);
    }
  });

  it('stops listening to the system when it is destroyed', () => {
    const media = fakeMedia();
    create({ media });
    expect(media.listenerCount()).toBe(3);
    TestBed.resetTestingModule();
    expect(media.listenerCount()).toBe(0);
  });
});
