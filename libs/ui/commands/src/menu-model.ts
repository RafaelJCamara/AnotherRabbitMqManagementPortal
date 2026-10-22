// The native menu model (M1-41, R13): a typed tree built from the registry, the same commands the
// palette lists. The desktop shell will hand it to `PlatformBridge.setMenu` (M2-P14); the browser never
// does. This file holds no Electron code: it only says which commands go in which menu, with which
// accelerator, and which are closed and why.
import type { PlatformBridge } from '@app/contracts';

import { acceleratorOf, parseChord } from './chord';
import type { ListedCommand, MenuName } from './command';
import type { DisabledReason } from './availability';

export interface MenuCommandItem {
  readonly kind: 'command';
  readonly id: string;
  readonly label: string;
  /** Desktop accelerator syntax (`CmdOrCtrl+K`) of the first chord in force. */
  readonly accelerator?: string;
  readonly enabled: boolean;
  /** Why it is closed, in words, when it is. */
  readonly reason?: string;
}

export interface MenuSeparatorItem {
  readonly kind: 'separator';
}

export type MenuItem = MenuCommandItem | MenuSeparatorItem;

export interface MenuModel {
  readonly menus: readonly {
    readonly id: MenuName;
    readonly items: readonly MenuItem[];
  }[];
}

const MENU_ORDER: readonly MenuName[] = ['file', 'view', 'go', 'help'];

/**
 * Builds the menus from the commands that declare one. Items are ordered by `menu.order` and then by
 * the registry's order; a change of `menu.group` draws a separator; a closed command stays in the menu,
 * disabled, with its reason in words (`describe`); a menu with no item is left out.
 */
export function buildMenuModel(
  commands: readonly ListedCommand[],
  describe: (reason: DisabledReason) => string,
): MenuModel {
  const menus: { id: MenuName; items: MenuItem[] }[] = [];
  for (const name of MENU_ORDER) {
    const entries = commands
      .map((command, index) => ({ command, index }))
      .filter((entry) => entry.command.menu?.menu === name)
      .sort(
        (a, b) =>
          (a.command.menu?.order ?? 0) - (b.command.menu?.order ?? 0) ||
          a.index - b.index,
      );
    if (entries.length === 0) continue;
    const items: MenuItem[] = [];
    let group: string | undefined;
    for (const { command } of entries) {
      const next = command.menu?.group;
      if (items.length > 0 && next !== group) items.push({ kind: 'separator' });
      group = next;
      const chord =
        command.chords[0] === undefined ? null : parseChord(command.chords[0]);
      items.push({
        kind: 'command',
        id: command.id,
        label: command.title,
        ...(chord === null ? {} : { accelerator: acceleratorOf(chord) }),
        enabled: command.availability.enabled,
        ...(command.availability.enabled
          ? {}
          : { reason: describe(command.availability.reason) }),
      });
    }
    menus.push({ id: name, items });
  }
  return { menus };
}

/** What a desktop shell needs from the registry to keep its menu: the bridge and a way to run a command. */
export interface NativeMenuHost {
  readonly bridge: Pick<PlatformBridge, 'kind' | 'setMenu' | 'onMenuCommand'>;
  execute(id: string): Promise<unknown>;
}

/**
 * Hands a model to the desktop shell and routes its menu commands to the registry. The browser has no
 * native menu, so a `web` bridge is never called. Returns the function that stops listening.
 */
export function syncNativeMenu(
  host: NativeMenuHost,
  model: MenuModel,
): () => void {
  if (host.bridge.kind !== 'desktop') return () => undefined;
  host.bridge.setMenu(model);
  return host.bridge.onMenuCommand((id) => {
    void host.execute(id);
  });
}
