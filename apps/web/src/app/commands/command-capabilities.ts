// The engine's capabilities for the commands (M1-41, OQ-828): the broker profile the status bar already reads,
// as the snapshot the registry closes commands with. `gates` and `allowedActions` are the engine's, as sent; a
// profile that is still loading, absent or not understood is a state of its own and never reads as "open".
import { computed, inject, type Provider } from '@angular/core';
import {
  COMMAND_CAPABILITIES,
  type CapabilitySnapshot,
} from '@app/ui-commands';

import { StatusSource } from '../shell/status-bar/status-source';

export function provideCommandCapabilities(): Provider {
  return {
    provide: COMMAND_CAPABILITIES,
    useFactory: () => {
      const source = inject(StatusSource);
      return computed((): CapabilitySnapshot => {
        const view = source.profile();
        if (view.status !== 'ready') return { status: view.status };
        return {
          status: 'ready',
          allowedActions: view.profile.allowedActions ?? [],
          gates: view.profile.gates,
        };
      });
    },
  };
}
