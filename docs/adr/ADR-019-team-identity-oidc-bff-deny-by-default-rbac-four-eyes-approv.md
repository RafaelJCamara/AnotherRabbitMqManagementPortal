# ADR-019: Team identity: OIDC BFF, deny-by-default RBAC, four-eyes approval, per-connection broker credential modes

- **Status:** Accepted
- **Date:** 2026-10-16
- **Source:** design panel (final blueprint); see [docs/architecture/blueprint.md](../architecture/blueprint.md)

## Decision

The team server authenticates users with openid-client 6.8.8 (code + PKCE), a __Host- session cookie and a CSRF header.
- RBAC: permissions are split (peek, budgeted peek, consume, purge, replay, publish, unmask, topology, policy, user, ops, MCP mutate) and scoped by env, connection, vhost and resource.
- Approvals: the approver must differ from the requester.
- Broker credential mode is chosen per connection: delegated OAuth, then Vault dynamic, then LDAP, then service account. It is always intersected with RBAC, and jobs never silently fall back to another identity.

## Rationale

DC-40 and DC-41: purge needs only broker read permission, and the broker emits no purge event.

## Alternatives considered

Proxy-header-only auth; broker permissions only; paid governance tiers.

## Consequences

Admins must map IdP groups to roles, and delegated mode needs token-exchange or OBO setup.

## Amendments

A-14: desktop remote workspaces use the local engine as an RFC 8252 public client proxying over MessagePort with Bearer tokens (no CORS, no CSP relaxation). Team server moves to M5. See [docs/plan/amendments.md](../plan/amendments.md).
