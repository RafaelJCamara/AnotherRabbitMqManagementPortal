// Authorisation (blueprint 5.1 step 6): tool RBAC, deny by default. The executor asks an
// `Authorizer` before it plans, runs or approves anything; nothing in this file is reached
// without that call.
//
// Amendment A-11: allow-all applies only to the UI principal of a single-user engine. The
// composition root picks `allowUiPrincipals(...)` for desktop and local mode and a role
// authorizer for the team server; the executor itself never looks at the delivery mode (ADR-001).
import type {
  ActionId,
  EngineMode,
  EnvClass,
  Permission,
  TargetRef,
} from '@app/contracts';
import type { Principal } from '@app/ports';

import { chainOf, isUiPrincipal } from './principal.ts';

export interface AuthorizationRequest {
  principal: Principal;
  permission: Permission;
  actionId: ActionId;
  target: TargetRef;
  mode: EngineMode;
  env: EnvClass;
}

export type AuthorizationDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export interface Authorizer {
  authorize(request: AuthorizationRequest): Promise<AuthorizationDecision>;
}

export const ALLOW: AuthorizationDecision = Object.freeze({ allowed: true });

/** The default when nothing else is wired: every request is refused. */
export const denyAllAuthorizer: Authorizer = {
  authorize: () =>
    Promise.resolve({ allowed: false, reason: 'No authorizer is configured.' }),
};

/**
 * Allow-all for a person at the UI of a single-user engine; everything else goes to `fallback`
 * (deny-all unless given). A delegate of that person is not a UI principal.
 */
export function allowUiPrincipals(
  fallback: Authorizer = denyAllAuthorizer,
): Authorizer {
  return {
    authorize: (request) =>
      isUiPrincipal(request.principal)
        ? Promise.resolve(ALLOW)
        : fallback.authorize(request),
  };
}

/** `area.verb` grants. Each half may be `*`: `messages.*`, `*.read`, `*.*`. */
function grantMatches(grant: string, permission: string): boolean {
  const [grantArea, grantVerb, ...extraGrant] = grant.split('.');
  const [area, verb, ...extra] = permission.split('.');
  if (
    grantArea === undefined ||
    grantVerb === undefined ||
    area === undefined ||
    verb === undefined ||
    extraGrant.length > 0 ||
    extra.length > 0
  ) {
    return false;
  }
  return (
    (grantArea === '*' || grantArea === area) &&
    (grantVerb === '*' || grantVerb === verb)
  );
}

/**
 * Role-based authorisation from a table of role names to grants. A principal holds a permission
 * when one of its roles grants it; a principal that acts for another (a job, an MCP client) holds
 * only what it and the one it acts for both hold. An unknown role grants nothing.
 */
export function createRoleAuthorizer(
  grants: Readonly<Record<string, readonly string[]>>,
): Authorizer {
  const table = new Map(Object.entries(grants));
  const holds = (member: Principal, permission: string): boolean =>
    member.roles.some((role) =>
      (table.get(role) ?? []).some((grant) => grantMatches(grant, permission)),
    );
  return {
    authorize: (request) => {
      const missing = chainOf(request.principal).find(
        (member) => !holds(member, request.permission),
      );
      return Promise.resolve(
        missing === undefined
          ? ALLOW
          : {
              allowed: false,
              reason: `${missing.display || missing.id} does not hold ${request.permission}.`,
            },
      );
    },
  };
}
