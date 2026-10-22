import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { Announcer } from './announcer';
import type { CommandDefinition } from './command';
import { KEYMAP_SAVE_DELAY_MS, KeymapStore } from './keymap-store';
import { COUNT_ANNOUNCE_DELAY_MS } from './palette.component';
import { PaletteControl } from './palette-control';
import { PALETTE_SCOPE_LOADER } from './palette-scope';
import { CommandRegistry, Keymap } from './registry';
import { mountHost, press, settle, until } from './testing/bed';
import { FakeKeybindings } from './testing/fake-keybindings';
import {
  markedPaletteScope,
  paletteKeys,
  visibleStrings,
} from './testing/markers';

const MARKER = /^\[\[(palette\.[A-Za-z0-9.-]+)\]\]$/;

const command = (
  id: string,
  extra: Partial<CommandDefinition> = {},
): CommandDefinition => ({
  id,
  title: `Title ${id}`,
  category: 'Test',
  run: () => undefined,
  ...extra,
});

describe('palette i18n', () => {
  it('M1-41 AC-13 every string of the palette and cheat sheet is a key', async () => {
    const known = new Set(paletteKeys());
    const seen = new Set<string>();
    const unknown: string[] = [];
    const take = (): void => {
      for (const text of visibleStrings(document.body)) {
        const key = MARKER.exec(text)?.[1];
        if (key === undefined) continue;
        if (known.has(key)) seen.add(key);
        else unknown.push(key);
      }
    };

    // The engine keeps a document with a reserved chord, a chord that is not one, one the person unbound and a plain
    // override; the first read fails, so the first states are the failed ones.
    const keybindings = new FakeKeybindings({
      'test.reserved': 'Mod+T',
      'test.broken': 'Mod+',
      'test.unbound': null,
      'test.own': 'Mod+Shift+B',
    });
    keybindings.failReads();
    const bed = await mountHost({
      keybindings,
      providers: [
        { provide: PALETTE_SCOPE_LOADER, useValue: markedPaletteScope },
      ],
    });
    const registry = TestBed.inject(CommandRegistry);
    const control = TestBed.inject(PaletteControl);
    const store = TestBed.inject(KeymapStore);
    for (const def of [
      command('test.reserved'),
      command('test.broken'),
      command('test.unbound', { keybinding: 'Alt+7' }),
      command('test.own'),
      command('test.dup.a', { keybinding: 'Alt+3' }),
      command('test.dup.b', { keybinding: 'Alt+3' }),
      command('test.gate', { gate: 'streams.browse' }),
      command('test.gate.bare', { gate: 'tap.firehose' }),
      command('test.action', { action: 'views.delete' }),
      command('test.waiting', { action: 'views.create' }),
      command('test.own.reason', { unavailable: () => 'Wait for the floor.' }),
      command('test.throws', {
        run: () => {
          throw new Error('boom');
        },
      }),
    ]) {
      registry.register(def);
    }
    await until(
      bed.fixture,
      () =>
        document.body.textContent.includes('palette.announce.keymapLoadFailed'),
      'the load failure',
    );
    take(); // announce.keymapLoadFailed

    // The cheat sheet while the keymap could not be loaded.
    control.openShortcuts();
    await until(
      bed.fixture,
      () => document.querySelector('tbody tr') !== null,
      'the cheat sheet',
    );
    take(); // title, table, headers, none, loadFailed, retry, close, resetAll, change/unbind names
    keybindings.failGet = null;
    document.querySelector<HTMLButtonElement>('p.problem button')?.click();
    await until(
      bed.fixture,
      () => store.loadStatus() === 'ready',
      'the keymap to load',
    );
    await settle(bed.fixture);
    take(); // yours, unbound, useDefault, conflicts and the three conflict kinds

    // Capturing and the four refusals.
    const change = (): HTMLButtonElement => {
      const found = document.querySelector<HTMLButtonElement>(
        'button[aria-label="[[palette.shortcuts.changeNamed]]"]',
      );
      if (found === null) throw new Error('no change button');
      return found;
    };
    change().click();
    await until(
      bed.fixture,
      () => document.body.textContent.includes('palette.shortcuts.press'),
      'the capture prompt',
    );
    take(); // press
    press('Escape', {}, document.activeElement ?? document.body);
    for (const [keyName, init] of [
      ['t', { ctrlKey: true }],
      ['AudioVolumeUp', {}],
      ['3', { altKey: true, code: 'Digit3' }],
    ] as const) {
      change().click();
      press(keyName, init, document.activeElement ?? document.body);
      await until(
        bed.fixture,
        () => document.querySelector('[role="alert"]') !== null,
        'a refusal',
      );
      await settle(bed.fixture);
      take(); // refused.reserved, refused.invalid, refused.conflict and replace
    }
    const full = Object.fromEntries(
      Array.from({ length: 500 }, (_, n) => [`unknown.c${String(n)}`, 'Alt+9']),
    );
    TestBed.inject(Keymap).set(full);
    change().click();
    press(
      'q',
      { altKey: true, code: 'KeyQ' },
      document.activeElement ?? document.body,
    );
    await until(
      bed.fixture,
      () =>
        (document.querySelector('[role="alert"]')?.textContent ?? '').includes(
          'too-many',
        ),
      'the limit',
    );
    take(); // refused.too-many
    store.resetAll();

    // Saving in flight, saved, and failed with a retry.
    let release: () => void = () => undefined;
    keybindings.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.assign('test.own', 'Alt+8');
    bed.timer.advance(KEYMAP_SAVE_DELAY_MS);
    const flushing = store.flush();
    await until(
      bed.fixture,
      () => document.body.textContent.includes('palette.shortcuts.saving'),
      'the saving line',
    );
    take(); // saving
    release();
    await flushing;
    await until(
      bed.fixture,
      () => document.body.textContent.includes('palette.shortcuts.saved'),
      'the saved line',
    );
    take(); // saved
    keybindings.hold = null;
    keybindings.failWrites();
    store.assign('test.own', 'Alt+6');
    bed.timer.advance(KEYMAP_SAVE_DELAY_MS);
    await store.flush();
    await until(
      bed.fixture,
      () =>
        document.body.textContent.includes(
          'palette.shortcuts.saveFailedDetail',
        ),
      'the save failure',
    );
    take(); // saveFailedDetail, announce.keymapSaveFailed
    control.closeShortcuts();
    await until(
      bed.fixture,
      () => document.querySelector('[role="dialog"]') === null,
      'the cheat sheet to close',
    );

    // The palette: every reason a command can be closed for, the counts and the announcements.
    bed.capabilities.set({
      status: 'ready',
      allowedActions: [],
      gates: {
        'streams.browse': {
          enabled: false,
          reason: 'Needs a newer broker.',
          source: 'guardrail',
        },
        'tap.firehose': { enabled: false },
      },
    });
    control.openPalette();
    await until(
      bed.fixture,
      () => document.querySelectorAll('[role="option"]').length > 0,
      'the palette',
    );
    take(); // title, input, placeholder, results, category.*, commands.*, reason.withSource, gateNoReason, notAllowed
    bed.capabilities.set({ status: 'loading' });
    await settle(bed.fixture);
    take(); // reason.loading
    bed.capabilities.set({ status: 'unknown' });
    await settle(bed.fixture);
    take(); // reason.unknown
    const type = (text: string): void => {
      const input =
        document.querySelector<HTMLInputElement>('[role="combobox"]');
      if (input === null) throw new Error('no palette');
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    for (const [query, count] of [
      ['', null],
      ['test.throws', 1],
      ['zzzz', 0],
    ] as const) {
      type(query);
      await until(
        bed.fixture,
        () =>
          count === null
            ? true
            : document.querySelectorAll('[role="option"]').length === count,
        'the list',
      );
      bed.timer.advance(COUNT_ANNOUNCE_DELAY_MS);
      await settle(bed.fixture);
      take(); // count, countOne, countNone, empty
    }
    press(
      'Escape',
      {},
      document.querySelector('[role="combobox"]') ?? document.body,
    );
    await until(
      bed.fixture,
      () => document.querySelector('[role="dialog"]') === null,
      'the palette to close',
    );

    // The announcements.
    await registry.execute('test.action');
    await until(
      bed.fixture,
      () => document.body.textContent.includes('palette.announce.closed'),
      'the closed line',
    );
    take(); // announce.closed
    await registry.execute('test.throws');
    await until(
      bed.fixture,
      () => document.body.textContent.includes('palette.announce.failed'),
      'the failed line',
    );
    take(); // announce.failed
    press('3', { altKey: true, code: 'Digit3' });
    await until(
      bed.fixture,
      () => document.body.textContent.includes('palette.announce.conflict'),
      'the conflict line',
    );
    take(); // announce.conflict
    TestBed.inject(Announcer).say('text', { text: 'Said by the app' });
    await until(
      bed.fixture,
      () => document.body.textContent.includes('palette.announce.text'),
      'the text line',
    );
    take(); // announce.text

    expect(unknown).toEqual([]);
    expect([...known].filter((key) => !seen.has(key))).toEqual([]);
  });
});
