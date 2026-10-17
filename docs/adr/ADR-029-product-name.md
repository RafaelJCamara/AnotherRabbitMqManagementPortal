# ADR-029: Product name and brand

- **Status:** Proposed (must be Accepted before the Web 1.0 public release, milestone M1)
- **Date:** 2026-10-16

## Context
RabbitMQ trademark guidelines forbid "RabbitMQ" or "RMQ" in product, company, domain, package or repo names, reserve the logos, and allow the descriptor "<Name> for RabbitMQ®". The crowded rabbit-themed namespace makes rabbit-derived names risky.

## Decision (pending)
Choose a coined, non-rabbit brand, cleared via USPTO/EUIPO/WIPO searches and an email to the RabbitMQ core team. Until then: a private codename for internal identifiers (appId, data paths, env prefix), a private repository and images, and no npm or other public artefacts.

## Candidates
Sortyard (recommended), Kewbench, Relaybay; collision checks in [docs/product/naming.md](../product/naming.md).

## Consequences
Gates public GHCR images, the docs site, the devtools listing and the Web 1.0 release. A later rename keeps issues and milestones (GitHub redirects).
