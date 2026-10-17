# ADR-003: One contract registry; generated OpenAPI/AsyncAPI; no client codegen

- **Status:** Accepted
- **Date:** 2026-10-16
- **Source:** design panel (final blueprint); see [docs/architecture/blueprint.md](../architecture/blueprint.md)

## Decision

@app/contracts declares each action and topic once with defineAction and defineTopic (zod 4.6.7), including permission, risk, planning, audit and the HTTP, MCP and CLI bindings. The router, MCP tools, CLI commands, OpenAPI 3.1 and AsyncAPI 3.0 are all derived from it. The specs are emitted with z.toJSONSchema and committed behind a diff gate. The UI uses EngineApi.call and engineResource with inferred types. Paths carry opaque ObjectKey segments.

## Rationale

One source of truth cannot drift. It also avoids Orval's churn and any generated code to review. ObjectKey avoids %2F mangling behind ingresses.

## Alternatives considered

Orval 8.43 client; NestJS swagger converter; hand-written clients; tRPC or oRPC.

## Consequences

Contracts ship to the browser, so deep imports and a bundle budget are needed. oasdiff runs as a digest-pinned Go binary, and the npm package named oasdiff is banned.
