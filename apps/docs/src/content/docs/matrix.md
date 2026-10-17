---
title: Conformance matrix
description: What each RabbitMQ version does, per semantics cell, with its evidence.
editUrl: false
---

The conformance matrix lists every cell of the semantics registry with a result for each supported RabbitMQ version. Each result is `pass`, `fail` or `unverified`, and links to the cell's CF id and the lab evidence recorded by CI ([ADR-007](../adr/adr-007/), [ADR-025](../adr/adr-025/)).

**No conformance run has been published yet.** Every cell is therefore *unverified*. The matrix is generated per release by the conformance work packages of milestone M0; nothing on this page is claimed without recorded evidence.

## Target versions

| Tier | Versions |
| --- | --- |
| Tier 1 | 4.2.9, 4.3.6 |
| Tier 2 | 3.13.7, 4.1.8 |
| Best effort | 4.0.9 |

Peek, tap and dead-letter replay stay gated until the settle-path cells are green on all five versions.
