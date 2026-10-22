import { Component, signal, viewChild } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import {
  defaultColumnState,
  normalizeColumnState,
  type GridColumnState,
} from './column-state';
import { GridColumnChooser } from './column-chooser';
import { resolveColumns } from './columns';
import { COLUMNS, key, LABELS, type Row } from './grid-spec-support';

const RESOLVED = resolveColumns<Row>([
  ...COLUMNS,
  { id: 'owner', header: 'Owner', value: () => 'ops' },
]);

@Component({
  imports: [GridColumnChooser],
  template: `
    <app-grid-column-chooser
      [columns]="columns"
      [state]="state()"
      [labels]="labels"
      (stateChange)="emitted.push($event); state.set($event)"
    />
  `,
})
class Host {
  readonly columns = RESOLVED;
  readonly labels = LABELS.columnChooser;
  readonly state = signal<GridColumnState>(defaultColumnState(RESOLVED));
  readonly emitted: GridColumnState[] = [];
  readonly chooser = viewChild.required(GridColumnChooser);
}

async function mount() {
  const fixture: ComponentFixture<Host> = TestBed.createComponent(Host);
  document.body.append(fixture.nativeElement as HTMLElement);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const open = async (): Promise<void> => {
    el.querySelector<HTMLButtonElement>('button.toggle')?.click();
    await fixture.whenStable();
  };
  const box = (name: string): HTMLInputElement => {
    const found = [
      ...el.querySelectorAll<HTMLInputElement>('.show input'),
    ].find((input) => input.closest('label')?.textContent.trim() === name);
    if (!found) throw new Error(`No box for ${name}`);
    return found;
  };
  const order = (): string[] =>
    [...el.querySelectorAll('.entry .show')].map((label) =>
      label.textContent.trim(),
    );
  const button = (label: string): HTMLButtonElement => {
    const found = el.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    );
    if (!found) throw new Error(`No button ${label}`);
    return found;
  };
  return {
    fixture,
    host: fixture.componentInstance,
    el,
    open,
    box,
    order,
    button,
  };
}

describe('<app-grid-column-chooser>', () => {
  // The chooser half of AC-12; the state logic is proved in column-state.spec.ts.
  it('shows, hides, reorders, resizes and resets, and each change is a state that round-trips', async () => {
    const { fixture, host, el, open, box, order, button } = await mount();
    const toggle = el.querySelector<HTMLButtonElement>('button.toggle');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('.panel')).toBeNull();
    await open();
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelector('.panel')?.getAttribute('aria-label')).toBe(
      'Choose columns',
    );
    expect(order()).toEqual(['Name', 'Size', 'Owner']);

    // Hide and show.
    box('Size').click();
    await fixture.whenStable();
    expect(host.state().columns.find((c) => c.id === 'size')?.hidden).toBe(
      true,
    );
    expect(box('Size').checked).toBe(false);
    box('Size').click();
    await fixture.whenStable();
    expect(host.state().columns.find((c) => c.id === 'size')?.hidden).toBe(
      false,
    );

    // Reorder with the buttons (a keyboard user's way), first and last cannot move out.
    button('Move Owner up').click();
    await fixture.whenStable();
    expect(order()).toEqual(['Name', 'Owner', 'Size']);
    button('Move Name down').click();
    await fixture.whenStable();
    expect(order()).toEqual(['Owner', 'Name', 'Size']);
    expect(button('Move Owner up').disabled).toBe(true);
    expect(button('Move Size down').disabled).toBe(true);

    // Resize: the width is clamped to the column's minimum and the largest width.
    const width = el.querySelector<HTMLInputElement>(
      'input[aria-label="Width of Name"]',
    );
    if (!width) throw new Error('No width input');
    width.value = '250';
    width.dispatchEvent(new Event('change', { bubbles: true }));
    await fixture.whenStable();
    expect(host.state().columns.find((c) => c.id === 'name')?.width).toBe(250);
    width.value = '5';
    width.dispatchEvent(new Event('change', { bubbles: true }));
    await fixture.whenStable();
    expect(host.state().columns.find((c) => c.id === 'name')?.width).toBe(40);
    expect(width.value).toBe('40');
    width.value = '999999';
    width.dispatchEvent(new Event('change', { bubbles: true }));
    await fixture.whenStable();
    expect(host.state().columns.find((c) => c.id === 'name')?.width).toBe(1200);

    // Every state it emitted is a state a fresh grid applies to the same result.
    for (const state of host.emitted) {
      expect(normalizeColumnState(state, RESOLVED)).toEqual(state);
      expect(
        normalizeColumnState(JSON.parse(JSON.stringify(state)), RESOLVED),
      ).toEqual(state);
    }

    // Reset goes back to the default layout and keeps the sort.
    host.state.set({
      ...host.state(),
      sort: [{ columnId: 'name', direction: 'desc' }],
    });
    await fixture.whenStable();
    el.querySelector<HTMLButtonElement>('button.reset')?.click();
    await fixture.whenStable();
    expect(host.state()).toEqual({
      ...defaultColumnState(RESOLVED),
      sort: [{ columnId: 'name', direction: 'desc' }],
    });
    expect(order()).toEqual(['Name', 'Size', 'Owner']);
  });

  it('at least one column stays visible: the last visible box cannot be cleared', async () => {
    const { fixture, host, el, open, box } = await mount();
    await open();
    box('Size').click();
    await fixture.whenStable();
    box('Owner').click();
    await fixture.whenStable();
    expect(host.state().columns.filter((c) => c.hidden !== true)).toHaveLength(
      1,
    );
    const before = host.emitted.length;
    const last = box('Name');
    expect(last.getAttribute('aria-disabled')).toBe('true');
    expect(last.getAttribute('aria-describedby')).toBeTruthy();
    expect(
      el
        .querySelector(`#${last.getAttribute('aria-describedby') ?? ''}`)
        ?.textContent.trim(),
    ).toBe('At least one column stays visible');
    last.click();
    await fixture.whenStable();
    // Refused: nothing is emitted and the box is still checked.
    expect(host.emitted).toHaveLength(before);
    expect(box('Name').checked).toBe(true);
    expect(host.state().columns.find((c) => c.id === 'name')?.hidden).toBe(
      false,
    );
  });

  it('show() opens the panel for a command and puts focus on its first control', async () => {
    const { fixture, host, el } = await mount();
    expect(el.querySelector('.panel')).toBeNull();
    host.chooser().show();
    await fixture.whenStable();
    expect(
      el.querySelector('button.toggle')?.getAttribute('aria-expanded'),
    ).toBe('true');
    expect(el.querySelector('.panel')).not.toBeNull();
    expect(document.activeElement).toBe(el.querySelector('.panel input'));
  });

  it('closes with Escape and gives focus back to its button', async () => {
    const { fixture, el, open } = await mount();
    await open();
    const first = el.querySelector<HTMLInputElement>('.show input');
    first?.focus();
    key(first as Element, 'Escape');
    await fixture.whenStable();
    expect(el.querySelector('.panel')).toBeNull();
    expect(document.activeElement).toBe(el.querySelector('button.toggle'));
  });
});
