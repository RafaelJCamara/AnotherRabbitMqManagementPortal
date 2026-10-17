# `<Product>` for RabbitMQ®

> **Status: planning.** No product code yet. The product name is deferred ([ADR-029](docs/adr/ADR-029-product-name.md)); this repository is private until a cleared name is chosen.

An open-source (Apache-2.0) workbench and control plane for RabbitMQ: one TypeScript engine and one Angular UI, shipped **web-first** as a single-user Docker web app, then as desktop apps for Windows, Linux and macOS, then as a free self-hosted team server ([ADR-030](docs/adr/ADR-030-web-first-delivery-order.md)).

## What makes it different
- **Version-correct, side-effect-aware message tools.** Peek, tap and dead-letter replay follow what each RabbitMQ version really does, backed by a public conformance matrix.
- **Admin + messages + ops in one tool**, with correct effective-policy resolution, a routing simulator, a stream browser and a lint/upgrade advisor.
- **Everything is free and open source**, including SSO, RBAC, audit, approvals and masking ([ADR-031](docs/adr/ADR-031-fully-open-source.md)).
- **Local-first:** no telemetry, works offline.

## Documentation
Start at [`docs/README.md`](docs/README.md). Key entry points:
- [The approved plan](docs/plan/plan.md) · [Milestones](docs/product/milestones.md) · [Architecture blueprint](docs/architecture/blueprint.md) · [ADRs](docs/adr/README.md) · [Verified fact sheet](docs/research/fact-sheet.md)

## How work is tracked
GitHub is the system of record ([ADR-033](docs/adr/ADR-033-github-as-system-of-record.md)): every milestone is a GitHub milestone and every piece of work is a GitHub issue. No work without an issue. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License and trademarks
Apache-2.0 (see [LICENSE](LICENSE) and [NOTICE](NOTICE)). RabbitMQ is a trademark of Broadcom, Inc. in the U.S. and other countries. This project is not affiliated with or endorsed by Broadcom. See [TRADEMARKS.md](TRADEMARKS.md).
