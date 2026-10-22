import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type { CommandDefinition } from './command';
import { KEYMAP_SAVE_DELAY_MS, KeymapStore } from './keymap-store';
import { PaletteControl } from './palette-control';
import { CommandRegistry } from './registry';
import { mountHost, press, until, type CommandBed } from './testing/bed';
import { FakeKeybindings } from './testing/fake-keybindings';

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
const rows = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('tbody tr'),
];
const row = (title: string): HTMLElement => {
  const found = rows().find(
    (r) => r.querySelector('th')?.textContent.trim() === title,
  );
  if (found === undefined) throw new Error(`no row ${title}`);
  return found;
};
const chordOf = (title: string): string =>
  [...row(title).querySelectorAll('kbd')].map((k) => k.textContent).join(' ');
const button = (scope: ParentNode, name: string): HTMLButtonElement => {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => (b.getAttribute('aria-label') ?? b.textContent.trim()) === name,
  );
  if (found === undefined) throw new Error(`no button ${name}`);
  return found;
};
const alerts = (): string =>
  document
    .querySelector('[role="alert"]')
    ?.textContent.replace(/\s+/g, ' ')
    .trim() ?? '';

async function mountSheet(keybindings: FakeKeybindings): Promise<CommandBed> {
  const bed = await mountHost({ keybindings });
  const registry = TestBed.inject(CommandRegistry);
  registry.register(command('test.alpha', 'Alpha', { keybinding: 'Alt+1' }));
  registry.register(command('test.beta', 'Beta'));
  registry.register(command('test.gamma', 'Gamma', { keybinding: 'Alt+3' }));
  registry.register(command('test.delta', 'Delta', { keybinding: 'Alt+3' }));
  registry.register(
    command('connection.switch.c_1', 'Switch to c_1', { bindable: false }),
  );
  await bed.fixture.whenStable();
  TestBed.inject(PaletteControl).openShortcuts();
  await until(
    bed.fixture,
    () => dialog() !== null && rows().length > 0,
    'the cheat sheet',
  );
  return bed;
}

function capture(
  name: string,
  keyName: string,
  init: KeyboardEventInit = {},
): void {
  button(document, `Change the shortcut of ${name}`).click();
  press(keyName, init, document.activeElement ?? document.body);
}

