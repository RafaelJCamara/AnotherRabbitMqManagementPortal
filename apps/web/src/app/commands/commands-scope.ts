// The Transloco scope of the app's commands (M1-41, OQ-829): the titles of the commands the shell and the app register.
// Bundled JSON loaded with `import()`; it is not one of the shell's `SCOPE_NAMES` (their key-coverage spec needs every
// key to appear in the shell's DOM), and it has its own coverage spec. The palette translates nothing of it: a command
// holds its title as text.
import { InjectionToken, inject } from '@angular/core';
import type { ProviderScope, Translation } from '@jsverse/transloco';

export const COMMANDS_SCOPE = 'commands';

/** Where the scope's JSON comes from. A spec replaces it to see which key a command asked for. */
export const COMMANDS_SCOPE_LOADER = new InjectionToken<
  () => Promise<Translation>
>('COMMANDS_SCOPE_LOADER', {
  providedIn: 'root',
  factory: () => () => import('./en.json').then((module) => module.default),
});

/** The scope definition for `scopedText` and `TranslocoService`. Call it in an injection context. */
export function commandsScope(): ProviderScope {
  const load = inject(COMMANDS_SCOPE_LOADER);
  return { scope: COMMANDS_SCOPE, loader: { en: () => load() } };
}
