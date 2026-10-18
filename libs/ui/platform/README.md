# ui-platform

How the web UI reaches the engine and the shell it runs in: the `EngineTransport` and `PlatformBridge` tokens, the two carriers that implement the transport (the desktop MessagePort tunnel and HTTP plus WebSocket), the web bridge, and the boot sequence that picks them. This library owns the only `fetch` and `WebSocket` of the UI (`@app/no-direct-fetch` exempts `libs/ui/platform`). Everything above it codes against the interfaces and never learns which carrier is in use (ADR-002, ADR-005, blueprint 10).

Tags: `type:ui-platform`, `runtime:browser`. May import `@app/contracts` and `@app/live-protocol` (in its test support only).

## Public API

- **Transport** (`engine-transport.ts`): `EngineTransport` (`request(request, signal)`, `openLive()`), `LiveChannel` (`send`, `frames()` as an async iterable, `close`), `ENGINE_TRANSPORT`, `TransportError` (`reason`: `aborted`, `closed`, `network`, `protocol`, `overflow`), `isTransportError`, the request and response types, and the shared bounds `DEFAULT_MAX_PENDING_FRAMES`, `DEFAULT_MAX_RESPONSE_BYTES`.
- **`MessagePortTransport`** (`messageport-transport.ts`): the desktop carrier. REST goes through the port as `http.req`, `http.res` and `http.chunk` frames, the live protocol as `live` frames. Frames are checked against `PortFrameSchema` in dev and test builds.
- **`HttpWsTransport`** (`httpws-transport.ts`): the web carrier. `fetch` for REST (same origin, no redirects, no cache), one WebSocket for the live protocol, opened with a single-use ticket from `POST /api/v1/live/tickets` in `Sec-WebSocket-Protocol: app.v1, app.ticket.<t>`. Constants: `API_PREFIX`, `LIVE_PATH`, `LIVE_TICKET_PATH`, `LIVE_SUBPROTOCOL`, `LIVE_TICKET_SUBPROTOCOL_PREFIX`.
- **`EngineTransportHttpBackend`** (`http-backend.ts`): an `HttpBackend` over any `EngineTransport`, so `HttpClient`, the interceptors and `httpResource` run unchanged on both carriers. `provideEngineData` in ui-data installs it.
- **Bridge** (`platform-bridge.ts`): `PLATFORM_BRIDGE`, `WebBridge` (only https links open, no save target, no native menu), `isPlatformBridge`.
- **Credentials** (`credentials.ts`): `ENGINE_CREDENTIALS`, `credentialHeaders`, `isEngineUrl`. Engine credentials only (launch token, team CSRF token), never broker credentials, and only for same-origin paths.
- **Boot** (`bootstrap.ts`): `bootstrapPlatform` picks the desktop path (`__APP_PLATFORM__` bridge, then the one engine port of the page load) or the web path (`/bootstrap.json`, launch token from the URL fragment), and `providePlatform` provides the result. Also `consumeLaunchToken`, `waitForEnginePort`, `BootstrapSchema`, `BootstrapError`, `browserEnvironment`.
- `FrameQueue`: the bounded async queue both carriers hand server frames through.

Test support is a separate entry point, `@app/ui-platform/testing` (not part of the production API): `FakeEngine` (REST handler plus a real `LiveSession` from `@app/live-protocol` per connection), `createFakePort`, `createFakeFetch` with `createFakeWebSocketFactory`, `MemoryTransport` (an in-memory carrier that can lose its channel), `jsonResponse`, `problemResponse`, `tick`, `waitFor`.

## Invariants

- Every frame buffer is bounded and a full buffer fails loudly (I-6, I-13): the live frame queue, the frames held before the socket opens, a streamed response (`maxResponseBytes`). Nothing is dropped silently.
- No secrets in the URL or in logs (I-10): the launch token is moved from the URL fragment into `sessionStorage` and the URL is cleaned before anything else runs; credentials are attached to engine paths only.
- The engine port is accepted once per page load, only from a message of this window and origin that carries exactly one port.
- Binary bodies are recognised without `instanceof ArrayBuffer` (`isArrayBuffer`), so a buffer from another realm still works.
- Dependencies follow the type:ui-platform row of blueprint 2.2; `pnpm nx lint ui-platform` enforces them.
- Copy lives in i18n files, never in templates (`@app/ui-no-raw-template-text`). This library has no templates.

## Not here yet

The desktop reconnect after an engine restart (a new port) and the preload that offers `__APP_PLATFORM__` belong to the desktop app (M2, ADR-030). The `ui-platform` project has a hand-written `tsconfig.json` that allows `.ts` import extensions and index-signature property access, because it compiles `@app/contracts` and `@app/live-protocol` from source (OQ-190).

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p ui-platform
```

The tests run each carrier against the fake engine: request and response, streaming, abort, close, ticket and subprotocol, bounded buffers, protocol errors, and the boot sequence with a fake window.
