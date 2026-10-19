// The modules this engine ships: what each contributes to the executor, the job runner and the
// shutdown. Every engine service (M1 onwards) is added here, in one place, and receives only the
// capabilities it is handed (ADR-001): a module never asks which delivery mode it runs in.
import type { EngineMode } from '@app/contracts';
import type { JobDef } from '@app/jobs';
import {
  createArmActions,
  createMetaAction,
  type ActionImpl,
  type ArmingControl,
  type DrainPhaseSpec,
} from '@app/kernel';
import { createOpsModule, type OpsModuleDeps } from '@app/svc-ops';

export interface EngineModule {
  readonly id: string;
  readonly actions: readonly ActionImpl[];
  readonly jobs?: readonly JobDef[];
  readonly drainPhases?: readonly DrainPhaseSpec[];
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
}

export type ModuleFactory = (context: ModuleContext) => readonly EngineModule[];

export const coreModules: ModuleFactory = ({
  engineVersion,
  mode,
  arming,
  ops,
}) => [
  { id: 'meta', actions: [createMetaAction({ engineVersion, mode })] },
  { id: 'ops', actions: createArmActions(arming) },
  // The diagnostics bundle exists only where a mode gave it somewhere to save to (M0-69).
  ...(ops === undefined
    ? []
    : [{ id: 'svc-ops', actions: createOpsModule(ops).actions }]),
];
