# Threat model

> **Design-phase output (2026-10-16).** Amended by [`docs/plan/amendments.md`](../plan/amendments.md), which takes precedence, and re-sequenced web-first ([ADR-030](../adr/ADR-030-web-first-delivery-order.md), [`docs/product/milestones.md`](../product/milestones.md)). Content about a specific third-party product was removed under the docs policy ([ADR-034](../adr/ADR-034-docs-policy.md)).

Security design per delivery mode is in the [blueprint](blueprint.md) (security section) and the [plan](../plan/plan.md) §4.5. Detailed auth/connectivity research: [auth-network-security](../research/auth-network-security.md). A threat-model refresh is scheduled before Web 1.0 (M1 security review) and before the team server (M5).

# Enterprise sign-in, connectivity and threat model (verified 2026-10-16)

**Scope.** The engine is written in TypeScript and runs on Node 24 in three places:

- **Desktop:** an Electron 44.8.0 `utilityProcess`. Electron 44.8.0 bundles Node 24.22.0 and Chromium 152 ([releases.json](https://releases.electronjs.org/releases.json)).
- **Local web:** started with `npx` or as a Docker container.
- **Team server:** NestJS 12.

**RabbitMQ versions checked.** Source was read at the latest tags of each line: **v3.13.7, v4.0.9, v4.1.8, v4.2.9 and v4.3.6** ([tags](https://api.github.com/repos/rabbitmq/rabbitmq-server/tags)). For the next release I used the drafts on main ([4.4.0.md](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.4.0.md), 4.3.7.md and 5.0.0.md).

**How to read references.** `file@tag Lnn` points to a raw file at that tag, for example `https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.6/deps/rabbit/src/rabbit_reader.erl`.
