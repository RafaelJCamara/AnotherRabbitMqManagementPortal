// What a plan of the engine asks of the person, read from the plan as sent (R4). Nothing here decides whether the
// person may publish: it lists what the engine asked for, and the engine checks all of it again on execute.
import type { EnginePlan } from '@app/ui-data';

/** What a plan asks of the person before it can run, as the engine sent it. */
export interface PlanNeeds {
  /** The gates that block, each with its reason, source and fix. */
  readonly blocking: EnginePlan['gates'];
  readonly consents: readonly string[];
  /** The phrase to type, or `null`. */
  readonly phrase: string | null;
  /** Approvals asked and not yet granted. */
  readonly approvalsMissing: number;
  readonly warnings: EnginePlan['warnings'];
}

export function planNeeds(plan: EnginePlan): PlanNeeds {
  const approved = plan.approvals.granted.filter(
    (grant) => grant.decision === 'approve',
  ).length;
  return {
    blocking: plan.gates.filter((gate) => gate.blocking),
    consents: plan.consentsRequired,
    phrase:
      plan.confirmationPhrase === undefined || plan.confirmationPhrase === ''
        ? null
        : plan.confirmationPhrase,
    approvalsMissing: Math.max(0, plan.approvals.required - approved),
    warnings: plan.warnings,
  };
}

/** True when the dialog must show: anything the engine asks, or a warning the person should see before it runs. */
export function needsReview(plan: EnginePlan): boolean {
  const needs = planNeeds(plan);
  return (
    needs.blocking.length > 0 ||
    needs.consents.length > 0 ||
    needs.phrase !== null ||
    needs.approvalsMissing > 0 ||
    needs.warnings.length > 0
  );
}
