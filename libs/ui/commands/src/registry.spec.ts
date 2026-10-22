import {
  EnvironmentInjector,
  createEnvironmentInjector,
  runInInjectionContext,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { Announcer } from './announcer';
import type { CommandDefinition } from './command';
import { CommandContext } from './context';
import { CommandRegistry, Keymap, registerCommands } from './registry';

const command = (
  id: string,
  extra: Partial<CommandDefinition> = {},
): CommandDefinition => ({
  id,
  title: id,
  category: 'Test',
  run: () => undefined,
  ...extra,
});

describe('CommandRegistry', () => {
  it('AC-4 registrations stack, dispose and follow their context', () => {
    const registry = TestBed.inject(CommandRegistry);
    const context = TestBed.inject(CommandContext);
    const ids = () => registry.commands().map((c) => c.id);

    // Sorted by category, then title.
    registry.register(
      command('b.second', { title: 'Zebra', category: 'Beta' }),
    );
    registry.register(command('a.first', { title: 'Yak', category: 'Alpha' }));
    registry.register(command('a.other', { title: 'Ant', category: 'Alpha' }));
    expect(ids()).toEqual(['a.other', 'a.first', 'b.second']);

    // The latest registration of an id wins; disposing it restores the one below.
    const oldRun = vi.fn();
    const newRun = vi.fn();
    registry.register(command('stacked', { title: 'Old', run: oldRun }));
    const disposeNew = registry.register(
      command('stacked', { title: 'New', run: newRun }),
    );
    expect(registry.commands().find((c) => c.id === 'stacked')?.title).toBe(
      'New',
    );
    expect(registry.commands().filter((c) => c.id === 'stacked')).toHaveLength(
      1,
    );
    disposeNew();
    expect(registry.commands().find((c) => c.id === 'stacked')?.title).toBe(
      'Old',
    );
    disposeNew(); // disposing twice is harmless
    expect(registry.commands().filter((c) => c.id === 'stacked')).toHaveLength(
      1,
    );

    // A `when` hides the command while it is false and follows the context key.
    registry.register(
      command('only.on.queues', {
        when: (get) => get('explorer.page') === 'queues',
      }),
    );
    expect(ids()).not.toContain('only.on.queues');
    const end = context.provide('explorer.page', 'queues');
    expect(ids()).toContain('only.on.queues');
    context.provide('explorer.page', 'exchanges'); // a page that opened later
    expect(ids()).not.toContain('only.on.queues');
    end(); // the first page closing does not clear the later page's value
    expect(context.get('explorer.page')).toBe('exchanges');

    // Titles that read a signal follow it.
    const language = signal('Open');
    registry.register(command('lang', { title: () => language() }));
    expect(registry.commands().find((c) => c.id === 'lang')?.title).toBe(
      'Open',
    );
    language.set('Abrir');
    expect(registry.commands().find((c) => c.id === 'lang')?.title).toBe(
      'Abrir',
    );

    // A generated list is added and removed as a whole; a registered command with the same id wins over it.
    const generated = signal<readonly CommandDefinition[]>([
      command('connection.switch.c1', {
        bindable: false,
        title: 'Switch to one',
      }),
      command('stacked', { title: 'Generated' }),
    ]);
    const dropSource = registry.registerSource(generated);
    expect(ids()).toContain('connection.switch.c1');
    expect(registry.commands().find((c) => c.id === 'stacked')?.title).toBe(
      'Old',
    );
    generated.set([]);
    expect(ids()).not.toContain('connection.switch.c1');
    dropSource();

    // An id the engine could not keep a keybinding under is refused when the command can be bound.
    expect(() => registry.register(command('Bad Id'))).toThrow(RangeError);
    expect(() =>
      registry.register(command('Bad Id', { bindable: false })),
    ).not.toThrow();
  });

  it('removes what a component registered when it is destroyed', () => {
    const registry = TestBed.inject(CommandRegistry);
    // `registerCommands` ties the registrations to the DestroyRef of the injection context it runs in.
    const page = createEnvironmentInjector(
      [],
      TestBed.inject(EnvironmentInjector),
    );
    runInInjectionContext(page, () => {
      registerCommands([command('page.one'), command('page.two')]);
    });
    expect(registry.commands().map((c) => c.id)).toEqual([
      'page.one',
      'page.two',
    ]);
    page.destroy();
    expect(registry.commands()).toEqual([]);
  });

  it('runs a listed, open command; reports one that throws; and ignores an unknown id', async () => {
    const registry = TestBed.inject(CommandRegistry);
    const announcer = TestBed.inject(Announcer);
    const ran = vi.fn();
    registry.register(command('works', { run: ran }));
    registry.register(
      command('throws', {
        title: 'Throws',
        run: () => {
          throw new Error('boom');
        },
      }),
    );
    registry.register(
      command('rejects', {
        title: 'Rejects',
        run: () => Promise.reject(new Error('no')),
      }),
    );
    registry.register(command('hidden', { when: () => false, run: ran }));

    expect(await registry.execute('works')).toEqual({ status: 'ran' });
    expect(ran).toHaveBeenCalledTimes(1);
    expect(await registry.execute('unknown.id')).toEqual({ status: 'unknown' });
    expect(await registry.execute('hidden')).toEqual({ status: 'unknown' });
    expect(ran).toHaveBeenCalledTimes(1);

    const thrown = await registry.execute('throws');
    expect(thrown.status).toBe('failed');
    expect(announcer.latest()).toMatchObject({
      key: 'failed',
      params: { title: 'Throws' },
    });
    expect((await registry.execute('rejects')).status).toBe('failed');
    // The registry is still usable after a failure.
    expect(await registry.execute('works')).toEqual({ status: 'ran' });
  });

  it('lists the chords in force from the defaults and the overrides', () => {
    const registry = TestBed.inject(CommandRegistry);
    const keymap = TestBed.inject(Keymap);
    registry.register(
      command('palette.open', { keybinding: ['ctrl+k', 'F1'] }),
    );
    registry.register(command('plain'));
    const chordsOf = (id: string) =>
      registry.commands().find((c) => c.id === id);

    expect(chordsOf('palette.open')).toMatchObject({
      chords: ['Ctrl+K', 'F1'],
      chordSource: 'default',
    });
    expect(chordsOf('plain')).toMatchObject({
      chords: [],
      chordSource: 'none',
    });
    keymap.set({ 'palette.open': 'Mod+Alt+P' });
    expect(chordsOf('palette.open')).toMatchObject({
      chords: ['Mod+Alt+P'],
      chordSource: 'user',
      defaults: ['Ctrl+K', 'F1'],
    });
    keymap.set({ 'palette.open': null });
    expect(chordsOf('palette.open')).toMatchObject({
      chords: [],
      chordSource: 'user',
    });
  });
});
