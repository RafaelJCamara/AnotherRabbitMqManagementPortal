---
title: Outbound calls
description: Every network call the product makes, and why.
editUrl: false
---

&lt;Product&gt; is local-first: it sends no telemetry and works offline ([ADR-026](../../adr/adr-026/)). This page is the audited list of outbound network calls; a release whose list changed needs a reviewed diff of this page.

This page is generated from the Dialer's purpose registry (`libs/engine/net-dialer/src/purposes.ts`) by `pnpm nx run net-dialer:outbound-calls`. Do not edit it by hand: `pnpm nx run net-dialer:outbound-calls-check` fails when it differs from the registry.

## Current state

3 purposes are in the product today and 5 are registered ahead of the code that will use them. Every destination is one the person configured, and the product contacts none of them until they do. With no broker profile added and updates off, the product makes **no outbound calls**: the deny-all egress test (`pnpm nx run engine:egress`) starts the engine behind a guard that records and refuses every connection attempt, name lookup and datagram, exercises it, and fails on a single one. The guard covers the engine's JavaScript; a run of the container with no network at all is still to come.

## Rules

- Every outbound socket goes through the Dialer and the trust store, so each call has a registered purpose. A Dialer given the registry refuses a purpose that is not on it.
- Update checks are **opt-in**, asked once at first run, and never on by default.
- There is no telemetry and no crash-report upload. A diagnostics bundle is written to a local file the person chooses; sending it anywhere is the person's act, to an endpoint they configured.
- Desktop builds disable the spellchecker or bundle its dictionaries, because the default one downloads dictionaries from a third-party CDN.

## Audited calls

| Purpose | Feature | Destination | Trigger | Default | Status |
| --- | --- | --- | --- | --- | --- |
| `amqp` | Messaging (AMQP 0-9-1) | The broker host and port of a connection profile the person added | A peek, publish, tap or source lease on that connection | Never until a broker profile exists | Built |
| `mgmt-http` | Management HTTP API | The management endpoint of a connection profile the person added | Browsing and managing that broker, and the capability probe | Never until a broker profile exists | Built |
| `prom-scrape` | Metrics (Prometheus endpoint) | The Prometheus endpoint of a connection profile the person added | The background metrics sweep of that broker | Never until a broker profile exists | Built |
| `oidc` | Single sign-on and broker OAuth | The identity provider (discovery, key set and token endpoints) an administrator configured | A sign-in, a key refresh or a token refresh | Never until an identity provider is configured | Registered, not built |
| `alert-webhook` | Alert notifications | The webhook or mail endpoint the person configured for a rule | An alert rule fires | Never until a notification channel is configured | Registered, not built |
| `otlp-export` | OpenTelemetry export | The OTLP endpoint the person configured | Spans and metrics of this tool, while the endpoint is set | Off; the exporter is not even loaded until an endpoint is set | Registered, not built |
| `diagnostics-upload` | Diagnostics upload | The endpoint the person configured; the bundle is otherwise only written to a local file | The person chooses to send a diagnostics bundle | Off; there is no default endpoint | Registered, not built |
| `update-check` | Update check (desktop) | The release feed of this product | Startup and a timer, after the person opted in at first run | Off; asked once at first run, with no preselected answer | Registered, not built |
