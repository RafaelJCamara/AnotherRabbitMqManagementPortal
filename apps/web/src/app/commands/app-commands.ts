// The commands that belong to the whole app, not to a connection (M1-41, R14): add and manage connections, switch
// to another connection (one generated command per connection of the directory) and toggle the theme. They are
// registered once, for the life of the app. The directory is read when the palette is first opened (or when a page
// that lists connections has read it), so opening the app costs the engine nothing for them.
import { DestroyRef, computed, effect, inject } from '@angular/core';
import { Router } from '@angular/router';
import { ConnectionDirectory } from '@app/ui-data';
import {
  Announcer,
  CommandRegistry,
  PaletteControl,
  registerCommands,
  scopedText,
  type CommandDefinition,
} from '@app/ui-commands';
import { ThemeService } from '@app/ui-design';
import { TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';

import { ActiveConnection } from '../shell/active-connection';
import {
  ADDRESS_EXISTS,
  resolveSwitchTarget,
} from '../shell/connection-switcher/switch-target';
import { commandsScope } from './commands-scope';

export function registerAppCommands(): void {
  const router = inject(Router);
  const theme = inject(ThemeService);
  const directory = inject(ConnectionDirectory);
  const active = inject(ActiveConnection);
  const exists = inject(ADDRESS_EXISTS);
  const announcer = inject(Announcer);
  const transloco = inject(TranslocoService);
  const control = inject(PaletteControl);
  const scope = commandsScope();

  registerCommands([
    {
      id: 'connection.add',
      title: scopedText(scope, 'connection.add'),
      category: scopedText(scope, 'category.connection'),
      menu: { menu: 'file', order: 0, group: 'connection' },
      run: async (): Promise<void> => {
        await router.navigateByUrl('/connections/new');
      },
    },
    {
      id: 'connection.manage',
      title: scopedText(scope, 'connection.manage'),
      category: scopedText(scope, 'category.connection'),
      menu: { menu: 'file', order: 1, group: 'connection' },
      run: async (): Promise<void> => {
        await router.navigateByUrl('/connections');
      },
    },
    {
      id: 'view.toggle-theme',
      title: scopedText(scope, 'theme.toggle'),
      category: scopedText(scope, 'category.view'),
      menu: { menu: 'view', order: 10 },
      run: (): void => {
        theme.setPreference(theme.resolved() === 'dark' ? 'light' : 'dark');
      },
    },
  ]);

  // The connections the person has: read once the palette is first opened.
  effect(() => {
    if (control.paletteOpen()) directory.ensureLoaded();
  });

  const template = scopedText(scope, 'switch.title');
  const connectionCategory = scopedText(scope, 'category.connection');
  const switchTo = async (cid: string, name: string): Promise<void> => {
    const target = await resolveSwitchTarget({
      currentUrl: router.url,
      toCid: cid,
      exists,
    });
    await router.navigateByUrl(target.url);
    if (target.missing !== null) {
      // The page could not be carried over: say so, as the switcher does with its notice.
      const text = await firstValueFrom(
        transloco.selectTranslate<string>(
          'switch.missing',
          { name, address: target.missing },
          scope,
        ),
      );
      announcer.say('text', { text });
    }
  };
  const switches = computed((): readonly CommandDefinition[] =>
    directory
      .items()
      .filter((profile) => profile.id !== active.cid())
      .map((profile) => ({
        id: `connection.switch.${profile.id}`,
        title: () => template().replace('{name}', profile.name),
        category: connectionCategory,
        bindable: false,
        run: () => switchTo(profile.id, profile.name),
      })),
  );
  const registry = inject(CommandRegistry);
  const stop = registry.registerSource(switches);
  inject(DestroyRef).onDestroy(stop);
}
