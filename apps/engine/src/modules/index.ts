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
}

export type ModuleFactory = (context: ModuleContext) => readonly EngineModule[];

export const coreModules: ModuleFactory = ({ engineVersion, mode, arming }) => [
  { id: 'meta', actions: [createMetaAction({ engineVersion, mode })] },
  { id: 'ops', actions: createArmActions(arming) },
];
