import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { ShellLayoutStore } from '../layout/shell-layout-store';
import { mountShell, routed, settleShell, visit } from '../test-fixtures';

describe('ActivityBar', () => {
  it('toggles the sidebar and the panel and says which are shown', async () => {
    const bed = await mountShell();
    await visit(bed, '/c/c1/explorer');
    const store = TestBed.inject(ShellLayoutStore);
    const host = routed(bed);
    const buttons = () => [
      ...host.querySelectorAll<HTMLButtonElement>('app-activity-bar button'),
    ];
    const [sidebar, panel] = buttons();
    expect(sidebar?.getAttribute('aria-pressed')).toBe('true');
    expect(panel?.getAttribute('aria-pressed')).toBe('false');
    expect(host.querySelector('aside')).not.toBeNull();
    expect(host.querySelector('app-bottom-panel')).toBeNull();

    sidebar?.click();
    panel?.click();
    await settleShell(bed);
    expect(store.layout().sidebar.visible).toBe(false);
    expect(store.layout().panel.visible).toBe(true);
    expect(buttons().map((b) => b.getAttribute('aria-pressed'))).toEqual([
      'false',
      'true',
    ]);
    expect(host.querySelector('aside')).toBeNull();
    expect(host.querySelector('app-bottom-panel')).not.toBeNull();
    expect(
      host.querySelector('app-splitter[data-orientation="horizontal"]'),
    ).not.toBeNull();

    // Choosing an entry opens the sidebar on it again.
    host.querySelector<HTMLAnchorElement>('app-activity-bar a')?.click();
    await settleShell(bed);
    expect(store.layout().sidebar).toMatchObject({
      visible: true,
      active: 'explorer',
    });
  });

  it('saves the change after the idle delay: one put for several toggles', async () => {
    const bed = await mountShell();
    await visit(bed, '/c/c1/explorer');
    const host = routed(bed);
    const [sidebar, panel] = [
      ...host.querySelectorAll<HTMLButtonElement>('app-activity-bar button'),
    ];
    sidebar?.click();
    sidebar?.click();
    panel?.click();
    expect(bed.layouts.puts).toEqual([]);
    expect(bed.timer.pending).toBe(1);
    bed.timer.fire();
    await TestBed.inject(ShellLayoutStore).flush();
    expect(bed.layouts.puts).toHaveLength(1);
    expect(bed.layouts.puts[0]?.layout).toMatchObject({
      sidebar: { visible: true },
      panel: { visible: true },
    });
  });
});
