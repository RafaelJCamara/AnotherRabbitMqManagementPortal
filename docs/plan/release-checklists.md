# Release checklists

> **Design-phase output (2026-10-16).** Amended by [`docs/plan/amendments.md`](../plan/amendments.md), which takes precedence, and re-sequenced web-first ([ADR-030](../adr/ADR-030-web-first-delivery-order.md), [`docs/product/milestones.md`](../product/milestones.md)). Content about a specific third-party product was removed under the docs policy ([ADR-034](../adr/ADR-034-docs-policy.md)).

> Written before the web-first re-sequencing. The per-channel release gates in [plan.md](plan.md) §7 take precedence: image (M1), Windows (M2), Linux (M3), macOS (M4), team (M5). For M0 and M1 (Web 1.0, public release targeted for 2026-11-30 by [ADR-035](../adr/ADR-035-web-1-0-by-2026-11-30-desktop-after.md)), the Desktop and npm sections below do not apply, and the e2e-desktop run starts in M2.

**Every milestone** (gated on the release-please PR and the tag):
- [ ] A maintainer has reviewed the release PR: changelog, version, ADR links.
- [ ] Conformance:
  - Tier 1 (4.2.9, 4.3.6) and Tier 2 (3.13.7, 4.1.8) cells are all green.
  - 4.0.9 is recorded on a best-effort basis.
  - Nightly alpha runs have been reviewed.
  - The matrix is regenerated and published.
- [ ] Full CI on the tag:
  - unit, architecture, golden and contract suites;
  - e2e-web; e2e-desktop (full on Linux, smoke on macOS and Windows);
  - accessibility, bundle budgets, and performance (no regression above 15 %);
  - CodeQL and OSV clean.
  - Release-age exclusions have been reviewed.
- [ ] Desktop:
  - **macOS:** arm64 and x64 dmg/zip are signed, notarised and stapled. `codesign --verify --deep --strict`, `spctl --assess` and `xcrun stapler validate` pass.
  - **Windows:** the MSIX goes to the Store flight. NSIS/zip for x64 and arm64 are signed, and `latest.yml` and the blockmap are regenerated after signing.
  - **Linux:** deb/rpm for x64 and arm64 install the AppArmor profile; AppImage carries the documented caveat.
  - `fuse-check` passes on every artefact.
  - A fresh-VM install smoke passes on all three OSes: launch → connect to broker-lab → explorer, plus a receipt where applicable.
  - Update metadata is correct and the opt-in choice is respected.
- [ ] npm:
  - Published through trusted publishing with provenance, under the `alpha`, `beta` or `latest` dist-tag.
  - `npx <product>@x.y.z serve --no-open` passes a smoke test on Linux, macOS and Windows.
  - `npm audit signatures` passes.
- [ ] Docker:
  - Multi-arch image published by digest; `cosign verify` passes.
  - SBOM and provenance attestations are attached.
  - Trivy reports no CRITICAL.
  - Smoke with `docker run -p 127.0.0.1:8765:8765`, including the container-mode Host tests.
  - SIGTERM exits within 2 s.
- [ ] Helm (from M3):
  - `helm lint` passes.
  - `ct install` on kind passes under restricted PSS and readiness.
  - The values schema rejects invalid values.
  - The chart is signed with cosign and pushed as OCI.
- [ ] Per artefact: THIRD_PARTY_NOTICES and a CycloneDX SBOM, generated from the esbuild metafile, Angular stats and the electron-builder file list. Plus SHA256SUMS and build attestations.
- [ ] Draft release assets are verified, then the release is published as immutable. Docs are deployed. The outbound-calls page is unchanged, or has been reviewed.
- [ ] Within 24 h of release:
  - Install from every public channel: brew tap, winget, npx, docker pull, Store.
  - Have a rollback ready: move the npm dist-tag, revert the tap or winget manifest, repoint the image tag. Desktop rollback means shipping an N+1 patch, because releases are immutable.

**Milestone deltas**
| Milestone | Version and channels | Extra gates |
| --- | --- | --- |
| **M0 internal alpha** (target 2026-11-13) | 0.1.0-alpha.N. Channels: GitHub prerelease; private GHCR image. No npm, Store, tap or winget (desktop and npm move to M2, ADR-035) | - Matrix v0 published<br>- Amazon MQ + CloudAMQP probe run<br>- Licence, git-dependency and TS-pin gates proven by the self-test |
| **M1 Web 1.0 "Developer"** (target 2026-11-30) | 0.9.x public beta, then 1.0.0. Channels: GitHub release; public GHCR (optional Docker Hub mirror); docs site. Needs ADR-029 accepted and the repo public (A-22) | - Every peek receipt matches the conformance matrix<br>- M1 developer checklist 100%<br>- Time-to-first-peek under 3 min from `docker run`<br>- Pre-1.0 security review (M1-60)<br>- Deny-all egress run of the container |
| **M2** | 1.x | - Parity checklist against the official UI 4.3.6<br>- Decoder fixture apps: MassTransit v8, Spring, NServiceBus, EasyNetQ, Celery<br>- 10k-replay chaos run with zero loss and zero duplicates<br>- Local MCP passes the SDK-oracle tests |
| **M3** | 2.0, plus the team image and OCI chart | - Helm on kind under restricted PSS<br>- Compose quickstart in under 10 min<br>- An RBAC test and an audit attempt/outcome test for every mutating API<br>- Audit verify and restore drill<br>- Keycloak 26 + Entra delegated OAuth<br>- SSRF suite<br>- Security review sign-off |
| **M4** | 2.x | - DC-56 rule fixtures per version<br>- Upgrade advisor validated on 4.2.9→4.3.6 labs, and on 4.4 within 14 days of GA<br>- Alert delivery E2E (Slack, Teams, email, webhook)<br>- Flathub + Snap |
| **M5** | 2.x | - /mcp audience tests (RFC 8707)<br>- Injection red-team corpus<br>- Zero outbound AI calls when no endpoint is configured |
| **M6** | 3.0 | - Plan/apply round trips on Terraform and Topology Operator fixtures<br>- HA replica-loss chaos with no duplicate publishes<br>- Node-agent zero-side-effect cells<br>- Foundation application |
