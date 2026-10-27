import { afterEach, describe, expect, it, vi } from 'vitest';

import { DraftStore } from './draft-store';
import { newRow } from './header-model';
import { DRAFT_STORE_MAX } from './limits';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DraftStore', () => {
  it('M1-46 AC-24 keeps the draft in memory only', () => {
    const canary = 'canary-5f3a9c1e';
    const writes: unknown[][] = [];
    const record = (...args: unknown[]): void => void writes.push(args);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(record);
    const indexedDbOpen = vi.fn();
    vi.stubGlobal('indexedDB', { open: indexedDbOpen });
    const href = window.location.href;

    const store = new DraftStore();
    store.draft('c1').update((draft) => ({
      ...draft,
      props: { messageId: canary },
      headers: [newRow('x-secret', 'string', canary)],
      body: { ...draft.body, data: canary },
    }));

    // "Destroyed and recreated": the page asks again and finds the same draft.
    const again = store.draft('c1')();
    expect(again.props.messageId).toBe(canary);
    expect(again.headers[0]?.text).toBe(canary);
    expect(again.body.data).toBe(canary);

    expect(writes).toEqual([]);
    expect(indexedDbOpen).not.toHaveBeenCalled();
    for (const storage of [localStorage, sessionStorage]) {
      expect(storage.length).toBe(0);
    }
    expect(window.location.href).toBe(href);
    expect(document.title).not.toContain(canary);
    vi.unstubAllGlobals();

    // A reload is a fresh store: the draft is empty, and one connection never sees another's.
    const reloaded = new DraftStore();
    expect(reloaded.draft('c1')().body.data).toBe('');
    expect(reloaded.draft('c1')().headers).toEqual([]);
    expect(store.draft('c2')().body.data).toBe('');
  });

  it('keeps one draft per connection and drops the least recently used past the bound', () => {
    const store = new DraftStore();
    const mark = (cid: string): void => {
      store.draft(cid).update((draft) => ({ ...draft, exchange: cid }));
    };
    for (let i = 0; i < DRAFT_STORE_MAX; i++) mark(`c${String(i)}`);
    // Touch the oldest: it is now the newest, and c1 is the oldest.
    expect(store.draft('c0')().exchange).toBe('c0');
    mark('extra');
    expect(store.draft('c0')().exchange).toBe('c0');
    expect(store.draft('extra')().exchange).toBe('extra');
    expect(store.draft('c3')().exchange).toBe('c3'); // only one went
    expect(store.draft('c1')().exchange).toBe(''); // dropped, so empty again
  });
});
