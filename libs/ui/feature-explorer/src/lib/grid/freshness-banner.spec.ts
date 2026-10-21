import type { ComponentFixture } from '@angular/core/testing';
import type {
  ExplorerKind,
  Freshness,
  WindowSourceState,
} from '@app/explorer-model';
import { EngineProblemError } from '@app/ui-data';
import { describe, expect, it, vi } from 'vitest';

import { mountPage } from '../testing/page-testbed';
import { FreshnessBanner } from './freshness-banner.component';

const FRESH: Freshness = {
  state: 'live',
  sweptAt: 1000,
  complete: true,
  loaded: 10,
  truncated: false,
  dropped: 0,
  hazards: [],
  versionChanged: false,
};

const STATE: WindowSourceState = {
  freshness: FRESH,
  matched: 10,
  pin: 7,
  versionChanged: false,
  live: 'off',
  liveProblem: null,
  liveStatus: null,
  followed: 0,
  unfollowed: 0,
  counters: {
    windows: 1,
    windowFailures: 0,
    resubscribes: 0,
    markers: 0,
    refreshes: 0,
    reconciled: 0,
    gaps: 0,
    resets: 0,
    versionChanges: 0,
    removals: 0,
  },
};

const time = (ms: number): string => `at ${String(ms)}`;

async function banner(
  kind: ExplorerKind,
  freshness: Partial<Freshness> | null,
  state: Partial<WindowSourceState> = {},
) {
  const { fixture, el } = await mountPage(FreshnessBanner, {
    cid: 'c1',
    inputs: {
      kind,
      freshness: freshness === null ? null : { ...FRESH, ...freshness },
      state: { ...STATE, ...state },
      time,
    },
  });
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(el.querySelector('.banner')).not.toBeNull();
  });
  return { fixture, el };
}

const lines = (el: HTMLElement): string[] =>
  [...el.querySelectorAll('li')].map((li) =>
    li.textContent.replace(/\s+/g, ' ').trim(),
  );
const all = (el: HTMLElement): string => lines(el).join(' | ');
const announcement = (el: HTMLElement): string =>
  el.querySelector('[role="status"]')?.textContent.trim() ?? '';

