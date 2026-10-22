import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { ThemeService } from '@app/ui-design';
import {
  Announcer,
  CommandRegistry,
  providePaletteScope,
  reservedCollisions,
} from '@app/ui-commands';
import { describe, expect, it } from 'vitest';

import { ShellLayoutStore } from '../shell/layout/shell-layout-store';
import {
  StatusBackend,
  brokerProfileBody,
  connectionBody,
} from '../shell/status-bar/status-fixtures';
import { mountShell, until, visit } from '../shell/test-fixtures';
import { registerAppCommands } from './app-commands';
import { provideCommandCapabilities } from './command-capabilities';

function backendWith(): StatusBackend {
  const backend = new StatusBackend();
  for (const [cid, name, env] of [
    ['c1', 'Staging cluster', 'staging'],
    ['c2', 'Orders prod', 'prod'],
    ['c3', 'Lab', 'dev'],
  ] as const) {
    backend.connections.set(cid, connectionBody(cid, name, env));
    backend.profiles.set(cid, brokerProfileBody(cid));
  }
  return backend;
}

const titleOf = (id: string): string | undefined =>
  TestBed.inject(CommandRegistry)
    .commands()
    .find((command) => command.id === id)?.title;

describe('the commands of the app and the shell', () => {
  it('AC-14 the shell commands act through the existing services', async () => {
    const bed = await mountShell(undefined, backendWith(), undefined, [
      providePaletteScope(),
      provideCommandCapabilities(),
    ]);
    TestBed.runInInjectionContext(() => {
      registerAppCommands();
    });
    const registry = TestBed.inject(CommandRegistry);
    const router = TestBed.inject(Router);
    const ids = (): string[] => registry.commands().map((c) => c.id);

    // With no connection in view the app's commands are listed and the connection-bound ones are not.
    await visit(bed, '/');
    await until(
      bed,
      () => titleOf('connection.add') === 'Add a connection',
      'the app commands',
    );
    expect(ids()).toEqual(
      expect.arrayContaining([
        'connection.add',
        'connection.manage',
        'view.toggle-theme',
      ]),
    );
    expect(
      ids().filter(
        (id) =>
          id.startsWith('go.explorer.') ||
          id === 'connection.check-capabilities',
      ),
    ).toEqual([]);

    // With a connection in view the five explorer pages and the capability check are listed, once translated.
    await visit(bed, '/c/c1/explorer');
    await until(
      bed,
      () => titleOf('go.explorer.queues') === 'Go to queues',
      'the shell commands',
    );
    expect(
      ids()
        .filter((id) => id.startsWith('go.explorer.'))
        .sort(),
    ).toEqual([
      'go.explorer.bindings',
      'go.explorer.connections',
      'go.explorer.exchanges',
      'go.explorer.overview',
      'go.explorer.queues',
    ]);
    expect(ids()).toContain('connection.check-capabilities');

    // Go to queues: the tab is opened through the tab service and the page is shown.
    expect((await registry.execute('go.explorer.queues')).status).toBe('ran');
    await until(
      bed,
      () => router.url === '/c/c1/explorer/queues',
      'the page to open',
    );
    const tabs = TestBed.inject(ShellLayoutStore)
      .layout()
      .editor.groups.flatMap((group) => group.tabs);
    expect(tabs.map((tab) => tab.url)).toContain('/c/c1/explorer/queues');
    expect(tabs.find((tab) => tab.url === '/c/c1/explorer/queues')?.label).toBe(
      '[[shell.tree.kind.queues]]',
    );

    // Switch to another connection: one command per connection but the active one, carrying the page over.
    await until(
      bed,
      () => titleOf('connection.switch.c2') === 'Switch to Orders prod',
      'the connections',
    );
    expect(
      ids()
        .filter((id) => id.startsWith('connection.switch.'))
        .sort(),
    ).toEqual(['connection.switch.c2', 'connection.switch.c3']);
    expect((await registry.execute('connection.switch.c2')).status).toBe('ran');
    expect(router.url).toBe('/c/c2/explorer/queues');
    await until(
      bed,
      () => ids().includes('connection.switch.c1'),
      'the old connection to be offered',
    );
    expect(ids()).not.toContain('connection.switch.c2');

    // An address the other connection does not have: the explorer opens instead and the palette says so.
    await visit(bed, '/c/c2/nope');
    await registry.execute('connection.switch.c3');
    expect(router.url).toBe('/c/c3/explorer');
    await until(
      bed,
      () => TestBed.inject(Announcer).latest()?.key === 'text',
      'the notice',
    );
    expect(TestBed.inject(Announcer).latest()?.params.text).toBe(
      'Lab does not have /nope. The explorer of Lab is open instead.',
    );

    // Add, manage and check the capabilities go to the pages that do those things.
    await registry.execute('connection.check-capabilities');
    expect(router.url).toBe('/connections/c3');
    await registry.execute('connection.add');
    expect(router.url).toBe('/connections/new');
    await registry.execute('connection.manage');
    expect(router.url).toBe('/connections');

    // Toggle the theme.
    const theme = TestBed.inject(ThemeService);
    const before = theme.resolved();
    await registry.execute('view.toggle-theme');
    expect(theme.resolved()).toBe(before === 'dark' ? 'light' : 'dark');
    await registry.execute('view.toggle-theme');
    expect(theme.resolved()).toBe(before === 'dark' ? 'dark' : 'light');
  });

  it('AC-3 no default binding collides with the reserved-chord list', async () => {
    const bed = await mountShell(undefined, backendWith(), undefined, [
      providePaletteScope(),
      provideCommandCapabilities(),
    ]);
    TestBed.runInInjectionContext(() => {
      registerAppCommands();
    });
    await visit(bed, '/c/c1/explorer');
    await until(
      bed,
      () => titleOf('go.explorer.queues') === 'Go to queues',
      'the shell commands',
    );
    const { EXPLORER_DEFAULT_CHORDS } = await import('@app/feature-explorer');

    // The defaults of everything registered here (the app's and the shell's) and of the explorer's pages.
    const defaults = [
      ...TestBed.inject(CommandRegistry)
        .commands()
        .flatMap((command) => command.defaults),
      ...EXPLORER_DEFAULT_CHORDS,
    ];
    expect(reservedCollisions(defaults)).toEqual([]);
    // The check is not vacuous: a browser's own chord, and the private-window chord, are reported.
    expect(
      reservedCollisions([...defaults, 'Mod+T', 'Mod+Shift+P']).map(
        (hit) => hit.chord,
      ),
    ).toEqual(['Mod+T', 'Mod+Shift+P']);
  });
});
