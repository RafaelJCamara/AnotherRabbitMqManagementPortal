import { TestBed } from '@angular/core/testing';
import { isEngineProblem } from '@app/ui-data';
import { FakeEngine } from '@app/ui-platform/testing';
import { describe, expect, it } from 'vitest';

import { Announcer } from './announcer';
import type { CommandDefinition } from './command';
import { KEYMAP_SAVE_DELAY_MS, KeymapStore } from './keymap-store';
import { CommandRegistry, Keymap } from './registry';
import { commandProviders } from './testing/bed';
import { FakeKeybindings } from './testing/fake-keybindings';
import { ManualTimer } from './testing/manual-timer';

const command = (id: string): CommandDefinition => ({
  id,
  title: id,
  category: 'Test',
  run: () => undefined,
});

function setup(keybindings: FakeKeybindings) {
  const timer = new ManualTimer();
  TestBed.configureTestingModule({
    providers: commandProviders(
      new FakeEngine({ handler: keybindings.handler }),
      { timer },
    ),
  });
  const registry = TestBed.inject(CommandRegistry);
  registry.register(command('a'));
  registry.register(command('b'));
  registry.register(command('palette.open'));
  return {
    store: TestBed.inject(KeymapStore),
    keymap: TestBed.inject(Keymap),
    announcer: TestBed.inject(Announcer),
    timer,
  };
}

describe('KeymapStore', () => {
  it('AC-7 the keymap loads and saves through keybindings.get and keybindings.put', async () => {
    const keybindings = new FakeKeybindings({ 'palette.open': 'Alt+9' });
    const { store, keymap, announcer, timer } = setup(keybindings);

    // Loaded once, from the engine's document.
    await store.load();
    await store.load();
    expect(keybindings.gets).toBe(1);
    expect(store.loadStatus()).toBe('ready');
    expect(keymap.overrides()).toEqual({ 'palette.open': 'Alt+9' });

    // Two changes inside the delay are one request, with the whole document.
    expect(store.assign('a', 'alt+1').ok).toBe(true);
    expect(store.assign('a', 'Alt+2').ok).toBe(true);
    expect(timer.delays).toEqual([KEYMAP_SAVE_DELAY_MS, KEYMAP_SAVE_DELAY_MS]);
    expect(timer.pending).toBe(1);
    expect(keybindings.puts).toEqual([]);
    timer.advance(KEYMAP_SAVE_DELAY_MS);
    await store.flush();
    expect(keybindings.puts).toEqual([{ 'palette.open': 'Alt+9', a: 'Alt+2' }]);
    expect(store.saveStatus()).toBe('saved');

    // A refused assignment changes nothing and sends nothing.
    expect(store.assign('b', 'Alt+2').ok).toBe(false);
    expect(store.assign('b', 'Mod+T').ok).toBe(false);
    expect(timer.pending).toBe(0);
    await store.flush();
    expect(keybindings.puts).toHaveLength(1);

    // Unbinding, going back to a default and resetting are saved the same way.
    store.unbind('b');
    store.useDefault('palette.open');
    await store.flush();
    expect(keybindings.puts.at(-1)).toEqual({ a: 'Alt+2', b: null });
    store.resetAll();
    await store.flush();
    expect(keybindings.puts.at(-1)).toEqual({});

    // A failed save keeps the override in force, keeps the Problem as received, says so aloud, and a retry sends it.
    keybindings.failWrites();
    expect(store.assign('b', 'Alt+3').ok).toBe(true);
    await store.flush();
    expect(store.saveStatus()).toBe('failed');
    const error = store.saveError();
    expect(isEngineProblem(error) && error.problem.title).toBe(
      'The engine could not save your keybindings',
    );
    expect(keymap.overrides()).toEqual({ b: 'Alt+3' });
    expect(announcer.latest()?.key).toBe('keymapSaveFailed');
    keybindings.failPut = null;
    await store.retry();
    expect(store.saveStatus()).toBe('saved');
    expect(store.saveError()).toBeNull();
    expect(keybindings.document).toEqual({ b: 'Alt+3' });
  });

  it('a failed load leaves the defaults with the Problem and can be tried again', async () => {
    const keybindings = new FakeKeybindings({ a: 'Alt+4' });
    keybindings.failReads();
    const { store, keymap, announcer } = setup(keybindings);

    await store.load();

    expect(store.loadStatus()).toBe('failed');
    expect(isEngineProblem(store.loadError())).toBe(true);
    expect(keymap.overrides()).toEqual({});
    expect(announcer.latest()?.key).toBe('keymapLoadFailed');

    keybindings.failGet = null;
    await store.load();
    expect(store.loadStatus()).toBe('ready');
    expect(keymap.overrides()).toEqual({ a: 'Alt+4' });
  });
});
