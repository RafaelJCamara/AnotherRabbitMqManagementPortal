# Desktop + web architecture options

> **Pre-verification research (2026-10-16).** Where this conflicts with [`docs/research/fact-sheet.md`](../fact-sheet.md), the fact sheet wins. Content about a specific third-party product was removed under the docs policy ([ADR-034](../../adr/ADR-034-docs-policy.md)).

> **Superseded recommendation:** this report recommends a Go engine with a React UI. The maintainer chose **TypeScript end to end with Angular** ([ADR-032](../../adr/ADR-032-typescript-and-angular.md)).

_Research angle `desktop-web-architecture` · 2026-10-16_

## Executive summary

Browsers cannot reach open-source RabbitMQ over AMQP or the stream protocol. AMQP 1.0 over WebSocket exists only in the closed-source, Tanzu-only rabbitmq_web_amqp plugin. So every 'using RabbitMQ' feature (peek, live tap, publishing with headers, throttled DLQ republish, stream browsing) needs an engine process. The management HTTP API's 'get' endpoint is documented as being for development and troubleshooting only.

Every successful dual-mode tool has settled on the same pattern: one single-page web UI plus one engine that runs either next to the user (desktop) or next to the infrastructure (team server). The desktop shell does little more than launch the engine. Headlamp, RedisInsight and pgAdmin all work this way.

Recommendation: a React + TypeScript UI, a Go engine, and Electron as the desktop shell for v1. This is Headlamp's architecture applied to RabbitMQ.
- Go and the RabbitMQ team: Go is the only lightweight language with official RabbitMQ-team clients for all three protocols. These are amqp091-go (automatic topology recovery since v1.13.0, July 2026), the AMQP 1.0 client (v1.0.0 April 2026) and the stream client. Go also has a mature HTTP API client (rabbit-hole). It builds a small static binary that serves both as a desktop sidecar and as a multi-user server.
- Why Electron: Electron 44 ships Chromium 152, so rendering is identical on every OS. Tauri 2 relies on WebKitGTK on Linux, which has known performance problems with DOM-heavy UIs. Tauri's fixes (GTK4/WebKitGTK 6 and an optional CEF runtime) are still alpha (3.0.0-alpha.5).
- Size versus memory: independent benchmarks show little memory difference between Tauri and Electron; download size is Tauri's real advantage.
- Keep the shell swappable, so Tauri 3 or Wails v3 (currently beta, with a server build mode) can replace Electron later.

Web mode must add what a desktop app cannot:
- OIDC single sign-on
- role-based access control (RBAC) with message-level actions
- audit logging
- data masking
- an encrypted credential vault, or the user's OAuth2 token passed through to RabbitMQ

Conduktor shut down its desktop app because teams needed shared access, audit trails and role-based permissions.

Alternatives:
- TypeScript everywhere (Electron + Node engine): fastest to build, but the weakest set of official RabbitMQ clients.
- .NET engine (ASP.NET Core): excellent clients and auth, but a weaker cross-platform desktop story and Native AOT limits.

Distribution: sign and notarize from day one.
- macOS: Homebrew disables casks that fail Gatekeeper checks from September 2026.
- Windows: Artifact Signing starts at $9.99/month, but individual developers must be in the US or Canada. Alternatively, the Microsoft Store is free to register for, re-signs apps itself, and shows no SmartScreen warning.
- Servers: multi-arch images on GHCR and Docker Hub, plus a Helm chart published as an OCI artifact.

## Report

# Desktop and web delivery architecture for a RabbitMQ IDE and management portal

*Angle: desktop-web-architecture. Research date: 2026-10-16.*

Labels used throughout:
- **FACT** — sourced.
- **INFERENCE** — my reasoning.
- **IDEA** — a proposal.

The shared web-search budget ran out partway through this research. All later facts were verified by fetching primary pages directly.

---

## 1. Constraints that decide the architecture

