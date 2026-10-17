# ADR-031: Fully open source (Apache-2.0)

- **Status:** Accepted
- **Date:** 2026-10-16
- **Decided by:** maintainer

## Decision
- Apache-2.0 for everything, including team-server governance (SSO, RBAC, audit, approvals, masking).
- No paid tiers, no SaaS, no open-core split.
- DCO sign-off instead of a CLA.
- A public pledge: the core licence never changes and no feature moves behind a paywall.

## Rationale
- De facto tools in adjacent ecosystems were free and vendor-neutral. Competitors put governance behind paywalls, so a free team server is a differentiator.
- Apache-2.0 adds a patent grant that enterprises value.
- It keeps the project eligible for free OSS code signing, which forbids commercial dual-licensing.

## Alternatives considered
- Open core: recommended by the strategy research; rejected by the maintainer.
- A commercial licence.
- Source-available licences.

## Consequences
Sustainability relies on sponsorship and community. Costs are kept minimal:
- free CI once the repo is public;
- the Microsoft Store and OSS signing routes;
- an Apple account only from M4.
