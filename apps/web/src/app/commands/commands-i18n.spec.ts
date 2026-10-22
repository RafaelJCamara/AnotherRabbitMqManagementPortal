import { TestBed } from '@angular/core/testing';
import {
  Announcer,
  CommandRegistry,
  providePaletteScope,
} from '@app/ui-commands';
import type { Translation } from '@jsverse/transloco';
import { describe, expect, it } from 'vitest';

import {
  StatusBackend,
  brokerProfileBody,
  connectionBody,
} from '../shell/status-bar/status-fixtures';
import { mountShell, until, visit } from '../shell/test-fixtures';
import { registerAppCommands } from './app-commands';
import { provideCommandCapabilities } from './command-capabilities';
import { COMMANDS_SCOPE_LOADER } from './commands-scope';
import en from './en.json';

function mark(tree: Translation, path: string): Translation {
  const out: Translation = {};
  for (const [name, value] of Object.entries(tree)) {
    const here = `${path}.${name}`;
    out[name] =
      typeof value === 'string'
        ? `[[${here}]]`
        : mark(value as Translation, here);
  }
  return out;
}

function leaves(tree: Translation, path: string): string[] {
  return Object.entries(tree).flatMap(([name, value]) =>
    typeof value === 'string'
      ? [`${path}.${name}`]
      : leaves(value as Translation, `${path}.${name}`),
  );
}

const MARKER = /\[\[(commands\.[A-Za-z0-9.-]+)\]\]/g;

describe('the strings of the app commands', () => {
  it('AC-13 every title, category and notice of the app commands is a key of its scope', async () => {
    const backend = new StatusBackend();
    for (const [cid, name] of [
      ['c1', 'One'],
      ['c2', 'Two'],
    ] as const) {
      backend.connections.set(cid, connectionBody(cid, name, 'dev'));
      backend.profiles.set(cid, brokerProfileBody(cid));
    }
    const bed = await mountShell(undefined, backend, undefined, [
      providePaletteScope(),
      provideCommandCapabilities(),
      {
        provide: COMMANDS_SCOPE_LOADER,
        useValue: () => Promise.resolve(mark(en as Translation, 'commands')),
      },
    ]);
    TestBed.runInInjectionContext(() => {
      registerAppCommands();
    });
    const registry = TestBed.inject(CommandRegistry);
    await visit(bed, '/c/c1/nope');
    await until(
      bed,
      () =>
        registry.commands().some((c) => c.id === 'connection.switch.c2') &&
        registry
          .commands()
          .filter(
            (c) =>
              !c.id.startsWith('inventory.') && !c.id.startsWith('overview.'),
          )
          .every((c) => c.title !== '' && c.category !== ''),
      'the commands',
    );
    // The notice of a switch that could not carry the page over.
    await registry.execute('connection.switch.c2');
    await until(
      bed,
      () => TestBed.inject(Announcer).latest()?.key === 'text',
      'the notice',
    );

    const spoken = (): string => {
      const text = TestBed.inject(Announcer).latest()?.params.text;
      return typeof text === 'string' ? text : '';
    };
    const seen = new Set<string>();
    const strings = [
      // The explorer's commands are the feature's own words (its scope and its coverage spec).
      ...registry
        .commands()
        .filter(
          (c) =>
            !c.id.startsWith('inventory.') && !c.id.startsWith('overview.'),
        )
        .flatMap((c) => [c.title, c.category]),
      spoken(),
    ];
    for (const text of strings) {
      const keys = [...text.matchAll(MARKER)].map((m) => m[1] ?? '');
      // Every title is a key of the scope (nothing else is written by hand), and the dynamic title is the key's text.
      expect(keys.length, text).toBeGreaterThan(0);
      for (const key of keys) seen.add(key);
    }
    expect(
      [...leaves(en as Translation, 'commands')].filter(
        (key) => !seen.has(key),
      ),
    ).toEqual([]);
  });
});
