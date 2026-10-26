# Milestones (web first, then Windows, Linux, macOS)

Each milestone is a GitHub milestone; its exit criteria and release checklist are tracked in a `type:chore` "release & exit checklist" issue. Source: the approved plan ([`docs/plan/plan.md`](../plan/plan.md) §3).

**Current goal: Web 1.0, public on 2026-11-30** ([ADR-035](../adr/ADR-035-web-1-0-by-2026-11-30-desktop-after.md), amendment A-26). Until it ships, all work goes to M0 and M1. Desktop work starts after the release.

| Target date | Checkpoint |
| --- | --- |
| 2026-11-13 | M0 exit: conformance gate on, matrix v0, container image and image release workflow |
| 2026-11-16 | ADR-029 (product name) accepted; the M1-38 chaos run has started its 7 clean nights |
| 2026-11-23 | Beta freeze: every M1 feature merged |
| 2026-11-27 | Repo public, GHCR public, docs published |
| **2026-11-30** | **Web 1.0 "Developer" public release** |

The dates are targets: the M1 scope is fixed, and if the work is late the date slips. Milestones after M1 have no dates yet.

Each desktop milestone has two lanes, run by agents in parallel worktrees:
- a **platform lane**: shell, packaging, signing, OS integration;
- a **feature lane**: features that ship to the web app and to every desktop platform already released.

