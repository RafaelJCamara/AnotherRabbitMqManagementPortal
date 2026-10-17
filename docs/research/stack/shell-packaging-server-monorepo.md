# Desktop shell, packaging, team server and monorepo

> **Pre-verification research (2026-10-16).** Where this conflicts with [`docs/research/fact-sheet.md`](../fact-sheet.md), the fact sheet wins. Content about a specific third-party product was removed under the docs policy ([ADR-034](../../adr/ADR-034-docs-policy.md)).

_Stack research `shell-packaging-server-monorepo` · 2026-10-16_

## Executive summary

Build the desktop app on Electron, package it with electron-builder, and reuse the same Node engine and Angular build for the npx/Docker local mode and for the team server. The team server ships as a distroless image with a Helm chart. The code lives in an Nx + pnpm monorepo where Zod schemas define the API contract.

Desktop: Electron 44.x today; 45 should be stable around 20 Oct 2026. Keep the main process thin and run the engine in a utilityProcess, which still works when the RunAsNode fuse is turned off and keeps engine crashes away from the UI. Load the Angular UI from an app:// protocol. The UI talks to the engine over loopback HTTP plus one WebSocket, protected by a per-launch token and Origin/Host checks. That is the same API the local-web and server modes use. Tauri 2 with a Node sidecar would only make the download 2-3x smaller, at the cost of three different WebViews, Rust, per-target sidecar builds and an upcoming Tauri 3 migration. Electrobun and Neutralino don't run a Node engine.

Packaging: electron-builder 26 + electron-updater (differential and staged updates; NSIS/DMG/AppImage/deb/rpm) is a better fit than Forge, whose free updater has no Linux support. Apple notarization ($99/yr) is mandatory: Gatekeeper requires it, and Homebrew has disabled casks that fail Gatekeeper since Sept 2026. For Windows, use SignPath Foundation's free open-source certificate, or Azure Artifact Signing ($9.99/mo, but individuals only in the US/Canada). Add a free Microsoft Store listing. Expect SmartScreen warnings at first; EV certificates no longer help. On Linux, prefer deb/rpm, which install an AppArmor profile for Ubuntu 24.04+.

Server: a distroless, non-root, multi-arch image and a Helm 4-compatible OCI chart. In-app OIDC, RBAC and audit; Postgres; start with one replica and shared pollers. Discover brokers in Kubernetes via RabbitmqCluster CRs.

Engineering:
- Nx 23 + pnpm with module boundaries and local generators.
- Zod 4 contracts → NestJS 12 OpenAPI → Orval Angular client.
- TypeScript 6.0, because Angular 22 can't use TS 7. ESLint 10 + angular-eslint + Prettier.
- Vitest; Testcontainers against RabbitMQ 3.13/4.2/4.3 on Linux runners; Playwright for web plus an Electron smoke suite.
- release-please, Starlight docs, Apache-2.0 + DCO.
- A short CLAUDE.md, path-scoped rules, hooks, and specs with acceptance criteria.

The web-search budget ran out early. Facts were verified by fetching official docs and the GitHub API directly.

## Recommendations

### Desktop shell

**Recommendation.** Use Electron and track the latest stable release (44.x today; 45 expected around 20 Oct 2026, when 42 reaches end of life). Keep the main process thin, run the TypeScript engine in an Electron utilityProcess, and serve the Angular UI from a privileged app:// custom protocol. Ship one engine artifact and one Angular build for desktop, local web and team server.

**Why.** Electron 44 embeds Node 24.18, the same runtime line as the server image. It pins Chromium 152, so a data-dense Angular UI renders the same on every OS, and it has the most mature packaging, update and signing tooling. RedisInsight, Headlamp, Beekeeper Studio, Bruno and Freelens all ship on Electron. A utilityProcess keeps engine CPU spikes and crashes away from the UI, can be restarted, and keeps working when the RunAsNode fuse is off (child_process.fork throws in that case).

**Alternatives.** Tauri 2 with a Node sidecar (pkg or Node SEA): about 2-3x smaller download, but it brings WebView2/WKWebView/WebKitGTK differences, a Rust shell, one sidecar per target triple, and Node SEA that is still marked Active development (macOS x64 untested in Node CI); Tauri 3 is already in alpha. Electrobun 2.0.3-beta now defaults to its own Cottontail runtime rather than Node. Neutralino has no Node runtime. Running the engine in the Electron main process, as RedisInsight does, is simpler but ties engine crashes and freezes to the UI.

**Risks.** Larger downloads (Electron 44.8 runtime zips are 117-151 MB). A new major every 8 weeks, with only three majors supported, forces regular upgrades. Electron's Node uses BoringSSL, so TLS and crypto behaviour can differ from server Node. Electron 44 needs macOS 13+ and is 64-bit only.

### Desktop UI-to-engine transport and local auth

**Recommendation.** The engine binds 127.0.0.1:0 and serves HTTP plus one multiplexed WebSocket. The main process passes {port, token} to the renderer through a contextBridge preload. The engine requires a per-launch 256-bit bearer token on every HTTP request and WebSocket upgrade, accepts only the app:// Origin, requires a loopback Host header, and never sends wildcard CORS. Use one auth middleware for every mode: the desktop token, a Jupyter-style token URL for local web (kept as a bearer token, not a cookie), and an OIDC cookie for the server. Keep the transport behind an interface so a MessagePort transport can be added later.

**Why.** This shares the most code with the local-web and team-server modes (the RedisInsight and Headlamp pattern) and works with standard debugging tools. The explicit checks are needed because Chrome's Local Network Access does not yet gate WebSockets, cookies are not isolated by port, and an origin includes the port; the stable app:// origin also keeps UI storage across launches.

