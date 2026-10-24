// What every action starts with: the connection must be visible to the caller, its profile must be
// cached, and the vhost is read (or taken from a snapshot a few seconds old).
import type { ConnectionId } from '@app/contracts';
import type { BrokerProfile } from '@app/domain-model';

import { DEFAULT_TOPOLOGY_LIMITS, type TopologyModuleDeps } from '../deps';

import { nextLoopTurn } from './cooperative';
import { readProfile } from './profile';
import type { RoutingInput } from './to-routing';
import { toRoutingTopology } from './to-routing';
import type { Snapshot, SnapshotReader } from './snapshot';
import { requireVisible } from './visible';

/** The ports every action reads through: a subset of the module's deps (src/deps.ts) and the reader. */
export interface ActionDeps extends Pick<
  TopologyModuleDeps,
  'connections' | 'profiles' | 'limits' | 'yieldNow'
> {
  readonly snapshots: SnapshotReader;
}

/** The part of the execution context an action reads. */
export interface CallContext {
  readonly principal: { readonly id: string };
  readonly signal: AbortSignal;
}

export interface Loaded {
  readonly profile: BrokerProfile;
  readonly snapshot: Snapshot;
}

export async function loadVhost(
  deps: ActionDeps,
  input: {
    readonly cid: ConnectionId;
    readonly vhost: string;
    readonly refresh?: boolean | undefined;
  },
  ctx: CallContext,
): Promise<Loaded> {
  await requireVisible(deps.connections, input.cid, ctx.principal.id);
  const profile = await readProfile(deps.profiles, input.cid);
  const snapshot = await deps.snapshots.read(
    input.cid,
    input.vhost,
    ctx.signal,
    input.refresh === true ? { refresh: true } : {},
  );
  return { profile, snapshot };
}

/** The vhost as the routing library takes it, converted in turns of the event loop. */
export function routingInput(
  deps: ActionDeps,
  loaded: Loaded,
): Promise<RoutingInput> {
  return toRoutingTopology(loaded.snapshot, loaded.profile, {
    yieldNow: deps.yieldNow ?? nextLoopTurn,
    every:
      deps.limits?.yieldEveryItems ?? DEFAULT_TOPOLOGY_LIMITS.yieldEveryItems,
  });
}

/** The figures of a snapshot that ride in every answer (I-13). */
export function snapshotMeta(snapshot: Snapshot) {
  return {
    takenAt: snapshot.takenAt,
    truncation: { ...snapshot.truncation },
    consumers: snapshot.consumers,
  };
}
