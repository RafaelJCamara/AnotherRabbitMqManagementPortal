// Whether a command can run now (M1-41, R5). The UI never computes authorisation: it looks a name up
// in what the engine sent (`gates` and `allowedActions` of the broker profile) and shows the engine's
// reason as sent. A name the engine did not send, a profile that is still loading and a profile that
// failed are all closed, each with its own words.
import { InjectionToken, signal, type Signal } from '@angular/core';
import type { GateDecision } from '@app/contracts';

import type { CommandDefinition } from './command';

/** What the engine said about the connection in view. */
export interface CapabilitySnapshot {
  /** `none`: no connection in view; `unknown`: the profile could not be read or does not parse. */
  readonly status: 'none' | 'loading' | 'unknown' | 'ready';
  /** Every registered action the caller may call (deny by default). */
  readonly allowedActions?: readonly string[];
  readonly gates?: Readonly<Record<string, GateDecision>>;
}

export const NO_CAPABILITIES: CapabilitySnapshot = { status: 'none' };

/** Provided by the app from the broker profile it already reads; the default knows nothing. */
export const COMMAND_CAPABILITIES = new InjectionToken<
  Signal<CapabilitySnapshot>
>('COMMAND_CAPABILITIES', {
  providedIn: 'root',
  factory: () => signal(NO_CAPABILITIES).asReadonly(),
});

export type DisabledReason =
  /** The engine closed a gate: its reason and source, as sent (either may be empty). */
  | { readonly kind: 'gate'; readonly reason: string; readonly source?: string }
  /** The engine's list of allowed actions does not have it. */
  | { readonly kind: 'not-allowed'; readonly action: string }
  | { readonly kind: 'loading' }
  | { readonly kind: 'unknown' }
  /** The feature's own reason, already in words. */
  | { readonly kind: 'own'; readonly text: string };

export type Availability =
  | { readonly enabled: true }
  | { readonly enabled: false; readonly reason: DisabledReason };

const OPEN: Availability = { enabled: true };

const closed = (reason: DisabledReason): Availability => ({
  enabled: false,
  reason,
});

function notReady(snapshot: CapabilitySnapshot): Availability | null {
  if (snapshot.status === 'ready') return null;
  return closed({
    kind: snapshot.status === 'loading' ? 'loading' : 'unknown',
  });
}

function decisionOf(decision: GateDecision | null | undefined): Availability {
  if (decision?.enabled === true) return OPEN;
  const source = decision?.source;
  return closed({
    kind: 'gate',
    reason: decision?.reason ?? '',
    ...(source === undefined ? {} : { source }),
  });
}

/**
 * The availability of a command. Checked in this order, and the first that closes it decides: its gate,
 * its action, then the feature's own reason. A command with none of the three is open (navigation needs
 * no permission), even while the profile is unknown.
 */
export function availabilityOf(
  def: Pick<CommandDefinition, 'action' | 'gate' | 'unavailable'>,
  snapshot: CapabilitySnapshot,
): Availability {
  const { gate, action, unavailable } = def;
  if (gate !== undefined) {
    if (typeof gate === 'string') {
      const waiting = notReady(snapshot);
      if (waiting !== null) return waiting;
      const decision = snapshot.gates?.[gate];
      const result = decisionOf(decision);
      if (!result.enabled)
        return decision === undefined ? closed({ kind: 'unknown' }) : result;
    } else {
      const result = decisionOf(gate());
      if (!result.enabled) return result;
    }
  }
  if (action !== undefined) {
    const waiting = notReady(snapshot);
    if (waiting !== null) return waiting;
    if (snapshot.allowedActions?.includes(action) !== true) {
      return closed({ kind: 'not-allowed', action });
    }
  }
  const own = unavailable?.() ?? null;
  return own === null ? OPEN : closed({ kind: 'own', text: own });
}
