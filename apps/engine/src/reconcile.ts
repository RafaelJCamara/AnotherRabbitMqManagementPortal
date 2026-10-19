// Reconciliation at engine start (blueprint 1.5). The jobs step is real: what a crash left running
// becomes `paused-interrupted`. The other records are written by work packages that have not landed
// (holds, replays, firehose, taps) or by nobody yet (OQ-318: plans stuck in `executing`, audit
// attempts with no outcome), so each is a named step that reports `pending` and says what it waits
// for. A pending step is announced in the ready line: the engine never reports a record reconciled
// that it did not look at (I-13).
import type { JobRecoveryReport } from '@app/jobs';
import type { Logger } from '@app/kernel';

export type ReconcileOutcome =
  | {
      readonly status: 'done';
      readonly detail?: Readonly<Record<string, unknown>>;
    }
  | { readonly status: 'pending'; readonly waitsFor: string };

export interface ReconcileStep {
  readonly name: string;
  run(): Promise<ReconcileOutcome>;
}

export interface ReconcileReport {
  readonly name: string;
  readonly outcome: ReconcileOutcome;
}

/** The records of blueprint 1.5 that nothing reconciles yet, and what each waits for. */
export const PENDING_RECONCILIATION: readonly (readonly [string, string])[] = [
  ['plans-executing', 'OQ-318'],
  ['audit-attempts', 'OQ-318'],
  ['hold-journal', 'the peek executor (M1)'],
  ['replay-journal', 'the replay job (M2)'],
  ['firehose-leases', 'the tap service (M1)'],
  ['tap-sweep', 'the tap service (M1)'],
];

export function pendingSteps(): ReconcileStep[] {
  return PENDING_RECONCILIATION.map(([name, waitsFor]) => ({
    name,
    run: () => Promise.resolve({ status: 'pending' as const, waitsFor }),
  }));
}

export function jobsStep(runner: {
  recover(): Promise<JobRecoveryReport>;
}): ReconcileStep {
  return {
    name: 'jobs',
    run: async () => {
      const report = await runner.recover();
      return { status: 'done', detail: { ...report } };
    },
  };
}

/** Runs the steps in order. A step that throws stops the start: nothing is reported reconciled. */
export async function reconcile(
  steps: readonly ReconcileStep[],
  logger?: Logger,
): Promise<ReconcileReport[]> {
  const reports: ReconcileReport[] = [];
  for (const step of steps) {
    const outcome = await step.run();
    reports.push({ name: step.name, outcome });
    logger?.info(
      {
        event: 'engine.reconcile',
        step: step.name,
        status: outcome.status,
        ...(outcome.status === 'pending'
          ? { waitsFor: outcome.waitsFor }
          : { ...outcome.detail }),
      },
      'reconciliation step',
    );
  }
  return reports;
}
