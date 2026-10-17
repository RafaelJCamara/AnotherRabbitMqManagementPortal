# ADR-017: Local IPC with mutual HMAC challenge-response

- **Status:** Accepted
- **Date:** 2026-10-16
- **Source:** design panel (final blueprint); see [docs/architecture/blueprint.md](../architecture/blueprint.md)

## Decision

The CLI and the stdio MCP shim connect over a UDS in a 0700 directory, or a random-suffix named pipe. Both sides prove possession of a key from a user-only engine.json using HMAC over each other's nonces. The client verifies the engine before sending anything. Capability tokens are read-only by default, scoped, expiring and stored hashed.

## Rationale

Windows' default pipe DACL grants Everyone read access. An impostor engine could otherwise phish tokens or feed injected content to AI agents.

## Alternatives considered

Token on the first frame only; OS permissions only.

## Consequences

Spike S-08 evaluates an optional server-PID and owner-SID check.

## Amendments

A-15/A-16: IPC discovery is written outside AppData (MSIX virtualisation); only the Electron app owns the desktop data directory; the CLI arrives in M4. See [docs/plan/amendments.md](../plan/amendments.md).
