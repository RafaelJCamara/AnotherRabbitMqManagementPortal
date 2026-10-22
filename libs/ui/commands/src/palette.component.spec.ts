import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import type { CommandDefinition } from './command';
import { COUNT_ANNOUNCE_DELAY_MS } from './palette.component';
import { PaletteControl } from './palette-control';
import { CommandRegistry } from './registry';
import {
  mountHost,
  press,
  settle,
  until,
  type CommandBed,
} from './testing/bed';

const command = (
  id: string,
  title: string,
  extra: Partial<CommandDefinition> = {},
): CommandDefinition => ({
  id,
  title,
  category: 'Test',
  run: () => undefined,
  ...extra,
});

const dialog = (): HTMLElement | null =>
  document.querySelector('[role="dialog"]');
const field = (): HTMLInputElement => {
  const input = document.querySelector<HTMLInputElement>('[role="combobox"]');
  if (input === null) throw new Error('no palette');
  return input;
};
const options = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[role="option"]'),
];
const live = (): string =>
  dialog()?.querySelector('[role="status"]')?.textContent.trim() ?? '';

async function openPalette(bed: CommandBed): Promise<void> {
  TestBed.inject(PaletteControl).openPalette();
  await until(
    bed.fixture,
    () => dialog() !== null && options().length > 0,
    'the palette',
  );
}

