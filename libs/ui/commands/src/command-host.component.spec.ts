import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import type { CommandDefinition } from './command';
import { PaletteControl } from './palette-control';
import { CommandRegistry } from './registry';
import { mountHost, press, settle, until } from './testing/bed';
import { FakeKeybindings } from './testing/fake-keybindings';

const command = (
  id: string,
  extra: Partial<CommandDefinition> = {},
): CommandDefinition => ({
  id,
  title: `Title of ${id}`,
  category: 'Test',
  run: () => undefined,
  ...extra,
});

const live = (el: HTMLElement): string =>
  el.querySelector('[role="status"]')?.textContent.trim() ?? '';

describe('CommandHost', () => {
  it('AC-8 the dispatcher matches, ignores and announces', async () => {
    const bed = await mountHost();
    const registry = TestBed.inject(CommandRegistry);
    const control = TestBed.inject(PaletteControl);
    const alpha = vi.fn();
    const plain = vi.fn();
    const closed = vi.fn();
    registry.register(
      command('test.alpha', { keybinding: 'Alt+1', run: alpha }),
    );
    registry.register(command('test.plain', { keybinding: '/', run: plain }));
    registry.register(
      command('test.closed', {
        keybinding: 'Alt+2',
        action: 'views.create',
        run: closed,
      }),
    );
    registry.register(command('test.dup.a', { keybinding: 'Alt+3' }));
    registry.register(command('test.dup.b', { keybinding: 'Alt+3' }));
    await settle(bed.fixture);

    // A chord runs its command, and only a matched chord is taken from the browser.
    const hit = press('1', { altKey: true, code: 'Digit1' });
    expect(hit.defaultPrevented).toBe(true);
    expect(alpha).toHaveBeenCalledTimes(1);
    expect(press('x').defaultPrevented).toBe(false);
    expect(
      press('1', { altKey: true, code: 'Digit1', shiftKey: true })
        .defaultPrevented,
    ).toBe(false);

    // Auto-repeat and an event another handler already took do nothing.
    press('1', { altKey: true, code: 'Digit1', repeat: true });
    document.body.addEventListener(
      'keydown',
      (event) => {
        event.preventDefault();
      },
      { once: true },
    );
    press('1', { altKey: true, code: 'Digit1' });
    expect(alpha).toHaveBeenCalledTimes(1);

    // A bare key typed in a text field is text; the same key elsewhere is the shortcut.
    const field = document.createElement('input');
    document.body.append(field);
    expect(press('/', {}, field).defaultPrevented).toBe(false);
    expect(plain).not.toHaveBeenCalled();
    press('/');
    expect(plain).toHaveBeenCalledTimes(1);

    // A chord of a closed command is not run, and the engine's words are said aloud.
    press('2', { altKey: true, code: 'Digit2' });
    await settle(bed.fixture);
    expect(closed).not.toHaveBeenCalled();
    expect(live(bed.el)).toContain('Title of test.closed is not available');
    expect(live(bed.el)).toContain('not known');

    // A chord two commands share runs neither and says so.
    const clash = press('3', { altKey: true, code: 'Digit3' });
    await settle(bed.fixture);
    expect(clash.defaultPrevented).toBe(true);
    expect(live(bed.el)).toContain(
      'Alt+3 is assigned to more than one command',
    );
    expect(live(bed.el)).toContain('Title of test.dup.a, Title of test.dup.b');

    // Ctrl+K opens the palette even from a text field, and it opens once.
    field.focus();
    press('k', { ctrlKey: true }, field);
    await until(
      bed.fixture,
      () => document.querySelector('[role="dialog"]') !== null,
      'the palette',
    );
    expect(control.paletteOpen()).toBe(true);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);

    // While it is open no other shortcut runs; the same chord closes it.
    press('1', { altKey: true, code: 'Digit1' });
    expect(alpha).toHaveBeenCalledTimes(1);
    press('k', { ctrlKey: true }, field);
    await settle(bed.fixture);
    expect(control.paletteOpen()).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    // Another dialog owns the keyboard while it is open.
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.append(modal);
    press('1', { altKey: true, code: 'Digit1' });
    press('k', { ctrlKey: true });
    expect(alpha).toHaveBeenCalledTimes(1);
    expect(control.paletteOpen()).toBe(false);
    modal.remove();
    press('1', { altKey: true, code: 'Digit1' });
    expect(alpha).toHaveBeenCalledTimes(2);
    field.remove();
  });

  it('uses the person’s keymap from the engine and Cmd as Mod on macOS', async () => {
    const keybindings = new FakeKeybindings({
      'test.alpha': 'Mod+Alt+5',
      'palette.open': null,
    });
    const bed = await mountHost({ keybindings, platform: 'mac' });
    const registry = TestBed.inject(CommandRegistry);
    const alpha = vi.fn();
    registry.register(
      command('test.alpha', { keybinding: 'Alt+1', run: alpha }),
    );
    await settle(bed.fixture);

    // The override replaced the default; Ctrl is not Cmd; the palette's own chord was unbound by the person.
    press('1', { altKey: true, code: 'Digit1' });
    press('5', { altKey: true, ctrlKey: true, code: 'Digit5' });
    expect(alpha).not.toHaveBeenCalled();
    press('5', { altKey: true, metaKey: true, code: 'Digit5' });
    expect(alpha).toHaveBeenCalledTimes(1);
    press('k', { metaKey: true });
    expect(TestBed.inject(PaletteControl).paletteOpen()).toBe(false);
    expect(keybindings.gets).toBe(1);
  });
});
