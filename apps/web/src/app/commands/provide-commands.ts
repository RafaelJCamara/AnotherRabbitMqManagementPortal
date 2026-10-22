// The command system of the web app (M1-41): the palette scope, the engine's capabilities for the commands, the
// app's own commands and the host, mounted once next to the app root. The host is created here and not written into
// `App`'s template so the root component keeps its one job (the router outlet) and the specs that mount `App` need
// nothing of the command system. It listens for shortcuts and draws the palette and the shortcuts dialog on demand.
import { DOCUMENT } from '@angular/common';
import {
  ApplicationRef,
  DestroyRef,
  EnvironmentInjector,
  createComponent,
  inject,
  makeEnvironmentProviders,
  provideEnvironmentInitializer,
  type EnvironmentProviders,
} from '@angular/core';
import { CommandHost, providePaletteScope } from '@app/ui-commands';

import { registerAppCommands } from './app-commands';
import { provideCommandCapabilities } from './command-capabilities';

export function mountCommandHost(): void {
  const document = inject(DOCUMENT);
  const appRef = inject(ApplicationRef);
  const environment = inject(EnvironmentInjector);
  const element = document.createElement('div');
  element.setAttribute('data-command-host', '');
  document.body.append(element);
  const host = createComponent(CommandHost, {
    environmentInjector: environment,
    hostElement: element,
  });
  appRef.attachView(host.hostView);
  inject(DestroyRef).onDestroy(() => {
    appRef.detachView(host.hostView);
    host.destroy();
    element.remove();
  });
}

export function provideCommands(): EnvironmentProviders {
  return makeEnvironmentProviders([
    providePaletteScope(),
    provideCommandCapabilities(),
    provideEnvironmentInitializer(() => {
      registerAppCommands();
      mountCommandHost();
    }),
  ]);
}
