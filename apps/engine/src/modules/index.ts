// The modules this engine ships: what each contributes to the executor, the job runner, the live
// hub and the shutdown. Every engine service is added here, in one place, and receives only the
// capabilities it is handed (ADR-001): a module never asks which delivery mode it runs in.
import type { EngineMode } from '@app/contracts';
import type { JobDef } from '@app/jobs';
import {
  createArmActions,
  createMetaAction,
  type ActionImpl,
  type ArmingControl,
  type Authorizer,
  type Clock,
  type DrainPhaseSpec,
  type Timers,
} from '@app/kernel';
import type { RegisteredTopic } from '@app/live';
import type {
  BrokerProfileStore,
  BrokerWireProbe,
  ConnectionProber,
  ConnectionStore,
  FieldSealer,
  MgmtReadPort,
  WorkspaceRepository,
} from '@app/ports';
import { createCapabilitiesModule } from '@app/svc-capabilities';
import { createConnectionsModule } from '@app/svc-connections';
import { createExplorerModule } from '@app/svc-explorer';
import { createOpsModule, type OpsModuleDeps } from '@app/svc-ops';
import { createWorkspaceModule } from '@app/svc-workspace';

export interface EngineModule {
  readonly id: string;
  readonly actions: readonly ActionImpl[];
  readonly jobs?: readonly JobDef[];
  /** The live topics this module serves, registered with the hub's TopicRegistry (blueprint 3.5). */
  readonly topics?: readonly RegisteredTopic[];
  readonly drainPhases?: readonly DrainPhaseSpec[];
}

/**
 * The ports of the services, built by the composition root. `mgmt` is already behind the
 * BrokerScheduler (I-8) and its errors are Problems; a service is never handed the adapter or a
 * write port.
 */
export interface ServicePorts {
  readonly connections: ConnectionStore;
  readonly profiles: BrokerProfileStore;
  readonly workspace: WorkspaceRepository;
  /** The data-key vault's field cipher: rejects while the vault is locked. */
  readonly sealer: FieldSealer;
  readonly mgmt: MgmtReadPort;
  readonly wire: BrokerWireProbe;
  readonly prober: ConnectionProber;
  /** The authorizer the executor uses, so `profile.get` can tell a caller what it may call. */
  readonly authorizer: Authorizer;
  /** A new, opaque, path-safe id: a ULID. */
  readonly newId: () => string;
  readonly clock: Clock;
  readonly timers: Timers;
}

/** What the composition root hands to the module factory. */
export interface ModuleContext {
  readonly engineVersion: string;
  /** For `meta.get` to report; a service has no use for it. */
  readonly mode: EngineMode;
  /** Only `ops.arm` and `ops.disarm` may use it. */
  readonly arming: ArmingControl;
  /** The ports of the operations service; absent when this mode cannot save a bundle. */
  readonly ops?: OpsModuleDeps;
  readonly services: ServicePorts;
}

export type ModuleFactory = (context: ModuleContext) => readonly EngineModule[];

/**
 * The service modules still declare `actions` as `unknown[]` (a stand-in from before the kernel had
 * a module type); what they hold is the `ActionImpl`s that `implementAction` made, and the executor
 * refuses anything that is not one.
 */
const implsOf = (actions: readonly unknown[]): readonly ActionImpl[] =>
  actions as readonly ActionImpl[];

/** Modules that end their own timers, sweeps and subscriptions do it here, when the engine stops. */
const STOPS_ON: DrainPhaseSpec['reasons'] = ['quit', 'sigterm', 'emergency'];

export const coreModules: ModuleFactory = ({
  engineVersion,
  mode,
  arming,
  ops,
  services,
}) => {
  const connections = createConnectionsModule({
    store: services.connections,
    sealer: services.sealer,
    prober: services.prober,
    newId: services.newId,
  });
  const capabilities = createCapabilitiesModule({
    mgmt: services.mgmt,
    wire: services.wire,
    profiles: services.profiles,
    connections: services.connections,
    authorizer: services.authorizer,
  });
  const workspace = createWorkspaceModule({
    workspace: services.workspace,
    newId: services.newId,
  });
  const explorer = createExplorerModule({
    mgmt: services.mgmt,
    profiles: services.profiles,
    connections: services.connections,
    clock: services.clock,
    timers: services.timers,
  });
  return [
    { id: 'meta', actions: [createMetaAction({ engineVersion, mode })] },
    { id: 'ops', actions: createArmActions(arming) },
    // The diagnostics bundle exists only where a mode gave it somewhere to save to (M0-69).
    ...(ops === undefined
      ? []
      : [{ id: 'svc-ops', actions: createOpsModule(ops).actions }]),
    { id: connections.id, actions: implsOf(connections.actions) },
    { id: capabilities.id, actions: implsOf(capabilities.actions) },
    { id: workspace.id, actions: implsOf(workspace.actions) },
    {
      id: explorer.id,
      actions: explorer.actions,
      topics: explorer.topicSources,
      // The sweeps and the subscriptions end before the sockets and the database do (the explorer's
      // stop is final, so a suspend, which comes back, leaves them alone).
      drainPhases: [
        {
          name: 'taps-firehose',
          reasons: STOPS_ON,
          run: () => explorer.stop(),
        },
      ],
    },
  ];
};
