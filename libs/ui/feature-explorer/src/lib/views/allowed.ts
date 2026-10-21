// Which view commands the engine says the caller may run (R8, Q-13): the gate of a command is built from
// the profile's `allowedActions` as sent. The UI never computes authorisation: an action that is not in
// the list, a list that is absent and a profile that is not known are all closed gates with a reason.
import type { GateDecision } from '@app/contracts';

import type { ProfileState } from '../profile/profile-store';
import type { Translate } from '../translate';

export type ViewCommand = 'views.create' | 'views.delete';

export function gateFor(
  commands: readonly ViewCommand[],
  profile: ProfileState,
  t: Translate,
): GateDecision {
  const allowed = profile.profile?.allowedActions;
  if (profile.status !== 'ready' || allowed === undefined) {
    return {
      enabled: false,
      reason: t(
        profile.status === 'loading'
          ? 'explorer.views.gate.loading'
          : 'explorer.views.gate.unknown',
      ),
    };
  }
  const missing = commands.find(
    (command) => !allowed.some((id) => id === command),
  );
  return missing === undefined
    ? { enabled: true }
    : { enabled: false, reason: t(`explorer.views.gate.denied.${missing}`) };
}