### 1.1 No AMQP from a browser on open-source RabbitMQ (FACT)
- Browsers cannot open TCP sockets.
- Open-source RabbitMQ offers browsers only Web-STOMP (`ws://host:15674/ws`) and Web-MQTT ([web-stomp docs v4.3](https://www.rabbitmq.com/docs/web-stomp)).
- AMQP 1.0 over WebSocket (`rabbitmq_web_amqp`) does exist. RabbitMQ describes it as 'a closed-source feature available exclusively in the commercial VMware Tanzu RabbitMQ offering' (Tanzu 4.1+) ([RabbitMQ blog 2025-04-16](https://www.rabbitmq.com/blog/2025/04/16/amqp-websocket); [Broadcom list of Tanzu-only features](https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-rabbitmq-oci/4-2/tanzu-rabbitmq-oci-image/site-tanzu-rabbitmq-features.html)).

**INFERENCE:** every 'using RabbitMQ' feature needs an **engine process**: a sidecar on desktop, a server in web mode. That covers:
- publishing with headers and properties
- peeking at messages
- live tap
- bulk republish from dead-letter queues, with throttling
- browsing streams
- simulating consumers

### 1.2 The management HTTP API can be called from a browser, but it is not enough (FACT, [management docs v4.3](https://www.rabbitmq.com/docs/management), [HTTP API reference](https://www.rabbitmq.com/docs/http-api-reference))

Configuration options:
- **CORS allowlist:** `management.cors.allow_origins.N`. A wildcard is possible but 'highly discouraged'.
- **Bearer tokens:** enabled with `management.oauth_enabled`.
- **Token-only access:** `management.disable_basic_auth = true`.

The official management UI is itself 'a single page application which relies on the HTTP API'.

Limits that matter for us:
- `POST /api/queues/{vhost}/{name}/get` is 'intended for development and troubleshooting only'. Its requeue modes redeliver the messages it reads.
- Publishing over HTTP is 'a highly inefficient option'.
- Pages are capped at 500 items.
- Large clusters need the `disable_stats` and `enable_queue_totals` parameters.

### 1.3 Metrics (FACT, [prometheus docs](https://www.rabbitmq.com/docs/prometheus))
- The management UI 'by design doesn't try to be a long term metric collection solution'.
- Operators can switch its statistics off with `management_agent.disable_metrics_collector=true`.
- The `rabbitmq_prometheus` plugin serves these endpoints on port 15692:
  - `/metrics`
  - `/metrics/per-object`
  - `/metrics/detailed?family=...`
  - `/metrics/memory-breakdown`

**INFERENCE:** the time-series explorer and the drain forecast must be able to read from Prometheus as well as from management statistics.

### 1.4 Identity (FACT, [oauth2 docs](https://www.rabbitmq.com/docs/oauth2))
- RabbitMQ's OAuth 2.0 backend accepts a JWT as the password on AMQP 0-9-1, AMQP 1.0, MQTT and STOMP connections.
- Token scopes such as `rabbitmq.write:vhost1/queue-name` are translated into permissions.
- Tokens are refreshed with `update-secret` on AMQP 0-9-1 and with `/auth/tokens` on AMQP 1.0.
- Documented identity providers: UAA, Keycloak, Auth0, Entra ID and Okta.
- Opaque (non-JWT) tokens are Tanzu-only.

**INFERENCE:** a team server can forward the signed-in user's own token, so RabbitMQ itself enforces that user's permissions. Headlamp does the same with Kubernetes.

### 1.5 Supported RabbitMQ versions (FACT, [release information](https://www.rabbitmq.com/release-information))
- Actively supported: 4.3 (first released 2026-04-23, now at 4.3.6), 4.2 and 4.1.
- Still 'supported': 4.0 and 3.13.

---

## 2. Lessons from dual-mode reference products

| Product | Desktop shell | Engine | Server / web mode | Lesson for us |
| --- | --- | --- | --- | --- |
| **Headlamp** (kubernetes-sigs) | Electron | Go `headlamp-server` binary. The Electron main process `spawn`s it, picks a free port (default 4466), sets `HEADLAMP_BACKEND_TOKEN`, waits for a readiness marker, and loads the UI from bundled resources ([main.ts](https://raw.githubusercontent.com/kubernetes-sigs/headlamp/main/app/electron/main.ts), [architecture](https://headlamp.dev/docs/latest/development/architecture)) | Same Go server and React UI deployed in the cluster, with OIDC. 'Headlamp only forwards the token to the API server' ([oidc](https://headlamp.dev/docs/latest/installation/in-cluster/oidc)). One browser WebSocket fans out to many upstream sockets. Plugins work in both modes. | **This is the closest template for our product.** It is also a warning: after the move to the Kubernetes SIG, Windows builds were temporarily 'not signed/notarized as before' ([desktop install](https://headlamp.dev/docs/latest/installation/desktop/)). |
| **RedisInsight** | Electron | NestJS (Node) API and React UI in a single repo ([repo](https://github.com/redis/RedisInsight)) | Docker image listens on 0.0.0.0:5540; the desktop app uses 127.0.0.1:5530. `RI_ENCRYPTION_KEY` (Docker only) encrypts stored secrets. Connections can be preconfigured through environment variables or a JSON file. `RI_DATABASE_MANAGEMENT=false` locks them. No built-in user authentication. Licensed under SSPL ([config](https://redis.io/docs/latest/operate/redisinsight/configuration/)). | Proves 'TypeScript everywhere' works. Shows that operators want preconfiguration and lock-down switches. |
| **pgAdmin 4** (docs 9.18) | Electron runtime | Python server | Server mode supports internal accounts, LDAP, Kerberos, OAuth2, web-server authentication and 2FA. The desktop runtime overrides `SERVER_MODE` at startup and uses a random port ([desktop deployment](https://www.pgadmin.org/docs/pgadmin4/latest/desktop_deployment.html)). | One codebase switched by a mode flag. Desktop mode has stored saved passwords in the OS password store by default since v7.2; otherwise a master password is used ([master password](https://www.pgadmin.org/docs/pgadmin4/latest/master_password.html)). |
| **Hoppscotch** | Tauri v2, wrapping the web client | Node (self-hosted) | A self-hosted instance must whitelist the desktop origins (`app://...` and `http://app....`). The browser's CORS limits are worked around with a local **Agent** paired by a one-time code ([interceptor](https://docs.hoppscotch.io/documentation/features/interceptor), [setup](https://docs.hoppscotch.io/documentation/clients/desktop/setup)). | Web-first app with a thin native wrapper, plus the local-agent pattern. Desktop versions use YY.M.patch because 'a Windows MSI major version cannot exceed 255' ([overview](https://docs.hoppscotch.io/documentation/clients/desktop/overview.md)). |
| **Kafka UI (kafbat)** | none (web only) | Java/Spring | RBAC built from resource × action pairs, including topic MESSAGES_READ, MESSAGES_PRODUCE and MESSAGES_DELETE. OAuth2 and LDAP sign-in. Audit log written to a Kafka topic or the console, either ALTER_ONLY (the default) or ALL. Data masking (REMOVE, REPLACE, MASK). Pluggable message serializers ([rbac](https://ui.docs.kafbat.io/configuration/rbac-role-based-access-control), [audit](https://ui.docs.kafbat.io/configuration/audit-log), [masking](https://ui.docs.kafbat.io/configuration/data-masking)). | The checklist for our team mode. |
| **Conduktor** | Desktop app: end of life by end of 2025, authentication backend turned off. Replaced by Console (web / Docker). | — | Desktop could not deliver 'shared access, audit trails, role-based permissions, and a deployment story' ([docs](https://docs.conduktor.io/desktop.md)). | A desktop-only product stays limited to individual developers. |
| **Bruno, Beekeeper Studio, Freelens** | Electron (with React 19 / with Vue / a fork of Lens) | Node | — | Electron dominates data-dense developer tools. Freelens ships through Homebrew Cask, WinGet and Flathub ([README](https://cdn.jsdelivr.net/gh/freelensapp/freelens@main/README.md)). |
| **Yaak** | Tauri, Rust and React | Rust. TypeScript plugins run 'in a NodeJS runtime' alongside the app ([README](https://cdn.jsdelivr.net/gh/mountain-loop/yaak@main/README.md)). | — | Even Tauri apps end up shipping a JavaScript runtime for plugins. |
| **Kreya** (2021 blog post; may be outdated) | A fork of SpiderEye, using system webviews | C#, running in-process | — | Rejected Electron because it ships Chromium with every update, and rejected Avalonia because it had no embedded WebView at the time ([blog](https://kreya.app/blog/how-we-built-kreya/)). |

**INFERENCE:** the pattern is consistent. Successful dual-mode tools pair one single-page app with one engine. The engine runs next to the user or next to the infrastructure, and the desktop shell is little more than a launcher.

---

## 3. Desktop and UI framework comparison (as of 2026-10-16)

| Framework | Version / maturity | Rendering | Measured size | Measured memory | Linux | Updater | Reuse in the web app | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Electron** | 44.8.0 (2026-10-16): Chromium 152, Node 24.22. Only the three newest majors are supported ([releases](https://releases.electronjs.org/)). | Bundled Chromium, identical on every OS | ≈385 MB unpacked on Windows ([Elanis CI, 10/2026](https://github.com/Elanis/web-to-desktop-framework-comparison)); 323 MB macOS distribution for a complex app ([Better Stack, 2026-07-20](https://betterstack.com/community/guides/scaling-nodejs/tauri-vs-electron-vs-deno-vs-electrobun/)) | 279 MB on Windows (release build); 128 MB idle on macOS | Consistent rendering; AppImage, deb, rpm, snap and flatpak packaging | electron-updater supports DMG, NSIS, AppImage, deb, rpm and pacman, with staged rollouts (`stagingPercentage`) and blockmap delta downloads ([docs](https://www.electron.build/docs/features/auto-update)) | 100% (web UI) | **Shell for v1** |
| **Tauri 2** | 2.12.4 (2026-10-14) ([crates.io](https://crates.io/api/v1/crates/tauri)) | System webview: WebView2, WKWebView or WebKitGTK ([webview versions](https://v2.tauri.app/reference/webview-versions/)) | ≈3 MB hello-world; 57 MB complex app | 307 MB on Windows; 109 MB idle on macOS | Bug #3988, 'bad performance on linux' with large DOMs, blamed on WebKitGTK ([issue](https://github.com/tauri-apps/tauri/issues/3988)) | Built-in updater. Signatures are mandatory and 'cannot be disabled'. No deb/rpm updates ([updater](https://v2.tauri.app/plugin/updater/)). | 100% | Viable alternative; Linux is the risk |
| **Tauri 3** | 3.0.0-alpha.5 (2026-10-14). Milestone 25% complete: GTK4 / WebKitGTK 6.0 ([milestone](https://github.com/tauri-apps/tauri/milestone/5)) | Optional CEF (bundled Chromium) runtime | CEF makes bundles 'hundreds of megabytes larger' ([cef](https://v3.tauri.app/develop/cef/)) | Higher with CEF | Fixes cross-platform consistency | Same as Tauri 2 | 100% | Watch |
| **Wails v3** | Beta (launched 2026-08-02 per search summary); beta.30 released 2026-10-15 ([releases](https://github.com/wailsapp/wails/releases)) | Native webviews ('no embedded browser') | ≈11 MB | 317 MB on Windows | WebKitGTK, same caveat as Tauri | Built-in updater: GitHub Releases, Sparkle and Keygen providers, Ed25519 signatures ([updater](https://docs-preview.wails.io/guides/updater/)) | `-tags server` builds the same app as a plain HTTP server. Backend events are 'broadcast to all connected browsers', which is not a multi-user model ([example](https://pkg.go.dev/github.com/wailsapp/wails/v3/examples/server)). | Watch; a later option for a Go engine |
| **Avalonia 12** | 12.0.0 stable 2026-04-07; 12.1.4 on 2026-10-09 ([NuGet](https://www.nuget.org/packages/Avalonia/)). WebView control open-sourced. | Skia; controls are drawn by the framework | Small to medium | n/a | Good | No built-in updater (Velopack can fill the gap) | Browser/WebAssembly support is 'experimental'. In practice you would maintain a second UI. | Breaks the single-codebase goal |
| **.NET MAUI Blazor Hybrid** | No official Linux support. The Avalonia MAUI backend is in preview (on .NET 11) ([Avalonia blog](https://avaloniaui.net/blog/net-maui-is-coming-to-linux-and-the-browser-powered-by-avalonia), [devclass](https://www.devclass.com/development/2026/03/24/avaloniaui-enhances-net-maui-with-linux-and-webassembly-support/5209515)) | Native or Blazor WebView | — | — | Fails the Linux requirement | — | Blazor code | No |
| **Photino.NET** | 4.0.16, last released 2025-01-23. Forks (PhotinoX, PhotinoXDX) have appeared ([NuGet](https://www.nuget.org/packages/Photino.NET/)) | System webviews | Small | — | WebKitGTK | None | Blazor code | No (stale) |
| **Flutter** | Desktop and web are stable | Canvas | Medium | — | OK | None built in | The web build renders to a canvas. Flutter's own docs say text-rich content suits the document-centric web model ([docs](https://docs.flutter.dev/platform-integration/web/renderers)). | No |
| **Neutralinojs** | 6.8.0 (2026-06-03) | System webviews | ≈2 MB | 487 MB on Windows | WebKitGTK | None | Extensions over WebSocket in any language | No |
| **Compose Multiplatform** | Desktop runs on the JVM. The web target (WebAssembly) reached Beta in 1.9.0, September 2025 ([JetBrains](https://blog.jetbrains.com/kotlin/2025/09/compose-multiplatform-1-9-0-compose-for-web-beta/)). | Skia canvas | JVM-sized | — | OK | None | Canvas-based web, Beta | No, unless the team is Kotlin |
| **Electrobun / Deno Desktop** | Electrobun 1.0 (February 2026). Deno Desktop is experimental (Deno 2.9, June 2026). | System webview; Deno can also use CEF | 418 MB / 111 MB in the Better Stack test | 208 MB / 98 MB idle | — | Electrobun has a built-in patch updater | 100% | Watch |

### Reading the matrix (INFERENCE)
- **Only web-technology shells reuse 100% of the UI in the browser app.** Avalonia, Flutter and Compose render to a canvas. They would force either a second UI or a canvas-rendered web app.
- **Memory is not a decisive advantage for Tauri.** Measured memory is roughly equal: Windows release builds use 279 MB (Electron) against 307 MB (Tauri), and macOS idle use is 128 MB against 109 MB. Download size is the real difference.
- **Linux rendering is the risk** for a DOM-heavy IDE built on Tauri 2 or Wails.

---

## 4. Engine language comparison: RabbitMQ client maturity first

| Language | AMQP 0-9-1 | AMQP 1.0 (RabbitMQ 4.x) | Streams | Management HTTP API client | Embedding as a sidecar | Multi-user server |
| --- | --- | --- | --- | --- | --- | --- |
| **Go** | amqp091-go, maintained by the RabbitMQ team. v1.15.0 on 2026-09-15. v1.13.0 (2026-07-21) added 'automatic topology recovery', SASL credential zeroing, a TLS 1.2 minimum, and frame_max enforcement ([versions](https://pkg.go.dev/github.com/rabbitmq/amqp091-go?tab=versions), [v1.13.0](https://newreleases.io/project/github/rabbitmq/amqp091-go/release/v1.13.0)) | Official client: v1.0.0 on 2026-04-13, v1.4.0 on 2026-08-26. Wraps Azure's go-amqp library ([versions](https://pkg.go.dev/github.com/rabbitmq/rabbitmq-amqp-go-client?tab=versions)). | Official client: v1.8.3 on 2026-07-23 | rabbit-hole, released 2013, BSD-2 licence ([repo](https://github.com/michaelklishin/rabbit-hole)) | Single static binary of roughly 10–25 MB (INFERENCE). Easy cross-compilation. cgo-free SQLite for every target ([modernc](https://pkg.go.dev/modernc.org/sqlite)). | Excellent: goroutines; Headlamp is a precedent |
| **TypeScript / Node** | amqplib 2.2.0, community-maintained. Opt-in recovery since 1.1.0; bundled types since 1.2.0 ([changelog](https://cdn.jsdelivr.net/npm/amqplib@2.0.1/CHANGELOG.md)). | rabbitmq-amqp-js-client 1.0.0 (2026-06-26), listed as official but built by coders51. Its `rhea` dependency is pulled from a GitHub URL ([npm](https://registry.npmjs.org/rabbitmq-amqp-js-client/latest), [announcement](https://groups.google.com/g/rabbitmq-users/c/fF3W3NQJtkQ)). | rabbitmq-stream-js-client 1.1.0, by coders51 | None worth naming (it is plain REST) | Free inside Electron via `utilityProcess`. As a sidecar elsewhere: Node single-executable apps are tested only on macOS arm64 ('x64 is not currently supported') ([SEA](https://nodejs.org/api/single-executable-applications.html)). `bun --compile` admits its 'binary is still way too big' ([bun](https://bun.sh/docs/bundler/executables)). | Good for I/O-bound work. Heavy message decoding needs worker threads. |
| **C# / .NET** | RabbitMQ.Client 7.2.2 (2026-08-05), 537.7M total downloads | RabbitMQ.AMQP.Client 1.4.0 (2026-09-09) | RabbitMQ.Stream.Client 1.12.1 (2026-09-09) | EasyNetQ.Management.Client 3.0.1 (2025-10-17) | Self-contained builds run to tens of MB. Native AOT is smaller, but ASP.NET Core AOT supports JWT only, not other authentication schemes; MVC, Session and SPA are unsupported; SignalR is partial ([AOT](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot)). RabbitMQ.Client does not declare AOT compatibility. | Excellent |
| **Rust** | lapin 4.12.2 (2026-10-13), community-maintained | No official client. fe2o3-amqp 0.18.x is community-maintained. | Official client 0.11.0 (2026-03-18), still pre-1.0 | rabbitmq_http_client 0.93.0, which powers rabbitmqadmin v2 | Smallest footprint; runs natively inside Tauri | Excellent, but slower to build features |
| **Java / Kotlin** | Official | Official | Official | Hop 5.7.0 | A JVM sidecar is heavy | Excellent (kafbat is a precedent) |

**INFERENCE:**
- **Go** is the only lightweight language with all of the following:
  - official RabbitMQ-team clients for all three protocols
  - a mature management API client
  - one binary that works both as a desktop sidecar and as a team server
- **Java and .NET** have equally strong official coverage but are heavier as a sidecar.
- **Node** has the weakest official story.
- **Rust** lacks an official AMQP 1.0 client.

---

## 5. Front-end building blocks

| Need | Recommended pick (licence) | Notes and alternatives |
| --- | --- | --- |
| UI framework | React + TypeScript (MIT) | Glide Data Grid is React-only. xyflow supports React and Svelte. dockview supports React, Vue and Angular. |
| Message grids (100k to 1M rows) | Glide Data Grid (MIT, canvas-based, 'millions of rows'). TanStack Table + TanStack Virtual (MIT, 10–15 kB) for lists of objects. | AG Grid Community is MIT. AG Grid Enterprise costs **$999 per developer**; grouping, pivoting, Excel export and clipboard are Enterprise-only ([pricing](https://www.ag-grid.com/license-pricing/)). Canvas grids need extra ARIA work. |
| Topology graph | React Flow / xyflow 12 (MIT), laid out with ELK.js (**EPL-2.0**, runs in a web worker) or @dagrejs/dagre (MIT; the original dagre package is unmaintained) | Cytoscape.js (MIT). Sigma.js (MIT, WebGL) for very large graphs. |
| JSON / code editor | CodeMirror 6 (MIT). 'Works well with screen readers and keyboard-only users' and supports native mobile selection. | Monaco (MIT) gives a VS Code feel, but it is 'not supported in mobile browsers' and its web workers cannot start from `file://` ([monaco](https://github.com/microsoft/monaco-editor)). |
| Charts | uPlot (MIT, about 50 kB). Renders 166,650 points in 25 ms and streams at 60 fps. | ECharts (Apache-2.0) for richer dashboards |
| IDE layout | dockview (MIT core): tabs, floating groups, pop-out windows, layout serialization | A commercial enterprise add-on also exists |
| Engine API | OpenAPI-generated TypeScript client plus one multiplexed WebSocket, or ConnectRPC | Connect supports only server-streaming in browsers ([connect](https://connectrpc.com/docs/web/getting-started)) |

---

## 6. Reference architectures

### A. TypeScript everywhere (the RedisInsight model)
**Shape:**
- React UI.
- A TypeScript engine package.
- On desktop, Electron hosts the engine in a `utilityProcess` ('a child process with Node.js and Message ports enabled').
- On the web, the same package runs as a Node server in Docker.

**Pros:**
- One language and one type system end to end.
- Fastest iteration.
- No separate sidecar binary.
- `node:sqlite` is now 'Release candidate' (since v25.7.0), which avoids native-module rebuilds.

**Cons and risks:**
- The weakest set of RabbitMQ clients.
- CPU-heavy decoding and filtering need worker threads.
- Moving to Tauri later would mean shipping Node as a sidecar, which fails on Intel Macs.

**Best fit:** a solo TypeScript developer optimising for time to market.

### B. Go engine + React UI + thin shell (the Headlamp model) — RECOMMENDED
**Shape:** a Go engine binary with several run modes. The desktop shell can be one of three:
- **B1: Electron.** Spawn the engine and pass it a token, as Headlamp does.
- **B2: Tauri 2 with a sidecar.** Uses `externalBin` with `-$TARGET_TRIPLE` names and shell-plugin permissions ([sidecar](https://v2.tauri.app/develop/sidecar/)).
- **B3: Wails v3 (later).** The Go engine runs in-process.

**Pros:**
- Official clients for all three protocols.
- A tiny binary that cross-compiles to arm64 targets.
- Goroutines cope with hundreds of broker connections in team mode.

**Cons:**
- Two languages and an API contract to maintain. Generate the client from the contract.
- Sidecar lifecycle handling: port, readiness, crash restart, orphan processes.
- An extra binary to sign and notarize.
- Electron's size, and its upgrade treadmill.

### C. .NET engine (ASP.NET Core) + React UI + Electron or Tauri shell
**Pros:**
- First-class OIDC, policy-based authorization, rate limiting and SignalR.
- All three protocols have official clients.

**Cons:**
- A large sidecar, and the Native AOT limits listed above.
- The .NET-native cross-platform UIs fail the brief:
  - MAUI has no Linux support.
  - Photino is stale.
  - Avalonia would mean a second UI for the web.

**Best fit:** a C# team. The topology is the same as B.

### D. Rust core inside Tauri, plus an axum server
- Smallest option, with no sidecar.
- No official AMQP 1.0 client, and slower to build features.
- Not recommended for v1.

---

## 7. Recommended design (IDEA)

### One engine, four deployment shapes
1. **Desktop.** Electron spawns `engine --mode=desktop`. The engine:
   - binds to 127.0.0.1 on a random port;
   - requires a 256-bit token generated at each launch;
   - checks the Host and Origin headers, as a defence against DNS rebinding;
   - accepts requests only from the `app://` origin.

   Load the UI over a custom protocol. This follows Electron's security checklist and also lets Monaco's web workers start ([checklist](https://www.electronjs.org/docs/latest/tutorial/security)).
2. **Personal web.** `engine serve --single-user` runs the same UI in a local browser or in a single Docker container.
3. **Team server.** `engine serve --team` adds:
   - OIDC sign-in and RBAC
   - audit logging and data masking
   - per-user quotas
   - an encrypted credential vault
   - Postgres storage and a Helm chart

   Adding new connections becomes admin-controlled.
4. **Hybrid.** The desktop app can attach to a team server as a 'remote workspace', to reach brokers inside private networks. An optional local agent covers the reverse case: a hosted UI reaching a broker on the developer's own machine.

### Credentials
- **Desktop:** Electron `safeStorage` wraps a data key. The engine uses that key to encrypt secrets in SQLite. On Linux, safeStorage may fall back to `basic_text`, which uses a 'hardcoded plaintext password' ([safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)). In that case, require a master password.
- **Team server:** use envelope encryption with a key-encryption key from an environment variable or a KMS. Optionally integrate HashiCorp Vault, including its RabbitMQ secrets engine, which issues short-lived per-user broker credentials ([vault](https://developer.hashicorp.com/vault/docs/secrets/rabbitmq)). Or pass the user's OAuth2 token through to RabbitMQ.

### Why Electron rather than Tauri for v1 (INFERENCE)
1. The engine is written in Go, so Tauri's Rust core brings no advantage.
2. The UI is DOM-heavy, and Linux developers are a core RabbitMQ audience.
3. Measured memory is roughly equal.
4. Electron's updater is mature and covers every Linux package format.

Keep the shell swappable behind a thin platform bridge. Revisit when Tauri 3 or Wails v3 reaches general availability.

### Repository layout
- `/engine` — Go engine
- `/ui` — React UI
- `/desktop` — Electron shell
- `/api` — API contract and code generation
- `/deploy` — Docker and Helm
- `/e2e` — end-to-end tests: Playwright against a Testcontainers matrix of RabbitMQ 3.13 to 4.3

---

## 8. Distribution, signing, updates and costs

| Platform | Formats and channels | Signing (FACT) | Updates | Cost |
| --- | --- | --- | --- | --- |
| macOS (arm64 + x64) | DMG and zip; Homebrew cask | Developer ID certificate plus notarization. Homebrew 'will disable all ... casks that fail Gatekeeper checks in September 2026' and removed `--no-quarantine` ([5.0.0](https://brew.sh/2025/11/12/homebrew-5.0.0/)). Homebrew moves Intel to Tier 3 in September 2026. | electron-updater (the app must be signed) | $99 per year ([Apple](https://developer.apple.com/programs/whats-included/)) |
| Windows (x64 + arm64) | NSIS installer; winget manifest; MSIX in the Microsoft Store | Artifact Signing 'starts at $9.99/month'. 'EV certificates no longer bypass SmartScreen'. Store apps are re-signed by Microsoft and show no SmartScreen prompt. Smart App Control blocks unsigned files ([SmartScreen](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)). Individual developers qualify only in the US or Canada; organisations qualify in the US, CA, EU, UK, AU, NZ, JP, KR, SG, CH, NO and IL ([quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)). | NSIS updater, or Store updates | Store registration is free ([Partner Center](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account)) |
| Linux (x64 + arm64) | AppImage, deb, rpm, Flathub, Snap | Flathub: 'All source available submissions must be built entirely from source code' ([flathub](https://docs.flathub.org/docs/for-app-authors/requirements)) | AppImage self-updates; deb/rpm through hosted repositories | $0 |
| Server | Multi-arch OCI image; Helm chart as an OCI artifact ([helm](https://helm.sh/docs/topics/registries/)) | Sigstore / cosign | Image tags | Docker Hub allows 100 pulls per 6 hours unauthenticated and 200 for a personal account ([limits](https://docs.docker.com/docker-hub/usage/)), so publish to GHCR as well |

**Gotcha:** keep the MSI major version at 255 or below. This is why Hoppscotch uses YY.M.patch.

---

## 9. Risks and watch list
- **Electron** supports only three majors at a time. Automate the upgrades.
- **Go AMQP 1.0 client** is young (GA 2026-04-13). Keep AMQP 0-9-1 as the primary protocol path.
- **Frameworks to watch:**
  - Tauri 3 with CEF
  - Wails v3 reaching general availability
  - Electrobun
  - Deno Desktop
- **Licensing:**
  - AG Grid Enterprise and dockview-enterprise are commercial.
  - ELK is EPL-2.0, a weak copyleft licence.
- **Code signing** is an operational capability as well as a cost. Headlamp lost signing for a period.

## Feature ideas

| Idea | Persona | Priority | Size | Description | Evidence / inspiration |
| --- | --- | --- | --- | --- | --- |
| One engine, multiple run modes | platform | must | L | A single Go engine binary runs in three ways: as the desktop engine; via 'serve --single-user' (local browser or Docker); and via 'serve --team' (SSO, RBAC, audit). The React UI is identical in every mode. | Headlamp (Electron with a Go server, same server in-cluster); RedisInsight (Electron and Docker from one repo); pgAdmin SERVER_MODE flag |
| Hardened local engine channel | team-security | must | M | The engine binds to 127.0.0.1 on a random port. A per-launch 256-bit token reaches the renderer through preload IPC. The engine validates Host and Origin headers and accepts CORS only from the app:// origin. | Headlamp main.ts (HEADLAMP_BACKEND_TOKEN, findAvailablePort); pgAdmin random port; Electron security checklist |
| OIDC SSO for the team server | team-security | must | M | Sign-in through any OIDC provider, with group claim mapping. Also LDAP/AD and a break-glass local admin. | pgAdmin server-mode auth sources; kafbat OAuth2/LDAP; Headlamp OIDC |
| Fine-grained RBAC with message-level actions | team-security | must | L | Users and groups (regex allowed) are bound to connection, vhost or resource patterns with actions such as VIEW, MESSAGES_READ, MESSAGES_PUBLISH, REPUBLISH, PURGE, DELETE, DEFINITIONS_EDIT, POLICIES_EDIT and USERS_ADMIN. | kafbat RBAC resource/action model |
| Tamper-evident audit log | team-security | must | M | Record every mutating action, and optionally every message read. Defaults to ALTER_ONLY, with an ALL option. Export as stdout JSON, OTel logs, syslog or webhook. Entries are hash-chained. | kafbat audit log; Conduktor's audit-trail rationale |
| OAuth 2.0 identity pass-through to RabbitMQ | team-security | should | L | Forward the user's JWT as a bearer token on the management API and as the password on AMQP connections. Refresh via update-secret or /auth/tokens. RabbitMQ then enforces the permissions itself. | RabbitMQ OAuth2 docs; management.oauth_enabled; Headlamp forwarding tokens to the API server |
| Server-side credential vault | team-security | should | M | Envelope encryption with a key-encryption key from env or KMS. HashiCorp Vault integration, including dynamic per-user broker credentials. Kubernetes secrets support. | RedisInsight RI_ENCRYPTION_KEY; Vault RabbitMQ secrets engine |
| Declarative preconfigured connections and lockdown | operator | should | S | Admins define connections, environment colours and defaults through env vars, a JSON/YAML file or Helm values, and can disable ad-hoc connection management. | RedisInsight RI_PRE_SETUP_DATABASES_PATH and RI_DATABASE_MANAGEMENT=false |
| Role-aware data masking | team-security | should | M | Rules (REMOVE, REPLACE or MASK) by JSON path or regex, per vhost/queue pattern. Applied in the engine, before the browser or any export sees the data. | kafbat data masking |
| UI extension points | platform | could | L | A plugin API for sidebar entries, panels, message renderers and actions, loadable in both desktop and web. | Headlamp plugins; Yaak TypeScript plugins |
| Remote workspaces (desktop to team server) | developer | should | M | Lets the desktop app attach to a team server, so brokers that are only reachable inside a cluster can be used with SSO. | Hoppscotch desktop connecting to self-hosted instances; VS Code Remote; Headlamp in-cluster |
| Local agent for the web app | developer | could | M | A small paired agent (one-time code) that lets a hosted web UI reach brokers on the user's machine or private network. | Hoppscotch Agent |
| Zero-backend lite web mode | operator | could | S | A static UI that uses only the management API, with CORS enabled. AMQP features are clearly disabled. | management.cors.allow_origins; the management UI itself is an SPA over the HTTP API |
| Typed engine API with multiplexed streaming | platform | must | M | An OpenAPI or ConnectRPC contract with a generated TypeScript client. One WebSocket per session carries live tails, stats and job progress, with backpressure and per-subscription quotas. | Headlamp single-WebSocket fan-out; Connect for Web server-streaming |
| Prometheus-aware metrics backend | operator | must | M | Time-series data and drain forecasts come from rabbitmq_prometheus or an existing Prometheus, with fallback to management stats. | RabbitMQ Prometheus docs; management_agent.disable_metrics_collector |
| Large-cluster-safe management API client | operator | must | S | Always paginates (max 500 per page), uses disable_stats and enable_queue_totals, and caches and diffs results. | RabbitMQ HTTP API reference |
| Multi-protocol engine | developer | must | L | AMQP 0-9-1, AMQP 1.0 and the Stream protocol (including super streams and filtering) using the official Go clients. | Official client list; pkg.go.dev versions |
| Auto-update with channels and staged rollout | all | must | M | Stable and beta channels, staged percentage rollouts, delta downloads, signed manifests, and a switch for enterprises to disable updates. | electron-updater stagingPercentage and blockmap; Tauri and Wails updaters |
| Package-manager presence | developer | should | M | Homebrew cask, winget, Microsoft Store (MSIX), Flathub, Snap, AppImage, apt/yum repositories, Scoop. | Freelens distribution channels; free Microsoft Store registration |
| Cloud-native server packaging | platform | must | M | Multi-arch OCI image on GHCR and Docker Hub, Helm chart as an OCI artifact, health and readiness endpoints, reverse-proxy subpath support. | Helm OCI support; Docker Hub pull limits; RedisInsight RI_PROXY_PATH |
| Storage that scales from SQLite to Postgres | platform | should | L | Pure-Go SQLite for desktop and small servers; Postgres for highly available team servers with stateless replicas. | modernc.org/sqlite (cgo-free) |
| Million-row message browser | developer | must | M | A canvas grid with virtualization, JSON-path columns and incremental loading. | Glide Data Grid; TanStack Virtual |
| Topology graph at scale | developer | should | M | ELK layout in a web worker, filtering and focus views, with a WebGL renderer for very large topologies. | xyflow; elkjs workers; Sigma.js WebGL |
| Accessible JSON editor | developer | should | S | CodeMirror 6 by default, with JSON-schema validation. Monaco is optional on desktop. | Monaco not supported on mobile; CodeMirror accessibility claims |
| Responsive on-call web UI | operator | could | M | A mobile layout for queue health, alerts and approved actions on the team server. | INFERENCE from the web mode |
| Headless CLI and automation API | platform | could | M | The same engine exposes a CLI (export, import, republish, tail) and an authenticated REST API for CI pipelines. | rabbitmqadmin v2 shows demand for scriptable tooling |
| Git-friendly workspace files | developer | could | M | Optionally keep connections (without secrets), views and templates as plain files. | Bruno filesystem collections |
| Version- and Tanzu-aware feature gating | operator | must | M | Detect broker version, plugins, feature flags and Tanzu-only capabilities, and adapt the UI for RabbitMQ 3.13 through 4.3. | RabbitMQ release information; Broadcom list of Tanzu-only features |
| Accessibility baseline | all | should | M | Keyboard navigation, screen-reader labels, high-contrast themes and ARIA fallbacks for canvas grids. | CodeMirror accessibility; Glide accessibility caveat |
| Shell-agnostic platform bridge | platform | should | M | Dialogs, notifications, tray, deep links and secure storage sit behind a thin interface, so the shell can be swapped later. | Tauri 3 CEF alpha; Wails v3 beta |
| MSI-safe version scheme | platform | should | S | Keep the version major at 255 or below for Windows installers. | Hoppscotch YY.M.patch rationale |
| Redacted diagnostics bundle | all | could | S | One-click support bundle (engine logs, versions, broker capabilities) that is never uploaded automatically. | INFERENCE |

## Claims flagged for verification

- **[high]** AMQP 1.0 over WebSocket (rabbitmq_web_amqp) is closed-source and Tanzu-only (4.1+). Open-source RabbitMQ gives browsers only Web-STOMP and Web-MQTT.
  - Why it matters: Makes an engine process mandatory in both desktop and web modes.
  - Sources: https://www.rabbitmq.com/blog/2025/04/16/amqp-websocket https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-rabbitmq-oci/4-2/tanzu-rabbitmq-oci-image/site-tanzu-rabbitmq-features.html https://www.rabbitmq.com/docs/web-stomp
- **[high]** The RabbitMQ team maintains official Go clients for AMQP 0-9-1 (v1.15.0, 2026-09-15; automatic topology recovery since v1.13.0), AMQP 1.0 (v1.0.0, 2026-04-13) and Streams (v1.8.3, 2026-07-23).
  - Why it matters: Main argument for a Go engine.
  - Sources: https://pkg.go.dev/github.com/rabbitmq/amqp091-go?tab=versions https://pkg.go.dev/github.com/rabbitmq/rabbitmq-amqp-go-client?tab=versions https://pkg.go.dev/github.com/rabbitmq/rabbitmq-stream-go-client?tab=versions https://newreleases.io/project/github/rabbitmq/amqp091-go/release/v1.13.0
- **[medium]** Node has no RabbitMQ-team AMQP 0-9-1 or stream client. The official-listed AMQP 1.0 JS client reached 1.0.0 on 2026-06-26 and pulls rhea from a GitHub URL.
  - Why it matters: Main risk of the TypeScript-everywhere option.
  - Sources: https://registry.npmjs.org/rabbitmq-amqp-js-client/latest https://groups.google.com/g/rabbitmq-users/c/fF3W3NQJtkQ https://www.rabbitmq.com/client-libraries/devtools
- **[high]** Tauri 2 (2.12.4) uses WebKitGTK on Linux, which has known performance problems with DOM-heavy UIs. GTK4/WebKitGTK 6 and the CEF runtime exist only in Tauri 3.0 alpha (alpha.5, 2026-10-14).
  - Why it matters: Decides the desktop shell for a data-dense IDE.
  - Sources: https://crates.io/api/v1/crates/tauri https://github.com/tauri-apps/tauri/issues/3988 https://v3.tauri.app/develop/cef/ https://github.com/tauri-apps/tauri/milestone/5
- **[medium]** Measured memory is similar for Tauri and Electron: Windows release 307 vs 279 MB, macOS idle 109 vs 128 MB. Bundle size differs by roughly 10x.
  - Why it matters: Prevents choosing a shell for the wrong reason.
  - Sources: https://github.com/Elanis/web-to-desktop-framework-comparison https://betterstack.com/community/guides/scaling-nodejs/tauri-vs-electron-vs-deno-vs-electrobun/
- **[medium]** Wails v3 is still beta (beta.30, 2026-10-15). Its server build mode broadcasts events to all connected browsers.
  - Why it matters: Wails server mode cannot serve as the multi-user team server.
  - Sources: https://github.com/wailsapp/wails/releases https://pkg.go.dev/github.com/wailsapp/wails/v3/examples/server
- **[high]** Electron 44.8.0 (2026-10-16) bundles Chromium 152 and Node 24.22, and only the three newest majors are supported.
  - Why it matters: Sets the cost of keeping the shell up to date.
  - Sources: https://releases.electronjs.org/ https://isitpatched.com/eol/electron
- **[high]** Homebrew will disable casks that fail Gatekeeper checks in September 2026, and it has removed --no-quarantine.
  - Why it matters: Notarized macOS builds become mandatory for a key distribution channel.
  - Sources: https://brew.sh/2025/11/12/homebrew-5.0.0/ https://docs.brew.sh/Homebrew-Security-and-Supply-Chain
- **[high]** Artifact Signing starts at $9.99/month and is open to individual developers only in the US or Canada. EV certificates no longer bypass SmartScreen. Microsoft Store registration is free, and the Store re-signs apps.
  - Why it matters: Determines the Windows signing budget and whether the developer is eligible.
  - Sources: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account
- **[high]** ASP.NET Core Native AOT supports JWT authentication but not other authentication schemes, MVC, Session or SPA. Minimal APIs and SignalR are only partially supported.
  - Why it matters: Limits the .NET sidecar architecture.
  - Sources: https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot
- **[high]** Node single-executable apps are tested on macOS arm64 only; x64 is not supported.
  - Why it matters: A Node sidecar inside Tauri would be risky on Intel Macs.
  - Sources: https://nodejs.org/api/single-executable-applications.html
- **[high]** Conduktor ended its desktop app (auth backend turned off) because desktop could not provide shared access, audit trails or RBAC.
  - Why it matters: Supports investing early in a team web mode.
  - Sources: https://docs.conduktor.io/desktop.md
- **[high]** The management API's get endpoint is for development and troubleshooting only. The management UI is not a long-term metrics store; Prometheus is recommended.
  - Why it matters: Peek and metrics must be built in the engine.
  - Sources: https://www.rabbitmq.com/docs/http-api-reference https://www.rabbitmq.com/docs/prometheus
- **[high]** On Linux without a secret store, Electron safeStorage falls back to basic_text, which uses a hardcoded password.
  - Why it matters: Shapes desktop credential storage on Linux.
  - Sources: https://www.electronjs.org/docs/latest/api/safe-storage

## Open questions

- Neither is disclosed.
- What is the exact current Artifact Signing price, and is the developer's country eligible? Individual developers qualify only in the US or Canada.
- Is RabbitMQ.Client 7.x compatible with trimming and Native AOT?
- When will Tauri 3 reach GA, will its CEF runtime be production-ready, and does WebKitGTK 6 fix DOM-heavy performance?
- When will Wails v3 reach GA, and will its server mode gain per-session isolation and auth hooks?
- Is rabbitmq-stream-js-client officially supported by the RabbitMQ team?
- Do the Tauri bundler and electron-builder automatically sign and notarize sidecar binaries?
- Will the product be open-core or closed? This decides whether AG Grid Enterprise, dockview-enterprise and EPL-licensed ELK are acceptable, and how the Flathub build-from-source rule applies.
- Should MQTT and STOMP inspection be in scope for v1?
- The web-search budget ran out mid-research. Some details rely only on search snippets: the Wails v3 beta launch date, Electrobun 1.0, Deno 2.9 and the Bruno version.

## Sources

- https://headlamp.dev/docs/latest/development/architecture
- https://raw.githubusercontent.com/kubernetes-sigs/headlamp/main/app/electron/main.ts
- https://headlamp.dev/docs/latest/installation/in-cluster/oidc
- https://headlamp.dev/docs/latest/installation/desktop/
- https://headlamp.dev/docs/latest/development/plugins/
- https://github.com/redis/RedisInsight
- https://redis.io/docs/latest/operate/redisinsight/configuration/
- https://www.pgadmin.org/docs/pgadmin4/latest/desktop_deployment.html
- https://www.pgadmin.org/docs/pgadmin4/latest/master_password.html
- https://docs.hoppscotch.io/documentation/clients/desktop/overview.md
- https://docs.hoppscotch.io/documentation/clients/desktop/setup
- https://docs.hoppscotch.io/documentation/features/interceptor
- https://ui.docs.kafbat.io/configuration/rbac-role-based-access-control
- https://ui.docs.kafbat.io/configuration/audit-log
- https://ui.docs.kafbat.io/configuration/data-masking
- https://ui.docs.kafbat.io/configuration/serialization-serde
- https://docs.conduktor.io/desktop.md
- https://www.conduktor.io/auth-failure.md
- https://www.mintlify.com/usebruno/bruno/contributing/architecture
- https://desktopinsights.com/apps/beekeeper-studio
- https://cdn.jsdelivr.net/gh/freelensapp/freelens@main/README.md
- https://cdn.jsdelivr.net/gh/mountain-loop/yaak@main/README.md
- https://kreya.app/blog/how-we-built-kreya/
- https://releases.electronjs.org/
- https://isitpatched.com/eol/electron
- https://www.electronjs.org/docs/latest/api/safe-storage
- https://www.electronjs.org/docs/latest/api/utility-process
- https://www.electronjs.org/docs/latest/tutorial/security
- https://www.electronjs.org/docs/latest/tutorial/updates
- https://www.electron.build/docs/features/auto-update
- https://github.com/atom/node-keytar
- https://crates.io/api/v1/crates/tauri
- https://v2.tauri.app/release/tauri/
- https://v3.tauri.app/develop/cef/
- https://github.com/tauri-apps/tauri/milestone/5
- https://github.com/tauri-apps/tauri/issues/3988
- https://v2.tauri.app/reference/webview-versions/
- https://v2.tauri.app/develop/sidecar/
- https://v2.tauri.app/plugin/updater/
- https://v2.tauri.app/distribute/
- https://v2.tauri.app/distribute/sign/macos/
- https://github.com/wailsapp/wails
- https://github.com/wailsapp/wails/releases
- https://pkg.go.dev/github.com/wailsapp/wails/v3/examples/server
- https://docs-preview.wails.io/guides/updater/
- https://github.com/wailsapp/wails/discussions/5139
- https://www.nuget.org/packages/Avalonia/
- https://avaloniaui.net/blog/net-maui-is-coming-to-linux-and-the-browser-powered-by-avalonia
- https://www.devclass.com/development/2026/03/24/avaloniaui-enhances-net-maui-with-linux-and-webassembly-support/5209515
- https://www.nuget.org/packages/Photino.NET/
- https://blog.jetbrains.com/kotlin/2025/09/compose-multiplatform-1-9-0-compose-for-web-beta/
- https://docs.flutter.dev/platform-integration/web/renderers
- https://sourceforge.net/projects/neutralinojs/files/v6.8.0/
- https://github.com/Elanis/web-to-desktop-framework-comparison
- https://betterstack.com/community/guides/scaling-nodejs/tauri-vs-electron-vs-deno-vs-electrobun/
- https://deno.com/blog/v2.9
- https://blackboard.sh/blog/electrobun-v1/
- https://www.rabbitmq.com/client-libraries/amqp-client-libraries
- https://www.rabbitmq.com/client-libraries/devtools
- https://www.rabbitmq.com/blog/2025/04/16/amqp-websocket
- https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-rabbitmq-oci/4-2/tanzu-rabbitmq-oci-image/site-tanzu-rabbitmq-features.html
- https://www.rabbitmq.com/docs/management
- https://www.rabbitmq.com/docs/http-api-reference
- https://www.rabbitmq.com/docs/oauth2
- https://www.rabbitmq.com/docs/prometheus
- https://www.rabbitmq.com/docs/web-stomp
- https://www.rabbitmq.com/release-information
- https://pkg.go.dev/github.com/rabbitmq/amqp091-go?tab=versions
- https://newreleases.io/project/github/rabbitmq/amqp091-go/release/v1.13.0
- https://pkg.go.dev/github.com/rabbitmq/rabbitmq-amqp-go-client?tab=versions
- https://github.com/rabbitmq/rabbitmq-amqp-go-client
- https://pkg.go.dev/github.com/rabbitmq/rabbitmq-stream-go-client?tab=versions
- https://github.com/michaelklishin/rabbit-hole
- https://registry.npmjs.org/amqplib/latest
- https://cdn.jsdelivr.net/npm/amqplib@2.0.1/CHANGELOG.md
- https://registry.npmjs.org/rabbitmq-amqp-js-client/latest
- https://groups.google.com/g/rabbitmq-users/c/fF3W3NQJtkQ
- https://registry.npmjs.org/rabbitmq-stream-js-client/latest
- https://www.nuget.org/packages/RabbitMQ.Client
- https://www.nuget.org/packages/RabbitMQ.AMQP.Client
- https://www.nuget.org/packages/RabbitMQ.Stream.Client
- https://www.nuget.org/packages/EasyNetQ.Management.Client
- https://crates.io/api/v1/crates/lapin
- https://crates.io/api/v1/crates/rabbitmq-stream-client
- https://crates.io/api/v1/crates/fe2o3-amqp
- https://github.com/michaelklishin/rabbitmq-http-api-rs
- https://github.com/rabbitmq/rabbitmqadmin-ng
- https://github.com/rabbitmq/hop
- https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot
- https://nodejs.org/api/single-executable-applications.html
- https://nodejs.org/api/sqlite.html
- https://bun.sh/docs/bundler/executables
- https://pkg.go.dev/modernc.org/sqlite
- https://github.com/zalando/go-keyring
- https://crates.io/api/v1/crates/keyring
- https://github.com/velopack/velopack
- https://www.ag-grid.com/license-pricing/
- https://github.com/xyflow/xyflow
- https://github.com/kieler/elkjs
- https://github.com/dagrejs/dagre
- https://github.com/cytoscape/cytoscape.js
- https://github.com/jacomyal/sigma.js
- https://github.com/microsoft/monaco-editor
- https://codemirror.net/
- https://github.com/leeoniya/uPlot
- https://github.com/apache/echarts
- https://github.com/glideapps/glide-data-grid
- https://github.com/TanStack/virtual
- https://github.com/mathuo/dockview
- https://connectrpc.com/docs/web/getting-started
- https://github.com/extism/extism
- https://developer.hashicorp.com/vault/docs/secrets/rabbitmq
- https://code.visualstudio.com/docs/remote/remote-overview
- https://developer.apple.com/programs/whats-included/
- https://learn.microsoft.com/en-us/azure/artifact-signing/faq
- https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart
- https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account
- https://learn.microsoft.com/en-us/windows/package-manager/package/
- https://brew.sh/2025/11/12/homebrew-5.0.0/
- https://docs.brew.sh/Homebrew-Security-and-Supply-Chain
- https://docs.flathub.org/docs/for-app-authors/requirements
- https://docs.docker.com/docker-hub/usage/
- https://helm.sh/docs/topics/registries/
