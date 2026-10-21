import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, expect, it } from 'vitest';

import { LayoutBackend, twoGroupLayout } from '../layout/layout-fixtures';
import { ShellLayoutStore } from '../layout/shell-layout-store';
import { mountShell, routed, settleShell, visit } from '../test-fixtures';

describe('editor groups', () => {
  it('draws the restored tabs in their groups and shows the routed view in the active group', async () => {
    const backend = new LayoutBackend();
    backend.docs.set('c1', twoGroupLayout('c1'));
    const bed = await mountShell(undefined, backend);
    await visit(bed, '/c/c1/explorer');
    const host = routed(bed);
    const groups = [...host.querySelectorAll('section.group')];
    expect(groups).toHaveLength(2);
    const titles = (group: Element | undefined) =>
      [...(group?.querySelectorAll('[role="tab"]') ?? [])].map((t) =>
        t.textContent.trim(),
      );
    expect(titles(groups[0])).toEqual(['One', 'Two', 'Three']);
    expect(titles(groups[1])).toEqual(['Four']);
    expect(
      groups[0]
        ?.querySelector('[role="tab"][aria-selected="true"]')
        ?.textContent.trim(),
    ).toBe('Two');
    // Only the active group has the routed view; the other one says how to show its tab.
    expect(groups[0]?.querySelector('app-explorer-home')).not.toBeNull();
    expect(groups[1]?.querySelector('app-explorer-home')).toBeNull();
    expect(groups[1]?.querySelector('.hint')?.textContent.trim()).toBe(
      '[[shell.editor.inactive]]',
    );
    // The panels are labelled by what they show.
    const body = groups[0]?.querySelector('[role="tabpanel"]');
    expect(body?.id).toBe('group-body-0');
    expect(
      groups[0]
        ?.querySelector('[aria-controls]')
        ?.getAttribute('aria-controls'),
    ).toBe('group-body-0');
  });

  it('selecting a tab of the other group makes it the active group and shows its address there', async () => {
    const backend = new LayoutBackend();
    backend.docs.set('c1', twoGroupLayout('c1'));
    const bed = await mountShell(undefined, backend);
    await visit(bed, '/c/c1/explorer');
    const host = routed(bed);
    host
      .querySelectorAll<HTMLElement>('section.group')[1]
      ?.querySelector<HTMLElement>('[role="tab"]')
      ?.click();
    await settleShell(bed);
    expect(TestBed.inject(Router).url).toBe('/c/c1/four');
    expect(TestBed.inject(ShellLayoutStore).layout().editor.activeGroup).toBe(
      1,
    );
    const groups = [...host.querySelectorAll('section.group')];
    expect(groups[1]?.querySelector('app-not-found')).not.toBeNull();
    expect(groups[0]?.querySelector('router-outlet')).toBeNull();
  });

  it('splits, switches direction and closes only an empty group; a refusal at the cap is shown', async () => {
    const bed = await mountShell();
    await visit(bed, '/c/c1/explorer');
    const host = routed(bed);
    const store = TestBed.inject(ShellLayoutStore);
    const groups = () => host.querySelectorAll('section.group').length;
    const button = (index: number, text: string) =>
      [
        ...(host
          .querySelectorAll('section.group')
          [index]?.querySelectorAll<HTMLButtonElement>('.actions button') ??
          []),
      ].find((b) => b.textContent.trim() === `[[${text}]]`);

    expect(groups()).toBe(1);
    expect(button(0, 'shell.editor.orientation')).toBeUndefined(); // one group: nothing to rotate
    button(0, 'shell.editor.split')?.click();
    button(0, 'shell.editor.split')?.click();
    await settleShell(bed);
    expect(groups()).toBe(3);
    // The cap: a third split is refused with a visible reason and the count.
    button(0, 'shell.editor.split')?.click();
    await settleShell(bed);
    expect(groups()).toBe(3);
    expect(store.refusals()).toBe(1);
    expect(host.querySelector('app-layout-notices')?.textContent).toContain(
      '[[shell.refusal.groups]]',
    );

    button(0, 'shell.editor.orientation')?.click();
    await settleShell(bed);
    expect(store.layout().editor.orientation).toBe('column');
    expect(
      host.querySelector('.groups')?.getAttribute('data-orientation'),
    ).toBe('column');
    expect(
      host.querySelector('[role="separator"][aria-orientation="horizontal"]'),
    ).not.toBeNull();

    // Empty groups close; the one that is left cannot be closed.
    button(2, 'shell.editor.closeGroup')?.click();
    button(1, 'shell.editor.closeGroup')?.click();
    await settleShell(bed);
    expect(groups()).toBe(1);
    expect(button(0, 'shell.editor.closeGroup')).toBeUndefined();
  });

  it('keeps a group that has tabs: its close button is disabled', async () => {
    const backend = new LayoutBackend();
    backend.docs.set('c1', twoGroupLayout('c1'));
    const bed = await mountShell(undefined, backend);
    await visit(bed, '/c/c1/explorer');
    const close = [
      ...routed(bed).querySelectorAll<HTMLButtonElement>('.actions button'),
    ].filter((b) => b.textContent.trim() === '[[shell.editor.closeGroup]]');
    expect(close.map((b) => b.disabled)).toEqual([true, true]);
    close[0]?.click();
    await settleShell(bed);
    expect(routed(bed).querySelectorAll('section.group')).toHaveLength(2);
  });
});
