// What the capability card reads from a profile (M0-54, R10, DC-31). The card renders the gates as the engine sent
// them and never computes authorisation: a gate is open only for `enabled === true`, and any other value or
// shape is closed. It reads each gate on its own, so one malformed gate is a closed row and not a card that
// cannot be drawn; a profile with no gates object at all is unknown, and unknown is never "available".
import { parseSourceLink } from '@app/ui-design';

/** The features the engine's gates name today; any other id is shown as the id. */
export const KNOWN_FEATURES: readonly string[] = [
  'streams.browse',
  'tap.firehose',
  'audit.event-exchange',
  'policies.operator-edit',
  'amqp.peek',
  'amqp.tap',
  'amqp.publish',
  'amqp.replay',
];

export interface CapabilityRow {
  readonly id: string;
  readonly known: boolean;
  /** `open` only for `enabled === true` without a degraded mode; `degraded` is open with limits. */
  readonly state: 'open' | 'degraded' | 'closed';
  /** The engine's reason as sent; `null` when it sent none. */
  readonly reason: string | null;
  /** The engine's source as sent, and a link only when it is an absolute https URL without credentials. */
  readonly source: string | null;
  readonly link: { readonly href: string; readonly host: string } | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** One row per gate of the profile, in id order; `null` when the profile has no readable gates (none is not "all open"). */
export function capabilityRows(profile: unknown): CapabilityRow[] | null {
  if (!isRecord(profile) || !isRecord(profile.gates)) return null;
  const gates = profile.gates;
  const rows = Object.keys(gates)
    .sort()
    .map((id): CapabilityRow => {
      const gate = gates[id];
      const decision = isRecord(gate) ? gate : {};
      const open = decision.enabled === true;
      const reason =
        typeof decision.reason === 'string' && decision.reason !== ''
          ? decision.reason
          : null;
      const source =
        typeof decision.source === 'string' && decision.source !== ''
          ? decision.source
          : null;
      return {
        id,
        known: KNOWN_FEATURES.includes(id),
        state: !open
          ? 'closed'
          : decision.mode === 'degraded'
            ? 'degraded'
            : 'open',
        // An open gate has nothing to explain; a closed or degraded one shows what the engine said.
        reason: open && decision.mode !== 'degraded' ? null : reason,
        source: open && decision.mode !== 'degraded' ? null : source,
        link:
          open && decision.mode !== 'degraded'
            ? null
            : parseSourceLink(source ?? undefined),
      };
    });
  return rows.length === 0 ? null : rows;
}
