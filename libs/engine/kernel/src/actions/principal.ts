// Principals: who is acting (blueprint 5.1 step 3). The executor never trusts the shape it is
// handed, copies it so an action cannot change who it ran as, and answers the two questions the
// plan lifecycle asks: may this principal act for the plan's requester, and is it the requester?
import type { Principal } from '@app/ports';

const KINDS: ReadonlySet<string> = new Set([
  'desktop-user',
  'local-token',
  'team-user',
  'api-token',
  'mcp-client',
  'job',
  'system',
]);
const SURFACES: ReadonlySet<string> = new Set([
  'ui',
  'cli',
  'mcp',
  'job',
  'system',
]);

/** Longest delegation chain accepted (a job for an MCP client for a person is already 3). */
const MAX_CHAIN = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** True only for a well-formed principal, including its `onBehalfOf` chain. */
export function isPrincipal(value: unknown, depth = 0): value is Principal {
  if (depth >= MAX_CHAIN || !isRecord(value)) return false;
  const { kind, id, display, roles, surface, unattended, onBehalfOf } = value;
  return (
    typeof kind === 'string' &&
    KINDS.has(kind) &&
    typeof id === 'string' &&
    id.length > 0 &&
    typeof display === 'string' &&
    Array.isArray(roles) &&
    roles.every((role) => typeof role === 'string') &&
    typeof surface === 'string' &&
    SURFACES.has(surface) &&
    typeof unattended === 'boolean' &&
    (onBehalfOf === undefined || isPrincipal(onBehalfOf, depth + 1))
  );
}

/** A deep, frozen copy: nothing that runs later can widen the roles or swap the identity. */
export function snapshotPrincipal(principal: Principal): Principal {
  const copy: Principal = {
    kind: principal.kind,
    id: principal.id,
    display: principal.display,
    roles: Object.freeze([...principal.roles]) as string[],
    surface: principal.surface,
    unattended: principal.unattended,
  };
  if (principal.onBehalfOf !== undefined) {
    copy.onBehalfOf = snapshotPrincipal(principal.onBehalfOf);
  }
  return Object.freeze(copy);
}

/** The principal itself, then whoever it acts for, and so on. */
export function chainOf(principal: Principal): Principal[] {
  const chain: Principal[] = [];
  for (
    let current: Principal | undefined = principal;
    current !== undefined && chain.length < MAX_CHAIN;
    current = current.onBehalfOf
  ) {
    chain.push(current);
  }
  return chain;
}

/**
 * A person at the UI of a single-user engine (desktop or local): the one principal that
 * allow-all authorisation may apply to (amendment A-11). A delegate, an unattended principal
 * or anything on the CLI or MCP surface is not one.
 */
export function isUiPrincipal(principal: Principal): boolean {
  return (
    principal.surface === 'ui' &&
    (principal.kind === 'desktop-user' || principal.kind === 'local-token') &&
    !principal.unattended &&
    principal.onBehalfOf === undefined
  );
}

/** The identities a plan is bound to: who asked for it, and for whom. */
export interface PlanOwner {
  readonly principalId: string;
  readonly onBehalfOfId: string | null;
}

/** The ids of the requester, and of the person the requester acts for. */
export function ownerOf(principal: Principal): PlanOwner {
  return {
    principalId: principal.id,
    onBehalfOfId: principal.onBehalfOf?.id ?? null,
  };
}

/**
 * May `candidate` execute or look at a plan owned by `owner`? The requester may; so may the
 * person the requester acted for (an MCP client plans, a person executes); so may a job that
 * runs for the requester.
 */
export function mayActFor(candidate: Principal, owner: PlanOwner): boolean {
  if (candidate.id === owner.principalId) return true;
  if (owner.onBehalfOfId !== null && candidate.id === owner.onBehalfOfId) {
    return true;
  }
  return (
    candidate.kind === 'job' && candidate.onBehalfOf?.id === owner.principalId
  );
}

/**
 * Is `approver`, or anyone it acts for, the requester or the person the requester acts for?
 * Approvers must differ from the requester (ADR-006).
 */
export function isRequester(approver: Principal, owner: PlanOwner): boolean {
  return chainOf(approver).some(
    (member) =>
      member.id === owner.principalId ||
      (owner.onBehalfOfId !== null && member.id === owner.onBehalfOfId),
  );
}
