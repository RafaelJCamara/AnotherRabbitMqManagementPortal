// Small DOM helpers of the explorer's component specs: typing, keys and the facet pickers.
import type { ComponentFixture } from '@angular/core/testing';
import { vi } from 'vitest';

/**
 * The timeout of a spec that mounts a whole page. A page is the real grid in jsdom (no layout, so it renders
 * every row it holds) with a fake engine and a bar of controls: about two seconds on a developer machine and
 * three times that on a shared CI runner, over vitest's 5 s default. Nothing in these specs sleeps; the time is
 * rendering, and a hung wait still ends at its own, shorter bound (`eventually`).
 */
export const PAGE_TEST_TIMEOUT_MS = 20_000;

export const textInput = (el: HTMLElement): HTMLInputElement => {
  const input = el.querySelector<HTMLInputElement>('.text-input');
  if (!input) throw new Error('no text field');
  return input;
};

export function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

export function enter(target: Element): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }),
  );
}

/** Opens a facet picker by the start of its visible name and returns its panel. */
export async function openPicker(
  fixture: ComponentFixture<unknown>,
  el: HTMLElement,
  name: string,
): Promise<HTMLElement> {
  const toggle = [...el.querySelectorAll<HTMLButtonElement>('.toggle')].find(
    (b) => b.textContent.trim().startsWith(name),
  );
  if (!toggle) throw new Error(`no picker ${name}`);
  if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
  fixture.detectChanges();
  await fixture.whenStable();
  const panel =
    toggle.parentElement?.querySelector<HTMLElement>('[role="group"]');
  if (!panel) throw new Error(`picker ${name} did not open`);
  return panel;
}

/** Types a value into the picker's own field and presses Enter. */
export async function addTyped(
  fixture: ComponentFixture<unknown>,
  panel: HTMLElement,
  value: string,
): Promise<void> {
  const field = panel.querySelector<HTMLInputElement>('input[type="text"]');
  if (!field) throw new Error('no add field');
  field.value = value;
  enter(field);
  fixture.detectChanges();
  await fixture.whenStable();
}

/** Ticks the checkbox of a suggested value in an open panel. */
export function tick(panel: HTMLElement, value: string): void {
  const box = [
    ...panel.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ].find((candidate) => candidate.parentElement?.textContent.trim() === value);
  if (!box) throw new Error(`no option ${value}`);
  box.click();
}

/** Waits until the search form of the bar is in the DOM (the scope loads asynchronously). */
export async function barReady(
  fixture: ComponentFixture<unknown>,
  el: HTMLElement,
): Promise<void> {
  await vi.waitFor(() => {
    fixture.detectChanges();
    if (el.querySelector('form[role="search"]') === null) {
      throw new Error('the filter bar is not there yet');
    }
  });
}
