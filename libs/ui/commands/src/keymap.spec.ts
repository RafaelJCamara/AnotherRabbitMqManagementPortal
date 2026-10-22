import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type { CommandDefinition } from './command';
import { CommandContext } from './context';
import {
  bindingTable,
  defaultChords,
  effectiveChords,
  findConflicts,
  planAssign,
  withUnbound,
  withoutOverride,
} from './keymap';
import { CommandRegistry, Keymap } from './registry';

const owner = (id: string, ...chords: string[]) => ({ id, chords });

describe('keymap', () => {
  it('AC-6 the keymap merges overrides and reports every conflict', () => {
    // Defaults are canonical text; one that is not a chord is dropped.
    expect(defaultChords(['ctrl+k', 'nonsense+', 'F1'])).toEqual([
      'Ctrl+K',
      'F1',
    ]);
    expect(defaultChords(undefined)).toEqual([]);
    expect(defaultChords('/')).toEqual(['/']);

    // An override replaces every default; null unbinds; an unparseable one binds nothing; no override keeps the defaults.
    const defaults = ['Mod+K', 'F1'];
    const overrides = {
      a: 'mod+shift+j',
      b: null,
      c: '??',
      d: 'Alt+1',
      gone: 'Mod+Alt+9',
    };
    expect(effectiveChords('a', defaults, overrides)).toEqual({
      chords: ['Mod+Shift+J'],
      source: 'user',
    });
    expect(effectiveChords('b', defaults, overrides)).toEqual({
      chords: [],
      source: 'user',
    });
    expect(effectiveChords('c', defaults, overrides)).toEqual({
      chords: [],
      source: 'user',
    });
    expect(effectiveChords('e', defaults, overrides)).toEqual({
      chords: defaults,
      source: 'default',
    });
    expect(effectiveChords('e', [], overrides)).toEqual({
      chords: [],
      source: 'none',
    });

    // Conflicts among the commands listed now: duplicates, reserved chords and overrides that are not chords.
    const owners = [
      owner('one', 'Mod+K'),
      owner('two', 'Mod+K', 'Alt+2'),
      owner('three', 'Mod+T'),
      owner('four', 'F2'),
    ];
    const conflicts = findConflicts(owners, { broken: 'Mod+' });
    expect(conflicts).toEqual([
      { kind: 'duplicate', chord: 'Mod+K', ids: ['one', 'two'] },
      {
        kind: 'reserved',
        chord: 'Mod+T',
        ids: ['three'],
        reserved: { chord: 'Mod+T', kind: 'browser' },
      },
      { kind: 'invalid', chord: 'Mod+', ids: ['broken'] },
    ]);
    // A chord in conflict is bound to nothing; the others still are.
    const table = bindingTable(owners, conflicts);
    expect([...table]).toEqual([
      ['Alt+2', 'two'],
      ['F2', 'four'],
    ]);

    // Assigning: refused with the reason when invalid, reserved or taken; nothing is changed by a refusal.
    expect(planAssign(owners, {}, 'four', 'Mod+')).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(planAssign(owners, {}, 'four', 'ctrl+n')).toEqual({
      ok: false,
      reason: 'reserved',
      reserved: { chord: 'Mod+N', kind: 'browser' },
    });
    expect(planAssign(owners, {}, 'four', 'alt+2')).toEqual({
      ok: false,
      reason: 'conflict',
      with: ['two'],
    });
    // A free chord is saved canonically, next to the overrides already there.
    expect(
      planAssign(owners, { keep: 'Alt+9' }, 'four', 'mod+shift+f'),
    ).toEqual({
      ok: true,
      overrides: { keep: 'Alt+9', four: 'Mod+Shift+F' },
      unbound: [],
    });
    // Replacing takes the chord from the other command in the same document.
    expect(planAssign(owners, {}, 'four', 'alt+2', { replace: true })).toEqual({
      ok: true,
      overrides: { four: 'Alt+2', two: null },
      unbound: ['two'],
    });
    // A command may be given the chord it already has.
    expect(planAssign(owners, {}, 'two', 'alt+2')).toMatchObject({ ok: true });
    // The document has a size limit.
    const full = Object.fromEntries(
      Array.from({ length: 500 }, (_, n) => [`c${String(n)}`, 'Alt+1']),
    );
    expect(planAssign(owners, full, 'four', 'Alt+3')).toEqual({
      ok: false,
      reason: 'too-many',
    });
    expect(withUnbound({ x: 'Alt+1' }, 'y')).toEqual({ x: 'Alt+1', y: null });
    expect(withoutOverride({ x: 'Alt+1', y: null }, 'x')).toEqual({ y: null });

    // Through the registry: two commands listed together on one chord are in conflict, and when one is not
    // listed (its `when` is false) they are not.
    const registry = TestBed.inject(CommandRegistry);
    const context = TestBed.inject(CommandContext);
    const make = (
      id: string,
      extra: Partial<CommandDefinition>,
    ): CommandDefinition => ({
      id,
      title: id,
      category: 'Test',
      keybinding: 'Alt+7',
      run: () => undefined,
      ...extra,
    });
    registry.register(make('page.a', { when: (get) => get('page') === 'a' }));
    registry.register(make('page.b', { when: (get) => get('page') === 'b' }));
    registry.register(make('always', {}));
    context.set('page', 'a');
    expect(registry.conflicts()).toEqual([
      { kind: 'duplicate', chord: 'Alt+7', ids: ['always', 'page.a'] },
    ]);
    expect(registry.bindings().has('Alt+7')).toBe(false);
    TestBed.inject(Keymap).set({ always: 'Alt+8' });
    expect(registry.conflicts()).toEqual([]);
    expect(registry.bindings().get('Alt+7')).toBe('page.a');
    expect(registry.bindings().get('Alt+8')).toBe('always');
  });
});
