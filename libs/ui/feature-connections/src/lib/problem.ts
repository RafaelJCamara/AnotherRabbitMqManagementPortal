import type { Problem } from '@app/contracts';
import { isEngineProblem } from '@app/ui-data';

/** What the page shows of the gate of a Problem: the engine's reason and source as sent, and the fix it names. */
export interface GateView {
  readonly reason: string | null;
  readonly source: string | null;
  /** The action the engine names as the fix (for example `ops.arm`) and the connection it names, when it does. */
  readonly fixAction: string | null;
  readonly fixConnection: string | null;
}

/** What the page shows of a failure: the engine's Problem as sent, or the message of anything else. */
export interface ProblemView {
  readonly title: string;
  readonly detail: string | null;
  /** The Problem's code, for an engine failure. */
  readonly code: string | null;
  readonly gate: GateView | null;
}

function gateView(gate: Problem['gate']): GateView | null {
  if (gate === undefined) return null;
  const input: unknown = gate.fix?.input;
  const connection =
    typeof input === 'object' && input !== null && 'connectionId' in input
      ? input.connectionId
      : null;
  return {
    reason: gate.reason ?? null,
    source: gate.source ?? null,
    fixAction: gate.fix?.actionId ?? null,
    fixConnection: typeof connection === 'string' ? connection : null,
  };
}

export function problemView(error: unknown): ProblemView {
  if (isEngineProblem(error)) {
    return {
      title: error.problem.title,
      detail: error.problem.detail ?? null,
      code: error.problem.code,
      gate: gateView(error.problem.gate),
    };
  }
  if (error instanceof Error) {
    return { title: error.message, detail: null, code: null, gate: null };
  }
  return { title: '', detail: null, code: null, gate: null };
}

/**
 * True when the engine refused with the prod lock and named the arming of this very connection as the fix: the
 * only case in which the page offers the unlock dialog from a Problem (M0-52, R6).
 */
export function offersUnlock(view: ProblemView | null, cid: string): boolean {
  return (
    view !== null &&
    view.code === 'GATE_BLOCKED' &&
    view.gate?.fixAction === 'ops.arm' &&
    view.gate.fixConnection === cid
  );
}
