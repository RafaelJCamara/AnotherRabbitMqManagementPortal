// The lock segment of the status bar, from what the person has done on this page (M0-52, R5, AC-10). No action
// returns the arming state (OQ-530), so the source is the `ArmingStore`: the active connection reads `armed` while
// the window its own `ops.arm` was answered with is open, and `locked` otherwise, which is also what it reads after a
// reload (fail closed). It displays an engine decision; the engine still refuses a locked call.
import { computed, inject, type Provider, type Signal } from '@angular/core';
import { ArmingStore } from '@app/ui-data';

import { ActiveConnection } from '../active-connection';
import { LOCK_STATE, type LockState } from './status-source';

export function provideLockState(): Provider {
  return {
    provide: LOCK_STATE,
    useFactory: (): Signal<LockState> => {
      const connection = inject(ActiveConnection);
      const arming = inject(ArmingStore);
      return computed((): LockState => {
        const cid = connection.cid();
        return cid !== null && arming.armed(cid)() ? 'armed' : 'locked';
      });
    },
  };
}
