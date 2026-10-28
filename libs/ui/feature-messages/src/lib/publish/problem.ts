// What the studio shows of a failure (R8): the engine's Problem as sent, plus a fixed hint chosen by its code. A copy
// of the small view the connections pages have (a feature never imports another feature, #281). Everything the
// engine sent is rendered as text; the hint is ours and is a key, never built from engine text.
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
 * only case in which the studio offers the unlock from a Problem.
 */
export function offersUnlock(view: ProblemView | null, cid: string): boolean {
  return (
    view !== null &&
    view.code === 'GATE_BLOCKED' &&
    view.gate?.fixAction === 'ops.arm' &&
    view.gate.fixConnection === cid
  );
}

/**
 * True when the engine did not serve the plan route at all (no such route), as the engine does today: the plan and
 * execute routes are not routed yet (OQ-191, OQ-282). A plan of `messages.publish` reads nothing from the broker, so
 * a 404 on it can only be the route.
 */
export function planRouteMissing(error: unknown): boolean {
  return (
    isEngineProblem(error) && error.status === 404 && error.code === 'NOT_FOUND'
  );
}

/** The hint for a code: a key, or `null` when the Problem says enough. The keys are literals for the source check. */
const HINTS = new Map<string, string>([
  ['CAPABILITY_MISSING', 'publish.hint.capabilityMissing'],
  ['PLAN_REQUIRED', 'publish.hint.planRequired'],
  ['PLAN_EXPIRED', 'publish.hint.planExpired'],
  ['PLAN_STALE', 'publish.hint.planExpired'],
  ['GATE_BLOCKED', 'publish.hint.gateBlocked'],
  ['FORBIDDEN_RBAC', 'publish.hint.forbidden'],
  ['FORBIDDEN_BROKER', 'publish.hint.forbiddenBroker'],
  ['NOT_FOUND', 'publish.hint.notFound'],
  ['BROKER_UNREACHABLE', 'publish.hint.unreachable'],
  ['VALIDATION_FAILED', 'publish.hint.validation'],
]);

export function hintKey(code: string | null): string | null {
  return code === null ? null : (HINTS.get(code) ?? null);
}