| Milestone | Deliverable | Platform lane | Feature lane | Exit criteria (abridged) |
| --- | --- | --- | --- | --- |
| **M0 Foundations & evidence** (internal alpha 0.1; target 2026-11-13) | Engine + UI running as a **single-user Docker web app**, proving what each RabbitMQ version does, with a read-only explorer | Container mode (loopback bind, token, data volume, healthcheck), multi-arch image, private GHCR, release workflow for images | Repo, gates, agent toolchain; contracts kit; semantics registry and era resolver; broker lab and lab evidence; capability probe; persistence and secrets (file KEK / passphrase); ActionExecutor and audit; HTTP + WebSocket transport; Angular shell; explorer | Settle-path cells three-way green on 3.13.7 / 4.1.8 / 4.2.9 / 4.3.6 (4.0.9 visible, non-blocking); matrix v0. Explorer works in the container against local, Amazon MQ and CloudAMQP brokers. Image signed (cosign) and private. All gates enforced |
| **M1 Web 1.0 "Developer"** (first public release, target 2026-11-30; needs ADR-029 name) | **The dockerized web app** as the best developer tool for RabbitMQ | Compose quickstart (app + RabbitMQ); host-broker networking (`host.docker.internal`, Linux `host-gateway`); SSH-tunnel guide for remote use; browser matrix (Chrome, Edge, Firefox, Safari); public GHCR (and optional Docker Hub mirror) | Safe peek, publish, tap, stream browser, routing simulator, effective config, DLQ basics (inventory, deaths, replay), queue/exchange admin, TLS/mTLS/tunnels/OAuth (PKCE redirect to the app origin), live metrics and forecast, palette, a11y, i18n, docs | Every peek receipt matches the conformance matrix. M1 developer checklist 100%. Time-to-first-peek < 3 min from `docker run` in usability tests (Windows, macOS and Linux hosts). Devtools listing PR |
| **M2 Windows desktop 1.0** (starts after Web 1.0) | Signed Windows app (x64 + arm64) | Desktop spikes first (M2-P18 MessagePort/utilityProcess/node:sqlite, M2-P19 Electron crypto/TLS and Windows signing; U-16, U-21); signing accounts (H-09); Electron shell (main, preload, supervisor, **MessagePort tunnel**, `app://`, fuses, CSP); safeStorage key wrap; OS notifications; system-browser OAuth; native menus; MSIX (Store) + NSIS (Certum/SignPath), electron-updater; Windows CI with broker-lab reachability; MSIX virtualisation and data-directory rules; spellchecker off; desktop egress E2E; optional `npx` local-web channel | **Management parity I:** vhosts, users, permissions, topic permissions, limits; connections, channels, consumers; nodes and health checks; feature flags and deprecated features; **policy and operator-policy editor** | Windows release passes signature, WACK and SmartScreen-free (Store) checks. Desktop E2E green on Windows x64 and arm64. Parity I live on web + Windows |
| **M3 Linux desktop 1.0** | Linux app (x64 + arm64) | deb/rpm with AppArmor profile, AppImage (Ubuntu 24.04 caveat), signed apt/rpm repositories or updater; Secret Service / basic_text → master password; X11 and Wayland checks; Linux desktop E2E (xvfb) | **Management parity II + DLQ operations centre:** definitions, shovels/federation, QQ replica ops, CLI runbooks, guarded bulk ops; full replay engine, edit and resend, move/copy/selective delete; plugin SDK + framework decoders v1.0 | Official-UI parity checklist: every HTTP-available action native, CLI-only actions have runbooks. Decoder fixture apps pass. Replay chaos: **0 lost; duplicates detectable (replay-id) and within a stated bound**. Linux packages pass install/upgrade tests on Ubuntu, Fedora and Debian |
| **M4 macOS desktop 1.0** | Notarised macOS app (arm64 + x64) | Developer ID signing + notarisation, DMG + zip, Local Network permission (`NSLocalNetworkUsageDescription`), keychain prompts, Homebrew tap, macOS E2E | **Advanced messaging & ecosystem:** exchange-to-exchange tap, firehose leases, stream ops and filter builder; publish collections, bulk publish, generators, request/reply, copy-as-code; providers + Kubernetes discovery; local IPC + tool CLI + read-only MCP; free web utilities | `spctl`/`codesign` checks pass. macOS E2E green on arm64 + x64. **All four platforms at 1.x** with parity and the DLQ centre |
| **M5 Free team server** (2.0) | The Docker web app gains multi-user mode | Helm chart (restricted PSS), Compose quickstart, Postgres, air-gap kit | Team runtime, OIDC BFF, RBAC, shared catalogue and pollers, delegated credentials, audit and anchors, approvals, masking, SSRF egress, desktop remote workspaces, revoke/freeze, security review, team privacy, scale tests | Every mutating API has RBAC and audit tests. Delegated OAuth works with Keycloak 26 and Entra. Compose quickstart < 10 min |
| **M6 Ops intelligence** | All platforms | Flathub / Snap wave | Lint engine, upgrade advisor, diagnostics, history store, alerts, fleet and event timeline, decoders v1.1 + analytics, stream fast path, topology diff | Rule catalogue covers all DC-56 hazards with per-version fixtures. Upgrade advisor validated on 4.2→4.3 and 4.4. Alerts proven end to end |
| **M7 Governed AI & MCP** | All platforms | — | Team `/mcp` OAuth resource, governed mutating tools, injection hardening, grounded copilot, red-team gate | RFC 8707 audience tests pass. Red-team corpus passes. Zero AI calls when unconfigured |
| **M8 Platform scale & ecosystem** | All platforms | HA team server | Plan/apply topology-as-code, IaC/AsyncAPI, drift, SCIM, self-service, node agent, migration wizard, UI extensions, foundation application | Terraform and Topology Operator round-trips. HA survives replica loss. Node-agent zero-side-effect cells pass |

**Why this order** (user decision plus supporting reasons):
- **Web 1.0 is the only goal until it ships** (ADR-035). Desktop work before then would delay the only release with a date.
- **Docker web first.** One artefact runs everywhere Docker runs. It needs no signing costs or OS approvals, and gives the fastest feedback loop. It is the natural base for the later team server.
- **Desktop shells add platforms, not a rewrite.** Each one reuses the same engine and UI.
- **Windows before Linux and macOS.** Windows has the largest desktop share and the hardest signing story.
- **macOS last.** That defers the Apple Developer cost.
- **Correctness evidence still comes first (M0).** Peek, tap and DLQ ship only behind the conformance gate.

**Desktop is deferred, not designed out.**
- The ADR-002 MessagePort transport, the `EngineTransport`/`PlatformBridge` abstractions and the engine's mode files are designed in M0.
- A transport test runs the contract suite over HTTP/WS and a fake port.
- The UI stays browser-API-clean.
- Desktop spikes open M2 (ADR-035 moved them out of the M1 tail), so M2 starts by settling the desktop runtime questions.
- **Signing lead time:** the Windows signing accounts (Microsoft Partner Center, Certum; H-09) are opened at the start of M2. The maintainer may open them earlier, but they are not on the Web 1.0 path.

---
