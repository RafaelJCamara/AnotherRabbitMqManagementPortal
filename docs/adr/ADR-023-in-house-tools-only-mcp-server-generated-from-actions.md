# ADR-023: In-house tools-only MCP server generated from actions

- **Status:** Accepted
- **Date:** 2026-10-16
- **Source:** design panel (final blueprint); see [docs/architecture/blueprint.md](../architecture/blueprint.md)

## Decision

A JSON-RPC subset (initialize, tools/list, tools/call, ping) is generated from actions with mcp.expose. On desktop and local it runs as a stdio shim over IPC. On the team server, /mcp is its own OAuth resource (RFC 9728 and 8707) with no token passthrough. Peeks count as mutations. Mutating tools are plan-only and require human approval through an approvals inbox, which also exists on desktop. @modelcontextprotocol/sdk 1.32.1 is used only as a test oracle.

## Rationale

Required by DC-42. The SDK pulls in express 5, hono, cors and cross-spawn (verified).

## Alternatives considered

SDK as a runtime dependency; a standalone MCP process holding its own credentials.

## Consequences

We must track MCP spec revisions ourselves.
