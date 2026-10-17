---
title: Overview
description: Open-source workbench and control plane for RabbitMQ.
editUrl: false
---

> **Status: early scaffold (milestone M0).** The product name is deferred ([ADR-029](adr/adr-029/)), so this site and its repository are private and the `<Product>` token is a placeholder.

&lt;Product&gt; is an open-source (Apache-2.0) workbench and control plane for RabbitMQ: one TypeScript engine and one Angular UI, shipped web-first as a single-user Docker web app, then as desktop apps, then as a free self-hosted team server ([ADR-030](adr/adr-030/)).

## What is on this site

- [Architecture decision records](adr/): every ADR, generated from the repository at build time.
- [Conformance matrix](matrix/): RabbitMQ behaviour per version, backed by independent lab evidence. Empty until the first conformance run is published.
- [Outbound calls](security/outbound-calls/): the audited list of network calls the product makes.
- Engine API reference: generated from the contract registry once it exists.
