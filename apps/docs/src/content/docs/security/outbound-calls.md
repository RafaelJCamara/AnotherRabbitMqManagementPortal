---
title: Outbound calls
description: Every network call the product makes, and why.
editUrl: false
---

&lt;Product&gt; is local-first: it sends no telemetry and works offline ([ADR-026](../../adr/adr-026/)). This page is the audited list of outbound network calls; a release whose list changed needs a reviewed diff of this page.

## Current state

The repository is an early scaffold with no product runtime yet, so the product makes **no outbound calls** today.

## Rules

- Every outbound socket goes through the Dialer and the trust store, so each call has a registered purpose.
- Update checks are **opt-in**, asked once at first run, and never on by default.
- There is no telemetry and no crash-report upload.
- Desktop builds disable the spellchecker or bundle its dictionaries, because the default one downloads dictionaries from a third-party CDN.

## Audited calls

| Feature | Destination | Trigger | Default |
| --- | --- | --- | --- |
| *None yet* | | | |

The Dialer's purpose registry will generate this table once it exists.
