// The connection budget of one broker (A-10, blueprint 5.3). Pure: the limits come from the
// capability probe (`BrokerProfile.limits`) and from the provider preset, and this file turns them
// into a cap on the tool's own connections and a cap per role. The manager enforces the result.
import type { ConnectionRole } from '@app/ports';

/** The roles that hold a connection of their own. `control` is the HTTP pool and holds none. */
export type LeaseRole = Exclude<ConnectionRole, 'control'>;

export const LEASE_ROLES: readonly LeaseRole[] = [
  'peek',
  'source',
  'publish',
  'observe',
];

/** The broker's limits as the probe reports them; every one may be unknown. */
export interface BrokerLimits {
  connectionMax?: number | undefined;
  channelMax?: number | undefined;
  consumersPerChannelMax?: number | undefined;
}

/** What the composition root knows about a broker: probed limits plus the provider preset. */
export interface BrokerBudgetInput {
  limits: BrokerLimits;
  /** A preset's cap on the tool's own connections: 2 or 3 on a tight preset (A-10). */
  toolConnectionCap?: number | undefined;
  /** A preset's cap per role and vhost. */
  roleMax?: Partial<Record<LeaseRole, number>> | undefined;
}

export interface ResolvedBudget {
  /** The tool's own connections to the broker, all vhosts and roles together. */
  readonly toolMax: number;
  /** Per vhost and role. */
  readonly roleMax: Readonly<Record<LeaseRole, number>>;
  readonly brokerMax: number | null;
}

/** The tool's cap when nothing says otherwise. */
export const DEFAULT_TOOL_CONNECTION_CAP = 12;
export const MIN_TOOL_CONNECTION_CAP = 2;
/** Per vhost and role, when no preset says otherwise. */
export const DEFAULT_ROLE_MAX: Readonly<Record<LeaseRole, number>> = {
  peek: 2,
  source: 2,
  publish: 2,
  observe: 8,
};

function whole(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : undefined;
}

/**
 * - The tool's cap is the preset's, else a quarter of the broker's `connection_max` (at least 2,
 *   at most 12), else 12 when the broker's limit is unknown. It never exceeds `connection_max`.
 * - A role's cap is the preset's, else the default, and never exceeds the tool's cap.
 * - `observe` is held to `consumers_per_channel` (10 on Amazon MQ 4.x) when the broker states one:
 *   a tap is one consumer, and the adapter may carry several taps on a channel one day, so the
 *   count of taps never passes what one channel may hold (OQ-370).
 */
export function deriveBudget(input: BrokerBudgetInput): ResolvedBudget {
  const connectionMax = whole(input.limits.connectionMax);
  const preset = whole(input.toolConnectionCap);
  let toolMax =
    preset ??
    (connectionMax === undefined
      ? DEFAULT_TOOL_CONNECTION_CAP
      : Math.min(
          DEFAULT_TOOL_CONNECTION_CAP,
          Math.max(MIN_TOOL_CONNECTION_CAP, Math.floor(connectionMax / 4)),
        ));
  if (connectionMax !== undefined) toolMax = Math.min(toolMax, connectionMax);
  const perChannel = whole(input.limits.consumersPerChannelMax);
  const cap = (role: LeaseRole): number => {
    const own = whole(input.roleMax?.[role]);
    const base =
      own ??
      (role === 'observe' && perChannel !== undefined
        ? perChannel
        : DEFAULT_ROLE_MAX[role]);
    const bounded =
      role === 'observe' && perChannel !== undefined
        ? Math.min(base, perChannel)
        : base;
    return Math.min(bounded, toolMax);
  };
  return {
    toolMax,
    roleMax: {
      peek: cap('peek'),
      source: cap('source'),
      publish: cap('publish'),
      observe: cap('observe'),
    },
    brokerMax: connectionMax ?? null,
  };
}