**Alternatives.** MessagePort only (Beekeeper's pattern; oRPC ships Electron and MessagePort adapters): no network surface, but a second transport to build and test. Loading the UI from http://127.0.0.1 on a random port: web storage resets on every launch. Cookies for local web: they are sent to every port on 127.0.0.1.

**Risks.** Other local processes can reach the loopback server, which the token mitigates. How Chromium applies Local Network Access to requests from app:// to loopback needs a prototype. Any XSS in the renderer can read the token, though it could call the API anyway.

### Desktop hardening and OS integration

**Recommendation.** Turn on contextIsolation and the sandbox, turn off nodeIntegration, set a CSP with Trusted Types via Angular security.autoCsp, block navigation and window.open, and validate every IPC sender. Set fuses through electron-builder electronFuses: off for RunAsNode, NodeOptions, NodeCliInspect and GrantFileProtocolExtraPrivileges; on for EmbeddedAsarIntegrityValidation, OnlyLoadAppFromAsar and CookieEncryption. Store secrets with safeStorage through a main-process bridge, and warn when the Linux backend is basic_text. Add NSLocalNetworkUsageDescription on macOS. Give the engine its own per-connection CA and client-certificate settings.

**Why.** These follow Electron's security checklist and fuse guidance. electron-builder sets fuses after packaging and before signing. macOS 15+ requires apps to get permission before opening TCP connections to LAN addresses. Turning off the NodeOptions fuse also disables NODE_EXTRA_CA_CERTS, and Electron's Node uses BoringSSL, so corporate certificate authorities must be configured inside the engine.

**Alternatives.** Keeping the default fuses (weaker). keytar for secrets (archived since 2022). @napi-rs/keyring (keyring-node) for the local-web mode only: a small, native but ABI-stable library.

**Risks.** Linux secret storage falls back to effectively plaintext when no secret service is running. If the user refuses local-network permission, connections fail in ways that need clear UI guidance. A strict CSP must be checked against Monaco or chart libraries.

### Packaging and auto-update

**Recommendation.** Use electron-builder 26.x with electron-updater and the GitHub Releases provider. Targets: NSIS (x64, arm64); DMG+zip (arm64, x64); deb, rpm and AppImage (x64, arm64); snap; optionally MSIX/AppX for the Microsoft Store. Turn on blockmap differential downloads and stagingPercentage rollouts. Move to v27 once it is stable, for signed update manifests.

**Why.** electron-updater covers NSIS, DMG/zip, AppImage, deb, rpm and pacman, with differential downloads and staged rollouts. The electron-builder 26.17 schema includes electronFuses, azureSignOptions, signtoolOptions and notarize. Headlamp, Bruno, Beekeeper and Freelens all use it.

**Alternatives.** Electron Forge 8: first-party, ESM, stable Vite plugin, but its free update.electronjs.org service covers only macOS and Windows and needs a public repo. Hydraulic Conveyor: free for OSI-licensed projects, but a different update model and a small vendor. Tauri's updater: not applicable.

**Risks.** electron-builder is community-maintained and not officially supported by the Electron project. v27 changes the Linux launcher entry point. Auto-update on macOS only works for signed apps.

### macOS signing and notarization

**Recommendation.** Budget for the Apple Developer Program ($99/year). Sign with Developer ID using hardened runtime and notarize in CI on macos-15 runners (arm64; also build x64). Publish a DMG for first installs and a zip for updates. Run an x64 smoke test on macos-15-intel.

**Why.** Notarization is required in practice. macOS Sequoia removed the Control-click override for unsigned apps. Squirrel.Mac and electron-updater need signed apps. Homebrew disables casks that fail Gatekeeper from September 2026.

**Alternatives.** Shipping unsigned on macOS: not viable. The fee waiver: individuals are excluded.

**Risks.** An individual account shows a personal name as publisher. Intel Mac support is declining: Homebrew moves Intel to Tier 3 in Sept 2026 and drops it in Sept 2027.

### Windows signing and SmartScreen

**Recommendation.** Apply to the SignPath Foundation for free open-source signing, and prototype the flow: build unsigned on GitHub-hosted runners, sign through the SignPath action, then regenerate latest.yml and the blockmap. If the maintainer has an eligible organisation, or is an individual in the US or Canada, Azure Artifact Signing ($9.99/month) is smoother because electron-builder can sign during the build. Also publish an MSIX to the Microsoft Store, where registration is free and Microsoft re-signs the app.

**Why.** EV certificates no longer bypass SmartScreen. Signing builds reputation per certificate. Store apps never trigger SmartScreen. Windows 11 Smart App Control blocks unsigned files.

**Alternatives.** Buying an OV or EV certificate (expensive, and still has to build reputation). Shipping unsigned, as Bruno does (poor UX, and blocked by Smart App Control).

**Risks.** SignPath shows SignPath Foundation as the publisher, requires credit on the download page, requires MFA and GitHub-hosted builds, and bans commercial dual-licensing. Signing after the build breaks electron-updater checksums unless they are regenerated. SmartScreen warnings will appear for weeks after launch regardless.

### Linux formats and distribution channels

**Recommendation.** Make deb and rpm the main Linux formats (they install an AppArmor profile) and offer AppImage as the portable option with documented caveats. First wave of channels: GitHub Releases, npm (npx), GHCR image, OCI Helm chart, your own Homebrew tap, and winget via winget-releaser. Second wave: Microsoft Store, Flathub (built from source with flatpak-node-generator, with an upstream-maintained manifest) and the Snap Store. Leave Scoop, AUR and Chocolatey to the community.

**Why.** On Ubuntu 24.04+, AppArmor makes Electron's sandbox abort, and only deb and rpm can install a profile. Flathub forbids prebuilt binaries except case by case. winget needs silent installers hosted on the publisher's own release location and passing antivirus scans. homebrew/cask also needs notability.

**Alternatives.** AppImage-first (breaks on stock Ubuntu 24.04+). Using electron-builder's flatpak target for Flathub (Flathub requires a source build).

**Risks.** Maintaining a Flathub source build for an Electron and pnpm monorepo is work. Updating deb and rpm needs privilege elevation. Getting notability for homebrew/cask takes time.

### CI build matrix and release pipeline

**Recommendation.** Use GitHub Actions on native runners: ubuntu-24.04 and -arm, windows-2025, windows-11-arm, macos-15 (arm64) and macos-15-intel. Run broker-backed tests only on Linux. Release in this order: tag, build, notarize, sign Windows, regenerate update metadata, attest, upload to a draft release, then publish as an immutable release, and finally bump winget/Homebrew and push the image and chart.

**Why.** Standard runners are free and unlimited for public repos, including arm64. Service containers and Docker jobs run only on Linux runners. Release assets cannot change once an immutable release is published, so all signing must happen before publishing.

**Alternatives.** Cross-compiling everything on one OS (no native test coverage). Self-hosted runners (SignPath's open-source program requires GitHub-hosted ones).

**Risks.** macOS and Windows E2E tests have no Docker, so they need a stub engine or a natively installed broker. The release pipeline grows complex once external signing is added.

### Local web UI distribution

**Recommendation.** Ship the same engine with the Angular build embedded as an npm package (started with npx, Node 22.13+ or 24) and as a GHCR Docker image. Listen only on loopback by default and print a tokenised URL. Require auth to be configured before listening on any other address. Keep a zero-native-addon policy: use node:sqlite or PGlite, and no better-sqlite3 or keytar in the engine. Consider a Node SEA single binary later.

**Why.** Without native addons, npx works on any machine without a compiler, and the engine runs the same in Electron, Node and Docker. node:sqlite needs no flag since Node 22.13, has been a release candidate since 25.7, and works in Electron. The tokenised URL is a proven pattern from Jupyter.

**Alternatives.** better-sqlite3 (needs a rebuild for each Node/Electron ABI). Node SEA or Bun standalone binaries right away (SEA is still Active development).

**Risks.** node:sqlite is not yet marked stable. Docker users must map ports to 127.0.0.1 explicitly. Corporate proxies and TLS still need handling.

### Team-server container image

**Recommendation.** Use a multi-stage Dockerfile: build on node:24-trixie-slim and run on gcr.io/distroless/nodejs24-debian13:nonroot, keeping nodejs26 as a tested option. Handle SIGTERM in the app. Build linux/amd64 on ubuntu-24.04 and linux/arm64 on ubuntu-24.04-arm, then merge by digest. Attach an SBOM and provenance, sign with cosign, scan with Trivy, and run as non-root with a read-only root filesystem.

**Why.** Distroless provides Node 22, 24 and 26 images on Debian 13 for amd64 and arm64, with nonroot tags. Docker recommends native per-platform runners over QEMU. Node's Docker guidance warns that Node is not designed to run as PID 1.

**Alternatives.** node:*-alpine (musl, which matters if native code ever appears), Chainguard images, or a QEMU single-runner build (slow).

**Risks.** There is no shell for debugging (use the debug tags or ephemeral containers). Docker's HEALTHCHECK needs a Node-based probe.

### Helm chart and Kubernetes conventions

**Recommendation.** Write a chart with apiVersion v2, tested with Helm 4 (and Helm 3 until Feb 2027). Use flat, documented camelCase values, and generate values.schema.json from the engine's Zod config schema. Support existingSecret for the database URL, OIDC secret and encryption key. Meet the restricted Pod Security standard. Add probes, plus optional ServiceMonitor, NetworkPolicy and PodDisruptionBudget. Offer both a Gateway API HTTPRoute and an Ingress. Publish as an OCI artifact on GHCR, document it with helm-docs, and test it with chart-testing on kind.

**Why.** Helm 4 is current, and Helm 3 gets security fixes only until Feb 2027. Helm's own guidance favours flat, documented values. ingress-nginx was retired in March 2026, so Gateway API support is needed. One schema keeps the app config and the Helm values in sync.

**Alternatives.** A Kubernetes operator for the tool itself (overkill for v1). Kustomize only (less discoverable for users).

**Risks.** Default values must stay single-replica until high availability exists. RBAC for broker discovery is sensitive.

### Team-server identity, RBAC, audit and broker credentials

**Recommendation.** Build OIDC into the app with openid-client 6.x (Authorization Code + PKCE, server-side sessions, mapping group claims to roles), with an optional trusted-header mode behind oauth2-proxy. Model RBAC on Kafbat UI: roles, IdP subjects, resources (connection, vhost and name patterns) and actions, with separate MESSAGES_READ, PUBLISH and PURGE actions. Keep an append-only audit log covering every change and every message read. Support three broker credential modes: a shared service account protected by envelope encryption, per-user credentials, and OAuth2 token pass-through. Desktop-to-server login follows RFC 8252.

**Why.** RabbitMQ's OAuth 2.0 backend accepts a JWT as the password and supports refreshing it (update-secret on AMQP 0-9-1, PUT /auth/tokens on AMQP 1.0), so per-user broker permissions are possible. Kafbat shows RBAC patterns that work for a messaging UI. Reading message contents is sensitive data access and should be audited separately.

**Alternatives.** Delegating all auth to a reverse proxy (no fine-grained RBAC). Embedding Keycloak or Dex (heavier). A single shared admin credential (no accountability).

**Risks.** Mapping groups across IdPs is complex. Pass-through only works when RabbitMQ is configured for OAuth2. Audit volume and PII in message previews need masking rules.

### Persistence and secrets storage

**Recommendation.** Use Postgres for the team server. For desktop and local web, prototype Drizzle on a single Postgres dialect (PGlite locally, node-postgres on the server), with node:sqlite as the fallback via a dual-dialect layer (Kysely or Drizzle). Store secrets per mode: Electron safeStorage on desktop, the OS keyring or a passphrase file for local web, and envelope encryption with a KEK from a Kubernetes Secret or KMS on the server.

**Why.** Drizzle ships both pglite and node-postgres drivers, so one schema and one migration set could serve every mode, which suits code written mainly by agents. Postgres gives the server concurrency, backups and a path to high availability.

**Alternatives.** SQLite everywhere (limits server HA). better-sqlite3 (native ABI rebuilds). TypeORM, as RedisInsight uses.

**Risks.** PGlite is 0.5.x and single-connection, with unclear production maturity. A dual dialect doubles migration testing. node:sqlite is still a release candidate.

### Scaling long-lived AMQP connections and WebSocket fan-out

**Recommendation.** For v1 run a single replica with Postgres, and elect a leader for background jobs with a Postgres advisory lock. Run one shared poller per broker, preferring the Prometheus endpoint over cluster-wide management API calls, and cache results for all viewers. Give each client one multiplexed WebSocket. Implement taps with server-named exclusive auto-delete queues, and cap them per user and globally with backpressure. For HA: WebSocket-only transport (no sticky sessions), an adapter or bus such as Redis/Valkey or NATS for fan-out, and work ownership per broker.

**Why.** RabbitMQ recommends external monitoring and notes that the management API's cluster-wide queries suffer during partitions. Socket.IO needs sticky sessions only when long-polling is on, but always needs an adapter to broadcast across replicas. Postgres NOTIFY payloads are limited to under 8000 bytes, which makes it unsuitable for message bodies.

**Alternatives.** Socket.IO with sticky sessions. Postgres LISTEN/NOTIFY as the data bus. Every user polling independently, which multiplies broker load.

**Risks.** A single replica is a single point of failure. Duplicate pollers during rolling updates. Tap fan-out using too much memory.

### Kubernetes broker discovery

**Recommendation.** In server mode, optionally list RabbitmqCluster resources (rabbitmq.com/v1beta1) in allowed namespaces. Use status.serviceReference for addresses and spec.rabbitmq.additionalPlugins to detect the stream port. Reading <name>-default-user Secrets is opt-in. Show Topology Operator CRs (Queue, Exchange, Binding, Policy, User, Vhost, Shovel, Federation, SuperStream) as GitOps-managed and warn before UI edits. On desktop, offer kubeconfig discovery plus port-forwarding via @kubernetes/client-node 2.0.

**Why.** The Cluster Operator gives every cluster a predictable Service (5672/15672/15692) and credentials Secret. The Topology Operator manages objects declaratively, so editing them in the UI would create drift.

**Alternatives.** Manual connection catalog only. Polling Kubernetes Services by label.

**Risks.** Reading Secrets is a high-privilege permission. The operator's default-user account is an administrator, so prefer users scoped per team.

### Monorepo tooling

**Recommendation.** Use Nx 23 with pnpm (catalogs for a single dependency-version policy). Tag projects by scope, type and platform, enforce @nx/enforce-module-boundaries, and write local Nx generators for feature libraries, engine adapters and endpoints. Use nx affected in CI, and run nx configure-ai-agents and the Nx MCP server for agents. Model the Electron app as a plain Nx project with run-commands targets rather than nx-electron.

**Why.** Nx 23.3 pins Angular 22.1, keeps Angular, Nest and TypeScript upgrades in step via nx migrate, ships first-party Nest, Vitest, Playwright, Docker and oxlint plugins, and its generators produce consistent code for agents. Turborepo's boundaries feature is still experimental and it has no Angular generators.

**Alternatives.** pnpm workspaces + Turborepo 2.11, as Freelens uses (simpler, less magic). Plain Angular CLI workspaces. nx-electron (368 stars).

**Risks.** Nx complexity and plugin churn (Nx 24 is in beta). The Conformance plugin needs Nx Enterprise. Nx Cloud is optional and commercial (the Hobby tier is free).

### Contract-first API

**Recommendation.** Create a dependency-free libs/contracts package of Zod 4 schemas covering REST data, WebSocket events, config and errors. NestJS 12 validates with them (@Body({ schema }) and StandardSchemaValidationPipe) and generates OpenAPI from the same schemas. Describe the WebSocket protocol in AsyncAPI 3.1. Generate the Angular client with Orval (HttpClient or httpResource, optional Zod runtime validation). Gate CI with an OpenAPI snapshot and an oasdiff breaking-change check.

**Why.** One schema source feeds validation, docs, the client and the Helm values schema. NestJS 12 added first-class Standard Schema support, and Orval generates Angular-native clients.

**Alternatives.** oRPC 1.15 (contract-first, OpenAPI, NestJS and Electron/MessagePort adapters; v2 in beta). ts-rest (slowing, last push Feb 2026). TypeSpec. hey-api openapi-ts.

**Risks.** NestJS's OpenAPI output targets 3.0. The generated client can drift unless regeneration runs in CI. Engine framework choice should be coordinated with the engine-architecture research.

### TypeScript, lint and formatting

**Recommendation.** Use TypeScript 6.0 in strict mode everywhere, with noUncheckedIndexedAccess, exactOptionalPropertyTypes and verbatimModuleSyntax. Optionally run TS 7 (@typescript/native) for a fast noEmit check on Node-only libraries. Lint with ESLint 10 flat config, typescript-eslint 8.x strictTypeChecked, angular-eslint 22.x and the Nx boundaries rule. Format with Prettier.

**Why.** Angular 22 requires TypeScript 6.0 (at least 6.0, below 6.1). TS 7.0 ships no compiler API, so Angular and API-based tools cannot use it yet. Biome 2.5 does not list Angular templates among its supported languages, so ESLint plus angular-eslint is still needed.

**Alternatives.** Biome (no Angular template support). Oxlint as an extra fast first pass (NestJS 12 and Forge 8 templates use it). TS 7 everywhere (blocked by Angular).

**Risks.** ESLint with type information is slow on large repos (use Nx caching). Moving to TS 7 later once Angular supports it.

### Testing strategy and RabbitMQ matrix

**Recommendation.** Unit tests: Vitest (Angular via @angular/build:unit-test; Node libraries directly). Golden contract fixtures: management API responses recorded per RabbitMQ version, with a nightly refresh-and-diff job. Integration tests: @testcontainers/rabbitmq on Linux against 3.13, 4.2 and 4.3 management images, seeded via definitions.import_backend or POST /api/definitions, plus a nightly 3-node docker-compose cluster. E2E: Playwright web suite against engine and UI (bulk, cross-browser), a Playwright Electron smoke suite on a test build with the NodeCliInspect fuse enabled, axe accessibility checks, and AMQPS tests in both Node and Electron.

**Why.** 4.3 is the only series with community support, 4.2 just lost it, and 3.13 is still widely deployed under commercial support. Docker is available only on Linux runners. Playwright's Electron support is experimental and needs the inspect fuse that production builds disable.

**Alternatives.** Mock-only tests (miss version drift). Cypress (no Electron main-process control). Running Electron E2E for everything (slow, flaky).

**Risks.** A cluster test matrix is expensive (run it nightly). The test build differs from the shipped build in its fuses.

### Versioning, release notes and docs site

**Recommendation.** Enforce Conventional Commits on PR titles (action-semantic-pull-request) with squash merges. Use release-please in manifest mode with a single product version for desktop, image, npm CLI and chart; its release PR is the human gate before signing and notarization. Build docs with Starlight plus starlight-openapi on GitHub Pages, with ADRs under docs/adr.

**Why.** Signed desktop releases need a deliberate gate rather than a publish on every merge. release-please is mature (v17.11). Starlight is MIT-licensed and active (0.42.x) and can render the generated OpenAPI.

**Alternatives.** changesets (better for many independently versioned npm packages). semantic-release (publishes on every merge; v26 in beta). Nx Release. Docusaurus 3.10 (built-in versioned docs). VitePress 2 (still alpha).

**Risks.** Starlight is still 0.x and needs a plugin for versioned docs. A single product version hides component-level changes.

### Licence and OSS governance

**Recommendation.** License under Apache-2.0 with a NOTICE file, and require DCO sign-off rather than a CLA. Add CONTRIBUTING.md (including an AI-assisted contribution policy), CODE_OF_CONDUCT.md, SECURITY.md with GitHub private vulnerability reporting, GOVERNANCE.md, a trademark policy, OpenSSF Scorecard and Renovate. Decide now that the project will never be dual-licensed, which keeps it eligible for SignPath.

**Why.** Apache-2.0 includes an explicit patent grant that enterprise adopters value. DCO adds little friction. SignPath requires an OSI licence with no commercial dual-licensing, so a CLA would gain little. The licence does not grant trademark rights, so protect the name separately.

**Alternatives.** MIT (simpler, no patent grant). A CLA (only useful for relicensing or dual licensing). MPL-2.0 (RabbitMQ's licence, weak copyleft).

**Risks.** The trademark and foundation home are undecided. Contributor attribution when code comes from AI agents.

### Practices for a repo written mostly by AI agents

**Recommendation.** Make AGENTS.md the main instruction file and keep CLAUDE.md under 200 lines, importing it with @AGENTS.md. Add path-scoped .claude/rules (angular.md for apps/web, engine.md for libs/engine). Use hooks for deterministic checks: format and lint after each edit, and affected typecheck and tests in a Stop hook. Add skills for repeatable workflows (new endpoint, new adapter, release). Nx generators encode module templates. Write one spec per task with files and interfaces, out-of-scope items, Given/When/Then acceptance criteria and verification commands. Keep ADRs. Use a writer/reviewer split with fresh-context reviews, and CODEOWNERS on auth, secrets, desktop main/preload, workflows and the Helm chart.

**Why.** Claude Code reads AGENTS.md only when no CLAUDE.md exists and recommends keeping CLAUDE.md under 200 lines. Hooks are deterministic, whereas CLAUDE.md is only advisory. Anthropic's guidance stresses giving the agent checks it can run. Nx documents generators as a way to reduce invented code. Freelens already ships AGENTS.md and CLAUDE.md.

**Alternatives.** One large CLAUDE.md (followed less reliably). No generators (inconsistent modules).

**Risks.** Instruction files drift out of date (audit them regularly). Over-long specs. Too much trust in agent-written security code (mitigated by CODEOWNERS on sensitive paths).

## Report

# Desktop shell, packaging, team server and monorepo: research for an open-source RabbitMQ tool (as of 16 Oct 2026)

**How this was researched.** The shared WebSearch budget ran out after the first few queries. Nearly every fact below comes from fetching primary sources directly: official docs, release notes and the GitHub REST API (via `gh api`). Inferences are labelled; anything unverified is listed under Open questions.

The web UI and team server are therefore where this project can stand apart.

## 1. Versions as of 16 Oct 2026

| Component | Status | Source |
| --- | --- | --- |
| **Electron** | **44.8.0** is current. 44.0 shipped 2026-08-25 with Chromium 152 and Node 24.18.1; it needs macOS 13+ and is 64-bit only. 42 reaches end of life on 2026-10-20, so 45 (beta, Node 24.22) should go stable around then. | [endoflife](https://endoflife.date/electron), [v44 notes](https://github.com/electron/electron/releases/tag/v44.0.0) |
| **Node.js** | 24 is LTS and enters maintenance on 2026-10-20. 26 becomes LTS on 2026-10-28. | [schedule](https://github.com/nodejs/Release/blob/main/schedule.json) |
| **electron-builder / Forge** | electron-builder 26.17.0 (2026-09-26); 27 is in alpha. Forge 8.0.1 (2026-09-29) is ESM-only and needs Node ≥22.17. | [eb](https://github.com/electron-userland/electron-builder/releases), [forge](https://github.com/electron/forge/releases) |
| **Tauri** | 2.12.4; 3.0.0-alpha.5 was published the same day (2026-10-14). | [releases](https://github.com/tauri-apps/tauri/releases) |
| **Angular** | 22 (2026-06-03). Angular now ships one major per year. It needs TypeScript ≥6.0 and <6.1. | [releases](https://angular.dev/reference/releases), [versions](https://angular.dev/reference/versions) |
| **TypeScript** | 6.0.3. 7.0.2 is the native Go port and ships no compiler API. | [TS 7](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/) |
| **Nx / Turborepo / pnpm** | 23.3.0 (pins Angular 22.1) / 2.11.8 / 12.14.0 | GitHub releases |
| **NestJS** | 12.1.3. 12.0 introduced ESM packages and Standard Schema support. | [v12](https://github.com/nestjs/nest/releases/tag/v12.0.0) |
| **Vitest / Playwright / testcontainers-node** | 5.0.5 / 1.64.1 / 12.2.1 | GitHub releases |
| **RabbitMQ** | 4.3.6 is the only series with community support. 4.2's community support ended 2026-07-31; 3.13 is commercial-only until 2029. | [release info](https://www.rabbitmq.com/release-information) |
| **Helm** | 4 (Nov 2025). Helm 3 had its last feature release on 2026-09-09 and gets security fixes until Feb 2027. | [Helm blog](https://helm.sh/blog/) |

## 2. Desktop shell

### 2.1 Options compared

|  | Electron, engine in a utilityProcess | Tauri 2 + Node sidecar | Electrobun | Neutralino |
| --- | --- | --- | --- | --- |
| Engine runtime | Embedded Node 24 — the same engine code as the server | A separate binary per target triple. The official guide uses `@yao-pkg/pkg` with a short-lived CLI example ([guide](https://v2.tauri.app/learn/sidecar-nodejs/)) | Defaults to its own "Cottontail" runtime; Bun is optional ([site](https://framework.blackboard.sh/electrobun/)) | C++ core; Node only via an extension process |
| Renderer | Pinned Chromium on every OS | WebView2, WKWebView or WebKitGTK, versioned by the OS ([docs](https://v2.tauri.app/reference/webview-versions/)) | System webview or CEF | System webview |
| Download size | Runtime zips are 117–151 MB (44.8.0 assets) | The shell can be "as little as 600KB" ([tauri](https://v2.tauri.app/)), plus 32–53 MB of compressed Node ([dist](https://nodejs.org/dist/latest-v24.x/)) | Small | Tiny |
| Updates | electron-updater (differential, staged) | Signed full bundles; on Windows the app is force-closed during install ([updater](https://v2.tauri.app/plugin/updater/)) | Built in | Basic |
| Main risk | Size and upgrade cadence | Rust in the shell; Tauri 3 is in alpha; Node SEA is "Active development", `--build-sea` only exists since Node 25.5, and macOS x64 isn't tested in Node's CI ([SEA](https://nodejs.org/api/single-executable-applications.html)) | 2.0.3-beta, runtime still changing | Small ecosystem |

**Verdict: use Electron.** Once Node is bundled, Tauri's download is roughly 2–3× smaller, not 10×. In exchange you would have to:
- test a data-dense Angular UI on three different rendering engines;
- maintain a Rust shell;
- build and sign the sidecar for each of six target triples;
- absorb a major-version migration that is already in alpha.

### 2.2 How similar open-source apps are built

| App | Where the backend runs | Lesson |
| --- | --- | --- |
| **RedisInsight** (8.9k★) | It imports its NestJS API **inside the Electron main process**, picks a free port from a configured base, and checks requests against an Electron-window auth strategy. The same API runs in Docker on port 5540. The React UI uses an OpenAPI-generated client; native deps are better-sqlite3 and keytar ([server.ts](https://github.com/redis/RedisInsight/blob/main/redisinsight/desktop/src/lib/server/server.ts), [wiki](https://github.com/RedisInsight/RedisInsight/wiki/How-to-build-and-contribute)). | One Node API can serve desktop and Docker. Running it in the main process ties engine crashes and freezes to the UI. |
| **Headlamp** (Apache-2.0) | A Go server shipped through electron-builder `extraResources` and run as a child process. The same server runs in-cluster. The browser opens one WebSocket and the server fans out to many upstream sockets ([architecture](https://headlamp.dev/docs/latest/development/architecture), [package.json](https://github.com/kubernetes-sigs/headlamp/blob/main/app/package.json)). | Multiplex all streams over a single WebSocket. |
| **Beekeeper Studio** (23.8k★) | `utilityProcess.fork` with a `MessageChannelMain` port per window, restarted if it exits ([main.ts](https://github.com/beekeeper-studio/beekeeper-studio/blob/master/apps/studio/src-commercial/entrypoints/main.ts)). electron-builder produces AppImage, deb, rpm, snap, flatpak, pacman, NSIS, MSI and a notarized DMG ([config](https://github.com/beekeeper-studio/beekeeper-studio/blob/master/apps/studio/electron-builder-config.js)). | utilityProcess plus MessagePort is proven in production. |
| **Bruno** (47.7k★) | Uses electron-builder with Windows signing turned off (`sign: null`) ([config](https://github.com/usebruno/bruno/blob/main/packages/bruno-electron/electron-builder-config.js)). | Large open-source apps do ship unsigned Windows builds. |
| **Freelens** (MIT) | electron-builder, pnpm workspaces, Turborepo, Biome and Vitest, plus AGENTS.md, CLAUDE.md and a `.claude/` folder ([repo](https://github.com/freelensapp/freelens)). | A working example of a repo set up for coding agents. |
| **Hoppscotch** | A Tauri desktop app that connects to the cloud service or to self-hosted instances; each instance gets its own `app://` origin, which the server must allow-list ([setup](https://docs.hoppscotch.io/documentation/clients/desktop/setup)). | A desktop app can also act as a client of a team server. |

### 2.3 Recommended design

1. **Keep the main process thin.** It handles app lifecycle, windows, menus, tray, deep links, the updater and the secrets bridge. Electron's docs say never to block it ([performance](https://www.electronjs.org/docs/latest/tutorial/performance)).

2. **Run the engine with `utilityProcess.fork()`** and restart it with backoff if it dies. This keeps working when the `RunAsNode` fuse is off. With that fuse off, `child_process.fork` throws, and Electron recommends utility processes instead ([fuses](https://www.electronjs.org/docs/latest/tutorial/fuses), [API](https://www.electronjs.org/docs/latest/api/utility-process)).

3. **Serve the UI from a privileged `app://` scheme.**
   - Not `file://`: the Electron security checklist (item 18) advises against it ([security](https://www.electronjs.org/docs/latest/tutorial/security)).
   - Not `http://127.0.0.1:<random port>` either: the origin includes the port, so the UI's web storage would reset on every launch (inferred from [origin rules](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage)).

4. **How the UI talks to the engine.** The engine listens on `127.0.0.1:0` and serves HTTP plus one multiplexed WebSocket. The main process passes `{port, token}` to the UI through a `contextBridge` preload. The engine then:
   - requires a 256-bit per-launch token on every request and every WebSocket upgrade;
   - accepts only the `app://` origin;
   - rejects any `Host` that isn't loopback, which blocks DNS rebinding;
   - never sends wildcard CORS headers.

   These checks are needed because Chrome 142's Local Network Access prompt **does not cover WebSockets yet** ([Chrome](https://developer.chrome.com/blog/local-network-access)). Keep the transport behind an interface so a MessagePort transport can be added later; oRPC already ships Electron and MessagePort adapters ([oRPC](https://orpc.dev/docs/adapters/electron)).

5. **One auth pipeline, three ways in.** The same middleware maps identity to RBAC in every mode:
   - Desktop: the per-launch token.
   - Local web: a tokenised URL printed at startup, as Jupyter does ([Jupyter](https://jupyter-server.readthedocs.io/en/latest/operators/security.html)). Keep it as a bearer token, not a cookie, because cookies are not isolated by port ([RFC 6265 §8.5](https://www.rfc-editor.org/rfc/rfc6265#section-8.5)).
   - Team server: an OIDC session cookie.

6. **Secrets.** `safeStorage` only exists in the main process, so the engine reaches it over the control port. On Linux, call `getSelectedStorageBackend()` and warn the user if it returns `basic_text`, which uses a hard-coded password ([safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)). Don't use keytar; it has been archived since 2022 ([repo](https://github.com/atom/node-keytar)).

7. **Hardening.**
   - contextIsolation and sandbox on, nodeIntegration off.
   - CSP plus Trusted Types via Angular's `security.autoCsp` ([Angular](https://angular.dev/best-practices/security)).
   - Block navigation and new windows; validate the sender of every IPC message.
   - Fuses off: RunAsNode, NodeOptions, NodeCliInspect, GrantFileProtocolExtraPrivileges.
   - Fuses on: ASAR integrity validation, OnlyLoadAppFromAsar, cookie encryption.
   - electron-builder 26 sets fuses through its `electronFuses` option, after packaging and before signing ([config](https://www.electron.build/docs/configuration)).

8. **OS gotchas.**
   - **macOS 15+ local-network privacy.** An app needs user permission for outgoing TCP connections to LAN addresses; CLI tools run from Terminal are exempt. Add `NSLocalNetworkUsageDescription` and handle the user saying no ([TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)).
   - **Ubuntu 24.04+ AppArmor.** The user-namespace restriction makes Electron abort with the SUID-sandbox error. The issue is still open and was active in Aug 2026 ([#42510](https://github.com/electron/electron/issues/42510)). electron-builder's deb/rpm post-install script installs an AppArmor profile; an AppImage can't ([template](https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/templates/linux/after-install.tpl)).
   - **TLS differences.** Electron builds Node's crypto on BoringSSL rather than OpenSSL ([env docs](https://github.com/electron/electron/blob/main/docs/api/environment-variables.md)), and turning off the NodeOptions fuse also disables `NODE_EXTRA_CA_CERTS`. The engine therefore needs its own per-connection CA and client-certificate settings, and AMQPS should be tested in both runtimes.

## 3. Packaging, signing and updates

### 3.1 electron-builder vs Electron Forge

|  | electron-builder 26 | Forge 8 |
| --- | --- | --- |
| Support | Community project, with "no official support from the Electron project" ([Electron](https://www.electronjs.org/docs/latest/tutorial/forge-overview)) | First-party |
| Auto-update | electron-updater: GitHub, S3, R2 or generic hosting; blockmap differential downloads; staged rollout via `stagingPercentage`. Works for NSIS, DMG+zip, AppImage, deb, rpm and pacman. v27 adds signed update manifests ([docs](https://www.electron.build/docs/features/auto-update)) | update.electronjs.org: needs a public GitHub repo, covers **macOS and Windows only**, and requires a signed macOS build. Otherwise S3 or a self-hosted server ([Electron](https://www.electronjs.org/docs/latest/tutorial/updates), [Forge](https://www.electronforge.io/advanced/auto-update)) |
| Signing hooks | `electronFuses`, `azureSignOptions`, `signtoolOptions` and `notarize` are all in the 26.17 schema | Fuses plugin |
| Used by | Headlamp, Bruno, Beekeeper, Freelens | — |

**Pick electron-builder with electron-updater**, and move to v27 once it is stable. Hydraulic Conveyor is another option; it is free for projects under an OSI-approved licence ([pricing](https://hydraulic.dev/pricing.html)).

### 3.2 Code signing

**macOS — mandatory.**
- Developer ID costs $99/year ([Apple](https://developer.apple.com/programs/)), and the fee waiver excludes individuals ([waiver](https://developer.apple.com/support/membership-fee-waiver/)).
- macOS Sequoia removed the Control-click override for unsigned apps ([Apple](https://developer.apple.com/news/?id=saqachfa)).
- Auto-update on macOS only works for signed apps.
- Homebrew has disabled casks that fail Gatekeeper since September 2026 ([Homebrew 5.0](https://brew.sh/2025/11/12/homebrew-5.0.0/)).

**Windows options**

| Option | Cost | Conditions | Fit |
| --- | --- | --- | --- |
| **SignPath Foundation** | Free | OSI licence and no commercial dual-licensing; MFA for everyone; all build jobs on GitHub-hosted runners. The certificate is issued to **"SignPath Foundation"**, which is what users see as publisher, and the download page must credit them ([terms](https://signpath.org/terms), [GitHub flow](https://docs.signpath.io/trusted-build-systems/github)) | Best free option. Signing happens after the build, so `latest.yml` and the blockmap must be regenerated; prototype this first. |
| **Azure Artifact Signing** (formerly Trusted Signing) | From $9.99/month; the Basic tier allows 5,000 signatures/month | Public Trust certificates go to organisations in the US, CA, EU, UK, AU, NZ, JP, KR, SG, CH, NO and IL; individuals only in the US or Canada ([quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart), [pricing](https://azure.microsoft.com/en-us/pricing/details/artifact-signing/)) | Easiest: electron-builder signs during the build. |
| **Microsoft Store (MSIX)** | Free registration | Identity check ([Partner Center](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account)) | Microsoft re-signs the app, so no SmartScreen warning. |
| **EV certificate** | High | — | No longer bypasses SmartScreen. |

Whatever you choose, new releases will show SmartScreen warnings until reputation builds, which can take "several weeks and hundreds of clean installs". Windows 11 Smart App Control blocks unsigned binaries outright ([Microsoft](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)).

**Linux.** There is no OS-level signing. Publish `SHA256SUMS`, attach build-provenance attestations ([action](https://github.com/actions/attest-build-provenance)), and turn on immutable GitHub Releases ([docs](https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases)). Because release assets can't change after publishing, all signing must finish first.

### 3.3 Linux formats and distribution channels

**Linux formats**
- **deb and rpm (x64 and arm64) as the main formats.** They install the AppArmor profile and electron-updater can update them.
- **AppImage as the portable option.** Document the Ubuntu 24.04 sandbox caveat.
- **Flathub, later.** It requires an offline build from source; prebuilt binaries are allowed only as case-by-case exceptions ([rules](https://docs.flathub.org/docs/for-app-authors/requirements)). Use `org.electronjs.Electron2.BaseApp` with `flatpak-node-generator` ([guide](https://docs.flatpak.org/en/latest/electron.html)).
- **Snap** through electron-builder's snap target.

**Channel priority**
1. GitHub Releases with in-app updates, plus `npx`, a GHCR container image and an OCI Helm chart.
2. Homebrew and winget:
   - **Homebrew.** Start with your own tap. The main cask repo also needs notability and a passing Gatekeeper check ([policy](https://docs.brew.sh/Acceptable-Casks)).
   - **winget.** It needs a silent install, an installer URL hosted on the publisher's own release location, and passing antivirus scans ([winget](https://learn.microsoft.com/en-us/windows/package-manager/package/repository)). Automate submissions with winget-releaser.
3. Microsoft Store, Flathub, Snap Store.
4. Scoop, AUR and Chocolatey, maintained by the community.

### 3.4 CI build machines and release pipeline

Public repos get free, unlimited standard runners: `ubuntu-24.04` and `-arm`, `windows-2025`, `windows-11-arm`, `macos-15`/`macos-26` (arm64) and `macos-15-intel`/`macos-26-intel` ([runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)).

Docker service containers only run on Linux runners ([docs](https://docs.github.com/en/actions/tutorials/use-containerized-services/use-docker-service-containers)). So:
- Tests that need a real broker run on Linux.
- macOS and Windows jobs build the installers and run Electron smoke tests, against a stub engine or a broker installed natively on the runner.

Release flow:
1. Push a tag.
2. Build across the OS matrix and notarize the macOS builds.
3. Sign the Windows builds.
4. Regenerate the update metadata.
5. Attest the artifacts.
6. Upload everything to a draft release.
7. Publish the release, which then becomes immutable.
8. Bump the winget and Homebrew manifests.
9. Push the container image and the Helm chart.
10. Deploy the docs.

Homebrew moves Intel Macs to Tier 3 in September 2026, so keep shipping an x64 DMG through 2027 and review then.

## 4. Local web mode and team server

### 4.1 Local web mode

The same engine and Angular build, started with `npx` or `docker run -p 127.0.0.1:…`. It listens on loopback by default; listening on any other address should require auth to be configured first.

Keep the engine free of native addons, so `npx` works on machines without a compiler toolchain:
- better-sqlite3 needs rebuilding for every Node/Electron ABI, and keytar is archived.
- `node:sqlite` runs without a flag since Node 22.13 and has been a release candidate since 25.7 ([docs](https://nodejs.org/api/sqlite.html)). It works in Electron; a regression in 37.2 was fixed ([#47671](https://github.com/electron/electron/issues/47671)).

A single executable built with Node SEA is a possible later addition.

### 4.2 Container image

- Build on `node:24-trixie-slim` and run on `gcr.io/distroless/nodejs24-debian13:nonroot`. Node 22, 24 and 26 variants exist for amd64 and arm64 ([distroless](https://github.com/GoogleContainerTools/distroless)).
- Handle SIGTERM inside the app: distroless has no init process, and Node isn't designed to run as PID 1 ([docker-node](https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md)).
- Build each architecture on a native runner and merge them by digest, which Docker recommends over QEMU emulation ([Docker](https://docs.docker.com/build/ci/github-actions/multi-platform/)).
- Produce an SBOM and provenance, sign with cosign and scan with Trivy.

### 4.3 Helm chart

- Use chart `apiVersion: v2` and test it with Helm 4, and with Helm 3 until its security support ends in Feb 2027.
- Follow the values conventions: flat, documented, camelCase ([guide](https://helm.sh/docs/chart_best_practices/values/)).
- Generate `values.schema.json` from the engine's Zod config schema so there is one source of truth.
- Support `existingSecret`.
- Meet the restricted Pod Security standard: read-only root filesystem, with an `emptyDir` for `/tmp`.
- Add health probes. Make ServiceMonitor, NetworkPolicy and PodDisruptionBudget optional.
- Offer both a Gateway API HTTPRoute and an Ingress, since ingress-nginx was retired in March 2026 ([k8s](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/)).
- Publish the chart as an OCI artifact on GHCR. Test it with chart-testing on a kind cluster that has the Cluster Operator installed.

### 4.4 Login, permissions, audit and broker credentials

- **Login:** OIDC built into the app with openid-client 6.8 (Authorization Code + PKCE) ([repo](https://github.com/panva/openid-client)). Optionally trust identity headers when running behind oauth2-proxy.
- **Permissions (RBAC):** model them on Kafbat UI: roles → identity-provider subjects → resources (connection, vhost, name patterns) × actions, with a separate `MESSAGES_READ` action ([Kafbat](https://ui.docs.kafbat.io/configuration/rbac-role-based-access-control)).
- **Audit:** record every change and every message read.
- **Broker credentials**, in three possible modes:
  - A shared service account per connection, protected with envelope encryption: data keys wrapped by a key-encryption key (KEK) from a Kubernetes Secret or a KMS.
  - Per-user credentials.
  - OAuth2 pass-through. RabbitMQ accepts the JWT as the password and refreshes it via `update-secret` on AMQP 0-9-1 or `PUT /auth/tokens` on AMQP 1.0 ([RabbitMQ OAuth2](https://www.rabbitmq.com/docs/oauth2)).
- **Desktop app logging in to a team server:** follow RFC 8252 — system browser, PKCE and a loopback redirect ([RFC 8252](https://www.rfc-editor.org/rfc/rfc8252)).

### 4.5 Database

- **Team server:** Postgres. SQLite or PGlite (an embedded Postgres) are enough for a single-replica trial install.
- **Desktop and local web:** `node:sqlite` or PGlite.
- **One schema everywhere?** Drizzle has drivers for both `pglite` and `node-postgres` ([repo](https://github.com/drizzle-team/drizzle-orm)), which would allow one Postgres schema and one set of migrations for every mode. PGlite is still 0.5.x and allows only one connection at a time ([PGlite](https://pglite.dev/docs/)), so prototype it before committing.

### 4.6 Scaling

- **Version 1:** run a single replica. Background jobs take a Postgres advisory lock so only one replica runs them, which makes rolling updates safe.
- **Polling:** one poller per broker, shared by all users. Prefer the Prometheus endpoint: the management HTTP API runs cluster-wide queries that suffer during network partitions, while Prometheus data is node-local ([management](https://www.rabbitmq.com/docs/management)).
- **Live message taps:**
  - Use server-named, exclusive, auto-delete queues, so a crashed pod can't leave taps behind (design inference).
  - Cap taps per user and globally.
  - Drop or sample messages when a client falls behind.
- **Several replicas:** using WebSocket only avoids the need for sticky sessions, but broadcasting to clients on other replicas needs an adapter or message bus ([Socket.IO](https://socket.io/docs/v4/using-multiple-nodes/)). Don't send message bodies through Postgres `NOTIFY`, which limits payloads to under 8,000 bytes ([Postgres](https://www.postgresql.org/docs/current/sql-notify.html)).

### 4.7 Finding brokers in Kubernetes

- Watch `RabbitmqCluster` resources (`rabbitmq.com/v1beta1`). Each one has a Service on ports 5672, 15672 and 15692; its credentials are in the `<name>-default-user` Secret; enabled plugins are listed in `spec.rabbitmq.additionalPlugins` ([operator](https://www.rabbitmq.com/kubernetes/operator/using-operator)).
- Reading those Secrets is high-privilege, so make it opt-in and scope the RBAC to specific namespaces.
- Read the Topology Operator resources (Queue, Exchange, Binding, Policy, User, Vhost, Shovel, Federation, SuperStream and others). Mark matching objects as "managed by GitOps" and warn before editing them in the UI ([topology](https://www.rabbitmq.com/kubernetes/operator/using-topology-operator)).
- Opportunity for the desktop app: read the user's kubeconfig and connect through port-forwarding, using `@kubernetes/client-node` 2.0.

## 5. Monorepo and engineering

### 5.1 Nx vs Turborepo

|  | Nx 23.3 | pnpm + Turborepo 2.11 |
| --- | --- | --- |
| Angular support | `@nx/angular`, pinned to Angular 22.1, with generators and `nx migrate` | Plain Angular CLI in each package |
| Other first-party plugins | Nest, Node, esbuild, Vitest, Playwright, Docker, oxlint | You set them up yourself |
| Module boundaries | `@nx/enforce-module-boundaries`, based on project tags. The Conformance plugin needs Nx Enterprise ([Nx](https://nx.dev/docs/features/enforce-module-boundaries)) | `turbo boundaries`, still experimental ([Turbo](https://turborepo.dev/docs/reference/boundaries)) |
| Help for coding agents | `nx configure-ai-agents` writes CLAUDE.md and AGENTS.md; there is an Nx MCP server; generators reduce invented code ([Nx AI](https://nx.dev/docs/features/enhance-ai)) | — |

**Use Nx with pnpm**, and use pnpm catalogs so every package uses the same dependency versions. For Electron, use a plain Nx project with run-commands targets rather than the community `nx-electron` plugin (368★).

### 5.2 Folder layout and dependency rules

```
apps/  desktop (main+preload) · web (Angular) · engine (entrypoints: cli, server, desktop-utility) · docs · e2e-web · e2e-desktop
libs/  contracts · engine/{domain, mgmt-http, amqp091, amqp10, stream, prometheus, persistence, secrets, auth, transport} · web/{feature-*, data-access, ui} · testing/{fixtures, containers}
tools/ generators (feature-lib, engine-adapter, endpoint) · deploy/{docker, helm}
```

Tag every project with `scope:*`, `type:*` and `platform:{node, browser, electron-main, isomorphic}`, then enforce these rules:
- `contracts` depends on nothing.
- `domain` depends only on `contracts`.
- Adapters implement the interfaces (ports) defined in `domain`.
- Browser libraries never import Node libraries.

### 5.3 Contract-first API

- `libs/contracts` holds Zod 4 schemas for request/response data, WebSocket events, configuration and errors.
- NestJS 12 validates against those same schemas (`@Body({ schema })` with `StandardSchemaValidationPipe`) and generates OpenAPI from them ([v12](https://github.com/nestjs/nest/releases/tag/v12.0.0)).
- The WebSocket API is documented with AsyncAPI 3.1.
- The Angular client is generated with Orval, which supports `HttpClient`, `httpResource` and optional Zod validation of responses ([Orval](https://orval.dev/docs/guides/angular)).
- CI keeps a snapshot of the OpenAPI spec and runs oasdiff to catch breaking changes.
- Alternative: oRPC 1.15 (v2 is in beta).

### 5.4 TypeScript, linting and formatting

- **TypeScript:** 6.0 in strict mode everywhere. Angular 22 requires it, and TS 7.0 has no compiler API yet, so Angular's compiler and API-based tools like typescript-eslint can't use it.
  - Optionally run TS 7 (`@typescript/native`) as a fast type check (`--noEmit`) on Node-only libraries.
- **Linting:** ESLint 10 (flat config) with:
  - typescript-eslint 8.71, strict type-checked rules;
  - angular-eslint 22.6 ([releases](https://github.com/angular-eslint/angular-eslint/releases));
  - the Nx module-boundaries rule.
- **Formatting:** Prettier. Biome 2.5 does not list Angular templates among its supported languages ([Biome](https://biomejs.dev/internals/language-support/)).

### 5.5 Testing

- **Unit tests:** Vitest, which is now the Angular CLI default through `@angular/build:unit-test` ([Angular](https://angular.dev/guide/testing)).
- **Golden fixtures:**
  - Record management-API responses for each RabbitMQ version and parse them with the contract schemas.
  - A nightly job refreshes the recordings and shows what changed.
- **Integration tests:**
  - Use `@testcontainers/rabbitmq` ([docs](https://node.testcontainers.org/modules/rabbitmq/)) against RabbitMQ 3.13, 4.2 and 4.3.
  - Seed brokers with `definitions.local.path` plus `skip_if_unchanged`, or with `POST /api/definitions` ([definitions](https://www.rabbitmq.com/docs/definitions)).
  - Test a 3-node cluster nightly with docker-compose.
- **End-to-end tests:**
  - Most run with Playwright against the engine plus the web UI.
  - Electron gets a small smoke suite. Playwright's Electron support is experimental and needs the `EnableNodeCliInspectArguments` fuse ([Playwright](https://playwright.dev/docs/api/class-electron)), so test against a special build with that fuse on.
  - Run axe accessibility checks.

### 5.6 Releases, docs and governance

**Releases**
- Enforce Conventional Commits on pull-request titles and use squash merges.
- Run release-please 17.11 in manifest mode with one product version. Its release PR is the human checkpoint before signing.
- Add changesets only if separately versioned npm SDK packages appear later.
- Avoid semantic-release, which publishes on every merge.

**Docs:** Starlight 0.42 with starlight-openapi. Docusaurus 3.10 if you need versioned docs early. VitePress 2 is still in alpha.

**Governance**
- **License:** Apache-2.0, for its explicit patent grant ([summary](https://choosealicense.com/licenses/apache-2.0/)).
- **Contributions:** a DCO sign-off ([DCO](https://developercertificate.org/)). A CLA buys little, because SignPath's terms already rule out commercial dual-licensing.
- **Standard files:** CONTRIBUTING (including a policy on AI-assisted contributions), CODE_OF_CONDUCT, SECURITY.md with private vulnerability reporting, GOVERNANCE and a trademark policy.
- **Automation:** OpenSSF Scorecard and Renovate.

### 5.7 Practices for a repo written mostly by AI agents

- **Instruction files.**
  - Keep CLAUDE.md under 200 lines.
  - Put area-specific guidance in nested files or in `.claude/rules/*.md` scoped with `paths:`.
  - Claude Code reads AGENTS.md only when there is no CLAUDE.md. Make AGENTS.md the main file and import it from CLAUDE.md with `@AGENTS.md` ([memory](https://code.claude.com/docs/en/memory)).
- **Hooks as hard checks.** Format and lint after every edit, and run type-checks and tests on affected projects in a Stop hook. Use skills for repeatable workflows ([best practices](https://code.claude.com/docs/en/best-practices)).
- **Generators.** Nx local generators encode the module templates so every new library or endpoint looks the same.
- **Specs.** Each task spec names the files and interfaces involved, what is out of scope, Given/When/Then acceptance criteria and the commands that prove it is done.
- **Decision records.** Keep ADRs in `docs/adr`.
- **Review.** Separate writer and reviewer sessions. Put CODEOWNERS on auth, secrets, desktop main/preload, release workflows and the Helm chart.

## 6. Top risks

1. **Windows signing.** You must either accept "SignPath Foundation" as the publisher name and the post-build re-signing work, or pay for Artifact Signing, which needs an eligible organisation.
2. **Desktop transport security.** The loopback server's security depends entirely on the token, Origin and Host checks. How Chromium's Local Network Access treats `app://` → loopback requests still needs checking.
3. **Linux sandbox.** Electron's sandbox fails on Ubuntu 24.04+ for AppImage, so steer those users to deb/rpm or Snap/Flatpak.
4. **Electron E2E vs hardening.** Playwright needs the inspect fuse that production builds turn off, so you need a separate test build.
5. **Version churn.** Tauri 3, TS 7, oRPC v2, electron-builder v27 and Nx 24 are all coming; pin versions and upgrade on purpose.

## Claims flagged for verification

- **[high]** With Electron's runAsNode fuse disabled, child_process.fork throws, and Electron recommends utilityProcess for standalone Node processes; utilityProcess.fork can only be called after the app is ready.
- **[high]** Playwright's Electron automation is still experimental, supports Electron v21+, and needs the EnableNodeCliInspectArguments fuse left on.
- **[high]** electron-updater supports blockmap differential downloads and stagingPercentage rollouts for NSIS, DMG+zip, AppImage, deb, rpm and pacman. Forge's free update.electronjs.org needs a public GitHub repo and covers only macOS and Windows.
- **[high]** EV certificates no longer bypass SmartScreen. Microsoft Store apps are re-signed by Microsoft and never show SmartScreen download warnings. Artifact Signing starts at $9.99/month. Windows 11 Smart App Control blocks unsigned files without positive reputation.
- **[high]** Azure Artifact Signing Public Trust certificates are available to organisations in US, CA, EU, UK, AU, NZ, JP, KR, SG, CH, NO and IL, but to individual developers only in the US or Canada.
- **[high]** SignPath Foundation's free open-source signing requires an OSI licence with no commercial dual-licensing, MFA for all team members, builds on GitHub-hosted runners, and a credit on the download page. The certificate is issued to SignPath Foundation, which appears as publisher.
- **[high]** Homebrew disables homebrew/cask casks that fail Gatekeeper checks from September 2026 and moves Intel macOS to Tier 3. Apple's Developer Program costs $99/year and its fee waiver excludes individuals.
- **[high]** From macOS 15, an app needs Local Network permission to open outgoing TCP connections to LAN addresses (command-line tools run from Terminal are exempt), and apps should declare NSLocalNetworkUsageDescription.
- **[medium]** On Ubuntu 24.04+, AppArmor's user-namespace restriction makes Electron abort with the SUID sandbox error (issue still open in 2026). electron-builder's deb/rpm post-install installs an AppArmor profile, which an AppImage cannot do.
- **[high]** Angular 22 requires TypeScript at least 6.0 and below 6.1. TypeScript 7.0, the native Go port released in July 2026, ships without a programmatic API, so tools that embed TypeScript, such as Angular's compiler, cannot use it yet.
- **[high]** On GitHub Actions, Docker service containers and container jobs run only on Linux runners. Standard runners, including ubuntu-24.04-arm, windows-11-arm and macos-15-intel, are free and unlimited for public repositories.
- **[high]** Chrome 142's Local Network Access permission covers fetch, subresources and subframes from public sites to local or loopback addresses, but WebSockets are not yet covered.
- **[high]** RabbitMQ 4.3.x is the only series with community support (latest 4.3.6). Community support for 4.2 ended 2026-07-31, and 3.13 has been commercial-only since Sept 2024, supported until 2029.
- **[high]** Electron 44 (released 2026-08-25) ships Chromium 152 and Node 24.18.1, needs macOS 13+, and has dropped 32-bit builds. Electron 42 reaches end of life on 2026-10-20, and Node 24 enters maintenance on the same day while Node 26 becomes LTS on 2026-10-28.
- **[medium]** Flathub requires source-available apps to be built entirely from source without network access, and does not accept prebuilt binaries except for case-by-case exceptions.

## Open questions

- Is the maintainer an individual or a legal entity, and in which country? This decides Azure Artifact Signing eligibility (individuals: US/Canada only), the Apple account type and displayed publisher name, the Microsoft Store account type, and trademark ownership.
- Is 'SignPath Foundation' acceptable as the Windows publisher name, and how long does SignPath approval take? The external-signing pipeline needs a prototype: deep-signing win-unpacked, building NSIS from the prepackaged output, signing the installer, then regenerating latest.yml and the blockmap.
- Persistence: should every mode use one Postgres dialect (PGlite locally, Postgres on the server), or SQLite plus Postgres? Prototype PGlite's performance, durability, backups and single-connection limits inside an Electron utilityProcess.
- Desktop transport: confirm how Chromium 152 Local Network Access treats requests from an app:// page to 127.0.0.1, and whether session.webRequest can inject the token into WebSocket handshakes. Decide whether a MessagePort transport is needed at launch.
- Engine framework (NestJS 12 vs oRPC or Fastify) needs to be settled with the engine-architecture research, since it determines the contract tooling (OpenAPI generation, MessagePort support).
- What scale must the team server handle at v1 (users, brokers, concurrent taps), and is high availability required at launch or is a single replica acceptable?
- Corporate TLS: how to support OS trust stores and client certificates consistently across Electron (BoringSSL, NODE_EXTRA_CA_CERTS blocked by the NodeOptions fuse) and plain Node (--use-system-ca)?
- How long should Intel macOS and Windows on Arm be supported, given Homebrew's Intel Tier 3 move and limited Windows arm64 test capacity?
- Should the app also be on the Mac App Store? Its sandbox constraints on a local server, LAN access and keychain use were not researched.
- Final licence and governance: Apache-2.0 vs MIT, trademark registration for the product name, and whether to seek a foundation home later.
- Telemetry and crash reporting (opt-in, self-hosted vs SaaS) were not researched, and they affect both privacy messaging and the signing and update pipeline.
- Is a standalone single binary for local-web users without Node (Node SEA or Bun compile) worth the extra signing and notarization work?

## Sources

- https://endoflife.date/electron
- https://github.com/electron/electron/releases/tag/v44.0.0
- https://github.com/electron/electron/releases
- https://www.electronjs.org/docs/latest/api/utility-process
- https://www.electronjs.org/docs/latest/tutorial/security
- https://www.electronjs.org/docs/latest/tutorial/fuses
- https://www.electronjs.org/docs/latest/tutorial/performance
- https://www.electronjs.org/docs/latest/tutorial/message-ports
- https://www.electronjs.org/docs/latest/api/safe-storage
- https://www.electronjs.org/docs/latest/tutorial/updates
- https://www.electronjs.org/docs/latest/tutorial/forge-overview
- https://github.com/electron/electron/blob/main/docs/api/environment-variables.md
- https://github.com/electron/electron/issues/42510
- https://github.com/electron/electron/issues/41066
- https://github.com/electron/electron/issues/47671
- https://www.electronforge.io/advanced/auto-update
- https://github.com/electron/forge/releases
- https://www.electron.build/docs/features/auto-update
- https://www.electron.build/docs/features/code-signing/
- https://www.electron.build/docs/configuration
- https://github.com/electron-userland/electron-builder/releases
- https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/templates/linux/after-install.tpl
- https://github.com/electron-userland/electron-builder/blob/master/packages/electron-updater/src/providers/GitHubProvider.ts
- https://hydraulic.dev/pricing.html
- https://v2.tauri.app/
- https://v2.tauri.app/learn/sidecar-nodejs/
- https://v2.tauri.app/plugin/updater/
- https://v2.tauri.app/reference/webview-versions/
- https://github.com/tauri-apps/tauri/releases
- https://nodejs.org/api/single-executable-applications.html
- https://nodejs.org/api/sqlite.html
- https://nodejs.org/api/cli.html
- https://github.com/nodejs/Release/blob/main/schedule.json
- https://nodejs.org/dist/latest-v24.x/
- https://github.com/blackboardsh/electrobun
- https://framework.blackboard.sh/electrobun/
- https://github.com/neutralinojs/neutralinojs
- https://github.com/redis/RedisInsight
- https://github.com/redis/RedisInsight/blob/main/redisinsight/desktop/src/lib/server/server.ts
- https://github.com/RedisInsight/RedisInsight/wiki/How-to-build-and-contribute
- https://cdn.jsdelivr.net/gh/redis/redisinsight@main/README.md
- https://headlamp.dev/docs/latest/development/architecture
- https://github.com/kubernetes-sigs/headlamp/blob/main/app/package.json
- https://github.com/beekeeper-studio/beekeeper-studio/blob/master/apps/studio/src-commercial/entrypoints/main.ts
- https://github.com/beekeeper-studio/beekeeper-studio/blob/master/apps/studio/electron-builder-config.js
- https://github.com/usebruno/bruno/blob/main/packages/bruno-electron/electron-builder-config.js
- https://github.com/freelensapp/freelens
- https://github.com/freelensapp/freelens/blob/main/AGENTS.md
- https://docs.hoppscotch.io/documentation/clients/desktop/overview
- https://docs.hoppscotch.io/documentation/clients/desktop/setup
- https://signpath.org/
- https://signpath.org/terms
- https://docs.signpath.io/trusted-build-systems/github
- https://learn.microsoft.com/en-us/azure/artifact-signing/overview
- https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart
- https://azure.microsoft.com/en-us/pricing/details/artifact-signing/
- https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account
- https://learn.microsoft.com/en-us/windows/package-manager/package/repository
- https://github.com/vedantmgoyal9/winget-releaser
- https://developer.apple.com/programs/
- https://developer.apple.com/support/membership-fee-waiver/
- https://developer.apple.com/news/?id=saqachfa
- https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy
- https://docs.brew.sh/Acceptable-Casks
- https://brew.sh/2025/11/12/homebrew-5.0.0/
- https://docs.flathub.org/docs/for-app-authors/requirements
- https://docs.flatpak.org/en/latest/electron.html
- https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- https://docs.github.com/en/actions/tutorials/use-containerized-services/use-docker-service-containers
- https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases
- https://github.com/actions/attest-build-provenance
- https://docs.docker.com/build/ci/github-actions/multi-platform/
- https://github.com/GoogleContainerTools/distroless
- https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md
- https://helm.sh/blog/
- https://helm.sh/docs/chart_best_practices/values/
- https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/
- https://github.com/helm/chart-testing
- https://github.com/norwoodj/helm-docs
- https://github.com/sigstore/cosign
- https://github.com/aquasecurity/trivy
- https://github.com/panva/openid-client
- https://github.com/oauth2-proxy/oauth2-proxy
- https://ui.docs.kafbat.io/configuration/rbac-role-based-access-control
- https://www.rfc-editor.org/rfc/rfc8252
- https://www.rfc-editor.org/rfc/rfc6265#section-8.5
- https://jupyter-server.readthedocs.io/en/latest/operators/security.html
- https://developer.chrome.com/blog/local-network-access
- https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage
- https://socket.io/docs/v4/using-multiple-nodes/
- https://socket.io/docs/v4/adapter/
- https://www.postgresql.org/docs/current/sql-notify.html
- https://www.rabbitmq.com/release-information
- https://www.rabbitmq.com/docs/oauth2
- https://www.rabbitmq.com/docs/management
- https://www.rabbitmq.com/docs/definitions
- https://www.rabbitmq.com/kubernetes/operator/using-operator
- https://www.rabbitmq.com/kubernetes/operator/using-topology-operator
- https://github.com/rabbitmq/cluster-operator
- https://github.com/rabbitmq/messaging-topology-operator
- https://github.com/kubernetes-client/javascript
- https://github.com/atom/node-keytar
- https://github.com/Brooooooklyn/keyring-node
- https://github.com/WiseLibs/better-sqlite3
- https://github.com/drizzle-team/drizzle-orm
- https://github.com/kysely-org/kysely
- https://pglite.dev/docs/
- https://github.com/electric-sql/pglite
- https://node.testcontainers.org/modules/rabbitmq/
- https://github.com/testcontainers/testcontainers-node/releases
- https://playwright.dev/docs/api/class-electron
- https://github.com/microsoft/playwright/releases
- https://nx.dev/docs/features/enforce-module-boundaries
- https://nx.dev/docs/features/enhance-ai
- https://nx.dev/pricing
- https://nx.dev/docs/guides/nx-release/release-projects-independently
- https://github.com/nrwl/nx/releases
- https://github.com/bennymeg/nx-electron
- https://turborepo.dev/docs/reference/boundaries
- https://github.com/vercel/turborepo/releases
- https://github.com/pnpm/pnpm/releases
- https://angular.dev/reference/releases
- https://angular.dev/reference/versions
- https://angular.dev/guide/testing
- https://angular.dev/best-practices/security
- https://github.com/vitest-dev/vitest/releases
- https://biomejs.dev/internals/language-support/
- https://github.com/biomejs/biome/releases
- https://github.com/angular-eslint/angular-eslint/releases
- https://github.com/microsoft/TypeScript/releases
- https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
- https://devblogs.microsoft.com/typescript/
- https://github.com/nestjs/nest/releases/tag/v12.0.0
- https://docs.nestjs.com/openapi/introduction
- https://orpc.dev/docs/adapters/electron
- https://orpc.dev/docs/adapters/message-port
- https://github.com/middleapi/orpc
- https://orval.dev/docs/guides/angular
- https://github.com/hey-api/openapi-ts
- https://github.com/ts-rest/ts-rest
- https://github.com/microsoft/typespec
- https://github.com/asyncapi/spec
- https://github.com/colinhacks/zod
- https://github.com/oasdiff/oasdiff
- https://github.com/withastro/starlight
- https://github.com/facebook/docusaurus
- https://github.com/vuejs/vitepress
- https://github.com/HiDeoo/starlight-openapi
- https://github.com/changesets/changesets
- https://github.com/googleapis/release-please
- https://github.com/semantic-release/semantic-release
- https://github.com/amannn/action-semantic-pull-request
- https://choosealicense.com/licenses/apache-2.0/
- https://developercertificate.org/
- https://code.claude.com/docs/en/memory
- https://code.claude.com/docs/en/best-practices
- https://github.com/ossf/scorecard-action
- https://github.com/renovatebot/renovate
- https://github.com/websockets/ws
- https://github.com/socketio/socket.io
