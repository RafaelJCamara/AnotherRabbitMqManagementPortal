# ADR-002: Desktop transport: MessagePort per page load tunnelling the REST router via fastify.inject

- **Status:** Accepted
- **Date:** 2026-10-16
- **Source:** design panel (final blueprint); see [docs/architecture/blueprint.md](../architecture/blueprint.md)

## Decision

Main issues exactly one MessageChannelMain port per page load to a validated app://main frame, and the preload forwards it to the main world. PortSessionServer maps http.req frames to app.inject. Bodies over 1 MiB stream through payloadAsStream as http.chunk frames. The tunnel strips renderer-supplied authorization, cookie, host and x-forwarded-* headers, then adds a per-boot carrier secret. Every network listener rejects that header. Angular overrides HttpBackend.

## Rationale

Satisfies DC-35 with no network surface. One dispatch path keeps validation, errors and policy identical across modes. inject is the production dispatch path in @fastify/aws-lambda.

## Alternatives considered

Loopback HTTP/WS with a token; a separate RPC protocol over the port; ipcRenderer.invoke through main.

## Consequences

Credits are mandatory and we need a dev-only Transport Inspector. Large exports are written to disk by the engine. Spike S-01 gates an optional engine-link Web Worker.

## Amendments

The desktop transport is built in M2 (Windows); the EngineTransport/PlatformBridge abstractions and a fake-port transport test exist from M0. See ADR-030. See [docs/plan/amendments.md](../plan/amendments.md).
