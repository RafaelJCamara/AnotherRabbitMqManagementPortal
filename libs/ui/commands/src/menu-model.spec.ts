import { describe, expect, it, vi } from 'vitest';

import type { DisabledReason } from './availability';
import type { ListedCommand } from './command';
import { buildMenuModel, syncNativeMenu } from './menu-model';

const listed = (
  id: string,
  extra: Partial<ListedCommand> = {},
): ListedCommand => ({
  id,
  title: `Title ${id}`,
  category: 'Test',
  chords: [],
  defaults: [],
  chordSource: 'none',
  availability: { enabled: true },
  menu: undefined,
  bindable: true,
  ...extra,
});

const describeReason = (reason: DisabledReason): string =>
  `reason:${reason.kind}`;

describe('menu model', () => {
  it('M1-41 AC-12 native menus are generated from the registry', () => {
    const commands = [
      listed('no.menu', { chords: ['Mod+J'] }),
      listed('go.queues', {
        menu: { menu: 'go', order: 2 },
        chords: ['Mod+Alt+Q'],
      }),
      listed('go.overview', { menu: { menu: 'go', order: 1, group: 'pages' } }),
      listed('go.exchanges', {
        menu: { menu: 'go', order: 1, group: 'pages' },
      }),
      listed('go.add', {
        menu: { menu: 'go', order: 3, group: 'other' },
        availability: {
          enabled: false,
          reason: { kind: 'not-allowed', action: 'connections.create' },
        },
      }),
      listed('palette.open', {
        menu: { menu: 'view' },
        chords: ['Mod+K', 'F1'],
        title: 'Command palette',
      }),
    ];

    const model = buildMenuModel(commands, describeReason);

    // Only the commands that declare a menu appear, menus in the fixed order, an empty menu is dropped.
    expect(model.menus.map((menu) => menu.id)).toEqual(['view', 'go']);
    expect(JSON.stringify(model)).not.toContain('no.menu');
    // The accelerator is the first chord in force, in the desktop syntax.
    expect(model.menus[0]?.items).toEqual([
      {
        kind: 'command',
        id: 'palette.open',
        label: 'Command palette',
        accelerator: 'CmdOrCtrl+K',
        enabled: true,
      },
    ]);
    // Ordered by `order` then registry order; a change of group draws a separator; a closed command is
    // disabled with its reason in words, not removed.
    const go = model.menus[1]?.items ?? [];
    expect(
      go.map((item) => (item.kind === 'separator' ? '---' : item.id)),
    ).toEqual([
      'go.overview',
      'go.exchanges',
      '---',
      'go.queues',
      '---',
      'go.add',
    ]);
    expect(go.at(-1)).toEqual({
      kind: 'command',
      id: 'go.add',
      label: 'Title go.add',
      enabled: false,
      reason: 'reason:not-allowed',
    });
    expect(
      go.find((item) => item.kind === 'command' && item.id === 'go.queues'),
    ).toMatchObject({
      accelerator: 'CmdOrCtrl+Alt+Q',
    });

    // A browser bridge is never called; a desktop bridge gets the model and its menu commands run the registry's.
    const execute = vi.fn(() => Promise.resolve());
    const web = {
      kind: 'web' as const,
      setMenu: vi.fn(),
      onMenuCommand: vi.fn(() => () => undefined),
    };
    syncNativeMenu({ bridge: web, execute }, model)();
    expect(web.setMenu).not.toHaveBeenCalled();
    expect(web.onMenuCommand).not.toHaveBeenCalled();

    let deliver: (id: string) => void = () => undefined;
    const stop = vi.fn();
    const desktop = {
      kind: 'desktop' as const,
      setMenu: vi.fn(),
      onMenuCommand: vi.fn((listener: (id: string) => void) => {
        deliver = listener;
        return stop;
      }),
    };
    const unsubscribe = syncNativeMenu({ bridge: desktop, execute }, model);
    expect(desktop.setMenu).toHaveBeenCalledWith(model);
    deliver('go.queues');
    expect(execute).toHaveBeenCalledWith('go.queues');
    unsubscribe();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
