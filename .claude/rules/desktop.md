---
paths:
  - 'apps/desktop/**'
---

# Desktop rules

Applies to the Electron app (main and preload). All of it is trust-critical: a human CODEOWNERS approval is required. Source: blueprint sections 1.1 and 7.1, ADR-002.

- **Main is thin:** single-instance lock, the `app://` protocol, windows and menus generated from the command registry, `safeStorage` (async), `powerMonitor`, `openExternal`, the engine supervisor and the control channel. Business logic belongs in the engine.
- **Control frames are zod-validated `CtlFrame`s.** The engine runs as a `utilityProcess` with no TCP listener (DC-35).
- **Exactly one MessagePort per page load.** The preload calls `requestEnginePort()`; main validates `event.senderFrame.url` (origin `app://main`), creates one `MessageChannelMain`, and sends one end to the engine and one to the renderer. After an engine restart main re-issues ports to every live renderer.
- **Renderer isolation:** `sandbox`, `contextIsolation`, `nodeIntegration: false`, `webviewTag: false`. Deny all permission requests, prevent `will-navigate`, deny `setWindowOpenHandler`. Devtools are off in release builds.
- **Validate the `senderFrame` of every IPC message.** The preload exposes `PlatformBridge` v1 only: no secrets, no Node APIs.
- **`shell.openExternal` accepts https only**, from an allow-list (docs, pinned IdP endpoints), and asks the user to confirm.
- **Fuses (DC-46).** Off: `RunAsNode`, `NodeOptions`, `NodeCliInspect`, `GrantFileProtocolExtraPrivileges`. On: `EmbeddedAsarIntegrityValidation`, `OnlyLoadAppFromAsar`, `CookieEncryption`. The test-fused build is never published; `fuse-check` reads the fuses of every release artefact.
- **CSP** is served with a per-response nonce; `connect-src 'self'`; no inline script. `innerHTML` is banned.
- **No telemetry (I-12).** Update checks are opt-in, from a first-run dialog with no preselected choice.
- **Shutdown** goes through the `DrainCoordinator` (about 2 s total); never `process.exit` around it.
- `electron` is imported only from `apps/desktop` (confinement). Main and preload are separate runtime tags (`runtime:electron-main`, `runtime:electron-preload`); the preload may not import Node builtins.
