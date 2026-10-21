import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import {
  SCOPE_LOADERS,
  provideI18n,
  provideScopes,
} from '../../i18n/i18n.config';
import { markerLoaders, settle } from '../../i18n/test-fixtures';
import {
  LayoutBackend,
  cidOf,
  layoutProviders,
} from '../layout/layout-fixtures';
import { ShellLayoutStore } from '../layout/shell-layout-store';
import { BottomPanel } from './bottom-panel';

async function mount() {
  TestBed.configureTestingModule({
    providers: [
      ...layoutProviders(new LayoutBackend()),
      provideI18n(),
      provideScopes('shell'),
      { provide: SCOPE_LOADERS, useValue: markerLoaders() },
    ],
  });
  const store = TestBed.inject(ShellLayoutStore);
  await store.open(cidOf('c1'));
  const fixture = TestBed.createComponent(BottomPanel);
  await settle(fixture);
  const root = fixture.nativeElement as HTMLElement;
  const tabs = () => [...root.querySelectorAll<HTMLElement>('[role="tab"]')];
  const tab = (index: number): HTMLElement => {
    const found = tabs()[index];
    if (found === undefined) throw new Error(`no tab ${String(index)}`);
    return found;
  };
  const press = async (target: HTMLElement, key: string) => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    await settle(fixture);
  };
  return { store, fixture, root, tabs, tab, press };
}

describe('BottomPanel', () => {
  it('has the tabs pattern: one tab stop, selection follows the arrows, Home and End', async () => {
    const { store, root, tabs, tab, press } = await mount();
    expect(root.querySelector('[role="tablist"]')).not.toBeNull();
    expect(tabs().map((tab) => tab.textContent.trim())).toEqual([
      '[[shell.panel.tab.jobs]]',
      '[[shell.panel.tab.receipts]]',
      '[[shell.panel.tab.tap]]',
      '[[shell.panel.tab.problems]]',
      '[[shell.panel.tab.output]]',
    ]);
    const stops = () =>
      tabs().filter((tab) => tab.getAttribute('tabindex') === '0');
    expect(stops()).toHaveLength(1);
    expect(stops()[0]?.getAttribute('aria-selected')).toBe('true');

    await press(tab(0), 'ArrowRight');
    expect(store.layout().panel.active).toBe('receipts');
    expect(document.activeElement?.id).toBe('panel-tab-receipts');
    await press(tab(1), 'End');
    expect(store.layout().panel.active).toBe('output');
    await press(tab(4), 'ArrowRight');
    expect(store.layout().panel.active).toBe('jobs');
    await press(tab(0), 'ArrowLeft');
    expect(store.layout().panel.active).toBe('output');
    await press(tab(4), 'Home');
    expect(store.layout().panel.active).toBe('jobs');

    // The panel body is labelled by the selected tab and says what it is: empty.
    const body = root.querySelector('[role="tabpanel"]');
    expect(body?.getAttribute('aria-labelledby')).toBe('panel-tab-jobs');
    expect(body?.textContent.trim()).toBe('[[shell.panel.empty]]');
    expect(stops()).toHaveLength(1);
  });
});