function type(text: string): void {
  const input = field();
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const key = (name: string): void => {
  field().dispatchEvent(
    new KeyboardEvent('keydown', {
      key: name,
      bubbles: true,
      cancelable: true,
    }),
  );
};

describe('CommandPalette', () => {
  it('M1-41 AC-9 the palette is an accessible combobox over a listbox', async () => {
    const bed = await mountHost();
    const registry = TestBed.inject(CommandRegistry);
    registry.register(command('account.balance.update', 'Change the balance'));
    registry.register(command('account.balance.read', 'Read the balance'));
    registry.register(
      command('database.backup.upload', 'Upload a database backup'),
    );
    registry.register(
      command('go.explorer.queues', 'Go to queues', { keybinding: 'Alt+Q' }),
    );
    await openPalette(bed);

    // The pattern: a labelled modal dialog; a combobox that owns a listbox and names the active option.
    expect(dialog()?.getAttribute('aria-modal')).toBe('true');
    expect(dialog()?.getAttribute('aria-label')).toBe('Command palette');
    const input = field();
    expect(input.getAttribute('aria-label')).toBe('Search commands');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    const list = document.querySelector('[role="listbox"]');
    expect(list?.id).toBe(input.getAttribute('aria-controls'));
    expect(document.activeElement).toBe(input);
    // The commands of the system itself and the four above, each an option; the chord is shown.
    expect(options()).toHaveLength(6);
    expect(
      options().filter((o) => o.getAttribute('aria-selected') === 'true'),
    ).toHaveLength(1);
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[0]?.id);
    expect(
      options()
        .find((o) => o.textContent.includes('Go to queues'))
        ?.querySelector('kbd')?.textContent,
    ).toBe('Alt+Q');

    // Arrows move the active option and wrap; PageDown and PageUp jump.
    key('ArrowDown');
    await settle(bed.fixture);
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[1]?.id);
    key('ArrowUp');
    key('ArrowUp');
    await settle(bed.fixture);
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[5]?.id);
    key('ArrowDown');
    await settle(bed.fixture);
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[0]?.id);
    key('PageDown');
    await settle(bed.fixture);
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[5]?.id);
    key('PageUp');
    await settle(bed.fixture);
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[0]?.id);

    // Typing filters, ranks and highlights as text (marks), and a new query starts at the best match.
    key('ArrowDown');
    type('abau');
    await until(bed.fixture, () => options().length === 2, 'the filtered list');
    expect(
      options()[0]?.querySelector('.id')?.textContent.replace(/\s+/g, ''),
    ).toBe('account.balance.update');
    const marks = [...(options()[0]?.querySelectorAll('mark') ?? [])].map(
      (m) => m.textContent,
    );
    expect(marks.join('')).toBe('abau');
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[0]?.id);
    expect(dialog()?.querySelector('script, iframe')).toBeNull();

    // The count is announced when typing has stopped, not for each key.
    expect(live()).toBe('');
    bed.timer.advance(COUNT_ANNOUNCE_DELAY_MS);
    await until(bed.fixture, () => live() !== '', 'the count');
    expect(live()).toBe('2 commands match.');
    type('zzzz');
    await until(bed.fixture, () => options().length === 0, 'an empty list');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    expect(dialog()?.textContent).toContain('No command matches.');
    bed.timer.advance(COUNT_ANNOUNCE_DELAY_MS);
    await until(
      bed.fixture,
      () => live() === 'No command matches.',
      'the empty count',
    );

    // Escape closes it; Tab stays inside.
    const tab = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    press('Escape', {}, input);
    await until(bed.fixture, () => dialog() === null, 'the palette to close');
  });

  it('M1-41 AC-10 focus returns before a command runs and failures are announced', async () => {
    const bed = await mountHost();
    const registry = TestBed.inject(CommandRegistry);
    const opener = document.createElement('button');
    opener.textContent = 'open';
    document.body.append(opener);
    const target = document.createElement('input');
    document.body.append(target);
    const focusAtRun: (Element | null)[] = [];
    const run = vi.fn(() => {
      focusAtRun.push(document.activeElement);
      target.focus(); // a command that moves focus (the explorer's "focus the filter")
    });
    const closedRun = vi.fn();
    registry.register(command('test.focus', 'Move the focus', { run }));
    registry.register(
      command('test.closed', 'Closed one', {
        action: 'views.create',
        run: closedRun,
      }),
    );
    registry.register(
      command('test.throws', 'Throws one', {
        run: () => {
          throw new Error('boom');
        },
      }),
    );

    // Focus returns to the opener first, then the command runs and its own focus change wins.
    opener.focus();
    await openPalette(bed);
    type('move focus');
    await until(bed.fixture, () => options().length === 1, 'the match');
    key('Enter');
    await until(
      bed.fixture,
      () => run.mock.calls.length === 1,
      'the command to run',
    );
    expect(focusAtRun).toEqual([opener]);
    expect(document.activeElement).toBe(target);
    await until(bed.fixture, () => dialog() === null, 'the palette to close');

    // A closed command keeps the palette open, is not run, and the reason is read out.
    opener.focus();
    await openPalette(bed);
    type('closed one');
    await until(
      bed.fixture,
      () => options().length === 1,
      'the closed command',
    );
    expect(options()[0]?.getAttribute('aria-disabled')).toBe('true');
    const reason = document.getElementById(
      options()[0]?.getAttribute('aria-describedby') ?? 'none',
    );
    expect(reason?.textContent).toContain(
      'capabilities of this connection are not known',
    );
    key('Enter');
    await until(
      bed.fixture,
      () =>
        (bed.el.querySelector('[role="status"]')?.textContent ?? '').includes(
          'Closed one is not available',
        ),
      'the reason',
    );
    expect(closedRun).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(field());
    press('Escape', {}, field());
    await until(bed.fixture, () => dialog() === null, 'the palette to close');
    expect(document.activeElement).toBe(opener);

    // A command that throws is reported, the palette is closed and the next command still runs.
    await openPalette(bed);
    type('throws one');
    await until(
      bed.fixture,
      () => options().length === 1,
      'the throwing command',
    );
    key('Enter');
    await until(
      bed.fixture,
      () =>
        (bed.el.querySelector('[role="status"]')?.textContent ?? '').includes(
          'Throws one failed.',
        ),
      'the failure',
    );
    await until(bed.fixture, () => dialog() === null, 'the palette to close');
    await openPalette(bed);
    type('move focus');
    await until(bed.fixture, () => options().length === 1, 'the match again');
    key('Enter');
    await until(
      bed.fixture,
      () => run.mock.calls.length === 2,
      'the second run',
    );
    opener.remove();
    target.remove();
  });
});