describe('ShortcutsDialog', () => {
  it('AC-11 the cheat sheet lists, changes and reports', async () => {
    const keybindings = new FakeKeybindings({ 'test.beta': 'Mod+Shift+B' });
    const bed = await mountSheet(keybindings);

    // Every command that can hold a chord is a row; the generated one is not. Chord, source and conflict are shown.
    expect(
      rows().map((r) => r.querySelector('th')?.textContent.trim()),
    ).toEqual([
      'Open the command palette',
      'Show keyboard shortcuts',
      'Alpha',
      'Beta',
      'Delta',
      'Gamma',
    ]);
    expect(dialog()?.getAttribute('aria-labelledby')).toBe(
      dialog()?.querySelector('h2')?.id,
    );
    expect(document.activeElement?.tagName).toBe('H2');
    expect(chordOf('Alpha')).toBe('Alt+1');
    expect(chordOf('Open the command palette')).toBe('Ctrl+K');
    expect(chordOf('Beta')).toBe('Ctrl+Shift+B');
    expect(row('Beta').textContent).toContain('your choice');
    expect(row('Alpha').textContent).not.toContain('your choice');
    expect(row('Show keyboard shortcuts').textContent).toContain('No shortcut');
    expect(dialog()?.textContent).toContain(
      'Alt+3 is assigned to Delta, Gamma.',
    );

    // Change: the next key press is captured, saved after the delay, and shown.
    capture('Alpha', 'j', { ctrlKey: true });
    await until(
      bed.fixture,
      () => chordOf('Alpha') === 'Ctrl+J',
      'the new chord',
    );
    expect(row('Alpha').textContent).toContain('your choice');
    expect(keybindings.puts).toEqual([]);
    bed.timer.advance(KEYMAP_SAVE_DELAY_MS);
    await TestBed.inject(KeymapStore).flush();
    expect(keybindings.puts).toEqual([
      { 'test.beta': 'Mod+Shift+B', 'test.alpha': 'Mod+J' },
    ]);
    await until(
      bed.fixture,
      () => (dialog()?.textContent ?? '').includes('Your shortcuts are saved.'),
      'the saved line',
    );

    // Escape while capturing cancels the capture and leaves the dialog open.
    button(document, 'Change the shortcut of Alpha').click();
    await until(
      bed.fixture,
      () => row('Alpha').textContent.includes('Press the new shortcut'),
      'the capture',
    );
    press('Escape', {}, document.activeElement ?? document.body);
    await until(
      bed.fixture,
      () => !row('Alpha').textContent.includes('Press the new shortcut'),
      'the cancel',
    );
    expect(dialog()).not.toBeNull();
    expect(chordOf('Alpha')).toBe('Ctrl+J');

    // A chord that is reserved, not a chord, or taken is refused with the reason, and nothing changes.
    capture('Alpha', 't', { ctrlKey: true });
    await until(bed.fixture, () => alerts() !== '', 'the refusal');
    expect(alerts()).toBe(
      'Ctrl+T is kept by the browser or by the page and cannot be used.',
    );
    capture('Alpha', 'AudioVolumeUp');
    await until(
      bed.fixture,
      () => alerts().includes('is not a valid shortcut'),
      'the invalid refusal',
    );
    capture('Beta', '3', { altKey: true, code: 'Digit3' });
    await until(
      bed.fixture,
      () => alerts().startsWith('Alt+3 is already assigned to'),
      'the conflict',
    );
    expect(alerts()).toContain('Delta, Gamma');
    expect(chordOf('Beta')).toBe('Ctrl+Shift+B');
    // Replacing takes the chord from the other commands in the same document.
    button(document, 'Replace it').click();
    await until(
      bed.fixture,
      () => chordOf('Beta') === 'Alt+3',
      'the replacement',
    );
    expect(chordOf('Gamma')).toBe('');
    expect(row('Gamma').textContent).toContain('Unbound');
    expect(chordOf('Delta')).toBe('');
    expect(alerts()).toBe('');
    expect(dialog()?.textContent).not.toContain('Shortcuts that do nothing');

    // Unbind, use default, reset all.
    button(document, 'Remove the shortcut of Alpha').click();
    await until(
      bed.fixture,
      () => row('Alpha').textContent.includes('Unbound'),
      'the unbound row',
    );
    button(document, 'Use the default shortcut of Alpha').click();
    await until(
      bed.fixture,
      () => chordOf('Alpha') === 'Alt+1',
      'the default back',
    );
    button(document, 'Reset all shortcuts').click();
    await until(bed.fixture, () => chordOf('Beta') === '', 'the reset');
    expect(chordOf('Gamma')).toBe('Alt+3');

    // A failed save is said in words with the engine's title, and a retry sends it.
    keybindings.failWrites();
    capture('Beta', 'b', { ctrlKey: true, altKey: true, code: 'KeyB' });
    await until(
      bed.fixture,
      () => chordOf('Beta') === 'Ctrl+Alt+B',
      'the new chord',
    );
    bed.timer.advance(KEYMAP_SAVE_DELAY_MS);
    await TestBed.inject(KeymapStore).flush();
    await until(
      bed.fixture,
      () => (dialog()?.textContent ?? '').includes('could not be saved'),
      'the failure',
    );
    expect(dialog()?.textContent).toContain(
      'The engine could not save your keybindings',
    );
    keybindings.failPut = null;
    button(dialog() ?? document, 'Try again').click();
    await until(
      bed.fixture,
      () => keybindings.document['test.beta'] === 'Mod+Alt+B',
      'the retry',
    );

    // Escape closes the dialog and gives focus back.
    press('Escape', {}, document.activeElement ?? document.body);
    await until(bed.fixture, () => dialog() === null, 'the dialog to close');
  });
});
