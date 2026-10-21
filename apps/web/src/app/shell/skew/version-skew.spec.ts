import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { PAGE_RELOAD } from '../../boot/page-reload';
import { ShellLayoutStore } from '../layout/shell-layout-store';
import { FakeLive } from '../status-bar/status-fixtures';
import { mountShell, routed, settleShell, visit } from '../test-fixtures';

describe('version skew', () => {
  it('AC-14 a version mismatch shows a non-blocking reload banner', async () => {
    const live = new FakeLive();
    const reload = vi.fn<() => void>();
    const bed = await mountShell(undefined, undefined, undefined, [
      live.provider,
      { provide: PAGE_RELOAD, useValue: reload },
    ]);
    live.engineVersion.set('1.0.0'); // the page loaded under 1.0.0
    await visit(bed, '/c/c1/explorer');
    const host = routed(bed);
    const banner = () => host.querySelector('app-skew-banner [role="status"]');

    // The same version: nothing to say.
    expect(banner()).toBeNull();
    live.engineVersion.set('1.0.0');
    await settleShell(bed);
    expect(banner()).toBeNull();

    // The person is working: a focused control and a layout change in flight.
    const tab = host.querySelector<HTMLElement>('[role="treeitem"]');
    tab?.focus();
    const store = TestBed.inject(ShellLayoutStore);
    const layoutBefore = store.layout();

    // The engine now reports a newer version.
    live.engineVersion.set('1.1.0');
    await settleShell(bed);
    expect(banner()?.textContent).toContain('[[system.skew.message]]');
    expect(banner()?.textContent).toContain('[[system.skew.reload]]');
    expect(document.activeElement).toBe(tab); // no focus stolen
    expect(store.layout()).toBe(layoutBefore); // nothing discarded or changed
    expect(reload).not.toHaveBeenCalled(); // nothing happened by itself
    expect(
      host.querySelector('app-skew-banner [role="dialog"], [aria-modal]'),
    ).toBeNull();

    // The reload is the person's; the address stays (it is a reload of the page).
    banner()?.querySelector('button')?.click();
    expect(reload).toHaveBeenCalledTimes(1);

    // Back to the same version: the banner goes away again.
    live.engineVersion.set('1.0.0');
    await settleShell(bed);
    expect(banner()).toBeNull();
  });

  it('shows the banner for a goaway with version-mismatch, and for no other reason', async () => {
    const live = new FakeLive();
    const bed = await mountShell(undefined, undefined, undefined, [
      live.provider,
    ]);
    await visit(bed, '/c/c1/explorer');
    const banner = () =>
      routed(bed).querySelector('app-skew-banner [role="status"]');
    live.goaway.set({ reason: 'drain' });
    await settleShell(bed);
    expect(banner()).toBeNull();
    live.goaway.set({ reason: 'version-mismatch' });
    await settleShell(bed);
    expect(banner()).not.toBeNull();
  });

  it('keeps the first version it saw, so a second change is still a mismatch', async () => {
    const live = new FakeLive();
    const bed = await mountShell(undefined, undefined, undefined, [
      live.provider,
    ]);
    await visit(bed, '/c/c1/explorer');
    live.engineVersion.set('1.0.0');
    await settleShell(bed);
    live.engineVersion.set('1.1.0');
    await settleShell(bed);
    live.engineVersion.set('1.2.0');
    await settleShell(bed);
    expect(
      routed(bed).querySelector('app-skew-banner [role="status"]'),
    ).not.toBeNull();
  });
});
