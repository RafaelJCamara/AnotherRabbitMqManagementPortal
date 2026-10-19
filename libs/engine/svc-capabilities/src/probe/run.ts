// Runs the probe: the twelve steps in order, each isolated. A step that fails leaves its facts
// unknown and the run goes on, because a broker that hides one endpoint (a login without the
// monitoring tag, a provider that blocks a plugin) is the ordinary case. Only an abort stops the run.
import { PROBE_STEPS } from './steps';
import type { Facts, ProbeEnv, ProbeStep, StepId, StepOutcome } from './types';
import { failureReason } from './types';

export interface StepResult extends StepOutcome {
  readonly id: StepId;
  /** The Problem code of the failure, when the error carried one. Kept for the caller, not shown. */
  readonly code?: string;
}

export interface ProbeRun {
  readonly facts: Facts;
  readonly steps: readonly StepResult[];
}

export async function runProbe(
  env: ProbeEnv,
  steps: readonly ProbeStep[] = PROBE_STEPS,
): Promise<ProbeRun> {
  const facts: Facts = { overviews: [] };
  const results: StepResult[] = [];
  for (const step of steps) {
    env.signal.throwIfAborted();
    try {
      results.push({ id: step.id, ...(await step.run(env, facts)) });
    } catch (error) {
      // An abort is the caller's decision, not a broker failure.
      env.signal.throwIfAborted();
      const failure = failureReason(error);
      results.push({
        id: step.id,
        status: failure.status,
        detail: failure.reason,
        ...(failure.code === undefined ? {} : { code: failure.code }),
      });
    }
  }
  return { facts, steps: results };
}
