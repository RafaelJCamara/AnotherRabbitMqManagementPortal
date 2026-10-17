# ADR-026: Signed, telemetry-free releases with exact pins and opt-in updates

- **Status:** Accepted
- **Date:** 2026-10-16
- **Source:** design panel (final blueprint); see [docs/architecture/blueprint.md](../architecture/blueprint.md)

## Decision

release-please keeps one product version. Distribution channels:
- macOS: notarised from day one;
- Windows: Store MSIX first, then NSIS with SignPath two-pass signing and latest.yml regenerated;
- Linux: deb/rpm with an AppArmor profile, plus AppImage with a caveat;
- npm: trusted publishing;
- images: distroless on GHCR with cosign and an SBOM;
- Helm: OCI chart.
Releases are immutable, and notices and the SBOM are generated from the esbuild metafile. Update checks are opt-in at first run. Pins: electron-builder 26.17.0 and electron-updater 6.8.10.

## Rationale

Required by DC-58 and DC-59, and avoids the verified registry traps.

## Alternatives considered

electron-builder latest (26.15.3 violates DC-50); update checks on by default; Electron Forge.

## Consequences

Apple costs $99/yr and Store submission is extra work. Store, Homebrew and winget builds update through their own channels.

## Amendments

A-22: nothing is published until ADR-029 is accepted. Release order follows ADR-030: image (M1), Windows (M2), Linux (M3), macOS (M4). See [docs/plan/amendments.md](../plan/amendments.md).
