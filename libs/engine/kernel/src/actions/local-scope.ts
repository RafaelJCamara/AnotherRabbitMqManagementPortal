// `scope: 'local'` (contracts, define-action.ts): the one declared way for a mutating action with no
// target connection to pass the prod lock. These helpers are the single reading of it, used by the
// executor (which refuses a local action that names a target) and by the guardrail policy (which
// grants the exemption only when both hold), so the two cannot drift apart.
import type { ActionDef, TargetRef } from '@app/contracts';

/** True when the target names anything at all: a connection, a vhost, an object or a count. */
export function namesATarget(target: TargetRef): boolean {
  return Object.values(target).some((value) => value !== undefined);
}

/**
 * True for a contract that declares `scope: 'local'` on a kind that can be local (a command; a
 * query is never locked). A peek touches messages and a job runs on a broker, so neither counts.
 */
export function declaresLocalScope(def: ActionDef): boolean {
  const scope: unknown = def.scope;
  return scope === 'local' && (def.kind === 'command' || def.kind === 'query');
}

/**
 * The exemption from the prod lock: a declared local scope AND a call that names no target. Both
 * are required, so a local contract that somehow carries a broker target stays locked.
 */
export function isLocalCall(def: ActionDef, target: TargetRef): boolean {
  return declaresLocalScope(def) && !namesATarget(target);
}