async function update(
  fixture: ComponentFixture<FreshnessBanner>,
  inputs: Record<string, unknown>,
): Promise<void> {
  for (const [name, value] of Object.entries(inputs)) {
    fixture.componentRef.setInput(name, value);
  }
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('<app-freshness-banner>', () => {
  it('AC-13 freshness is shown as the engine sent it: partial, stale, truncated and dropped are never silent', async () => {
    // A list that is live and complete says only when it was updated.
    const calm = await banner('queues', {});
    expect(lines(calm.el)).toEqual(['Info Updated at 1000']);

    // Loading: how much is loaded, and that rows and counts are incomplete; never only "no rows".
    const loading = await banner('queues', {
      state: 'loading',
      complete: false,
      loaded: 3,
      expected: 10,
      reason: 'The first read of the inventory is still running.',
    });
    expect(all(loading.el)).toContain(
      'Loading the inventory: 3 of about 10 loaded. Rows and counts are incomplete.',
    );
    expect(all(loading.el)).toContain('This list is incomplete.');
    expect(all(loading.el)).toContain(
      'The first read of the inventory is still running.',
    ); // the engine's reason, as sent
    expect(all(loading.el)).not.toMatch(/\bno rows\b/i);
    expect(all(loading.el)).not.toMatch(/\bcomplete\b/); // never presented as complete
    expect(all(loading.el)).not.toContain('Updated');
    await update(loading.fixture, {
      freshness: { ...FRESH, state: 'loading', complete: false, loaded: 0 },
    });
    expect(all(loading.el)).toContain(
      'Loading the inventory: 0 loaded. Rows and counts are incomplete.',
    );
    expect(all(loading.el)).not.toContain('about');

    // Stale: the time of the last good read, and the reason.
    const stale = await banner('exchanges', {
      state: 'stale',
      complete: false,
      reason:
        'The last read of the inventory failed; these rows are from an earlier read.',
    });
    expect(all(stale.el)).toContain('Showing the last good read from at 1000.');
    expect(all(stale.el)).toContain('these rows are from an earlier read');

    // Unavailable.
    const gone = await banner('connections', {
      state: 'unavailable',
      complete: false,
      loaded: 0,
      reason: 'The inventory is not being read.',
    });
    expect(all(gone.el)).toContain('The inventory is not being read.');
    expect(all(gone.el)).toContain('This list is incomplete.');

    // Dropped and truncated; a bindings count that is a minimum says "at least".
    const cut = await banner('queues', { truncated: true, dropped: 5 });
    expect(all(cut.el)).toContain(
      '5 rows were left out of the index because of its limit.',
    );
    const minimum = await banner('bindings', {
      truncated: true,
      dropped: 5,
      reason:
        'The broker sent every binding of the vhost in one answer, without paging; the read stopped at the limit and the number left out is not known.',
    });
    expect(all(minimum.el)).toContain(
      'At least 5 rows were left out of the index because of its limit.',
    );

    // A version that changed under a scroll is a one-time notice.
    const moved = await banner('queues', { versionChanged: true });
    expect(all(moved.el)).toContain(
      'The list changed while you were scrolling and was reloaded.',
    );

    // Hazards: a known id has its sentence, an unknown one is shown as the id, never hidden.
    const hazards = await banner('queues', {
      hazards: ['stats-off-policy-fields-missing', 'future-hazard-id'],
    });
    expect(all(hazards.el)).toContain('Statistics are off on this broker');
    expect(all(hazards.el)).toContain('future-hazard-id');
  });

  it('AC-13 the live line says what is followed, what is paused and how the topic ended', async () => {
    const following = await banner(
      'queues',
      {},
      { live: 'following', followed: 40, unfollowed: 12 },
    );
    expect(all(following.el)).toContain('Following 40 rows live.');
    expect(all(following.el)).toMatch(/Live updates paused for 12 rows/);

    const problem = new EngineProblemError({
      type: 'about:blank',
      title: 'Subscription refused',
      status: 403,
      code: 'FORBIDDEN_RBAC',
      detail: 'You may not follow this connection.',
      correlationId: 'c',
      retryable: false,
    });
    await update(following.fixture, {
      state: {
        ...STATE,
        live: 'ended',
        liveProblem: problem,
        followed: 0,
      },
    });
    expect(all(following.el)).toContain('Live updates ended.');
    expect(all(following.el)).toContain('Subscription refused');
    expect(all(following.el)).toContain('You may not follow this connection.');
    expect(all(following.el)).not.toContain('Following');

    const bindings = await banner('bindings', {});
    expect(all(bindings.el)).toContain('Bindings are not followed live.');

    const degraded = await banner(
      'queues',
      {},
      {
        live: 'following',
        followed: 3,
        liveStatus: 'degraded',
      },
    );
    expect(all(degraded.el)).toContain('Live updates are degraded.');
  });

  it('AC-13 a state is announced once: the announcement carries no count', async () => {
    const loading = await banner('queues', {
      state: 'loading',
      complete: false,
      loaded: 3,
      expected: 10,
    });
    const first = announcement(loading.el);
    expect(first).toBe('Loading the inventory. The list is incomplete.');
    expect(first).not.toMatch(/\d/);
    // The count moves while it loads; what a screen reader hears does not.
    await update(loading.fixture, {
      freshness: {
        ...FRESH,
        state: 'loading',
        complete: false,
        loaded: 300,
        expected: 10_000,
      },
    });
    expect(announcement(loading.el)).toBe(first);
    expect(all(loading.el)).toContain('300 of about 10000 loaded');
    const region = loading.el.querySelector('[role="status"]');
    expect(region?.getAttribute('aria-live')).toBe('polite');
  });
});
