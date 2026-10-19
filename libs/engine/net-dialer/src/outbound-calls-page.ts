// The docs page `security/outbound-calls`, rendered from the purpose registry (M0-69, DC-59). The
// text around the table is here too, so that the whole page is generated and a hand edit shows up
// as drift in `outbound-calls-check`.
import type { PurposeSpec } from './purposes.ts';

const cell = (text: string): string => text.replaceAll('|', '\\|');

function table(purposes: readonly PurposeSpec[]): string {
  if (purposes.length === 0) {
    return 'No outbound call is registered.';
  }
  const rows = purposes.map((purpose) =>
    [
      `\`${purpose.id}\``,
      purpose.feature,
      purpose.destination,
      purpose.trigger,
      purpose.default,
      purpose.status === 'active' ? 'Built' : 'Registered, not built',
    ]
      .map(cell)
      .join(' | '),
  );
  return [
    '| Purpose | Feature | Destination | Trigger | Default | Status |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row} |`),
  ].join('\n');
}

export function renderOutboundCallsPage(
  purposes: readonly PurposeSpec[],
): string {
  const active = purposes.filter((purpose) => purpose.status === 'active');
  const planned = purposes.length - active.length;
  return `---
title: Outbound calls
description: Every network call the product makes, and why.
editUrl: false
---

&lt;Product&gt; is local-first: it sends no telemetry and works offline ([ADR-026](../../adr/adr-026/)). This page is the audited list of outbound network calls; a release whose list changed needs a reviewed diff of this page.

This page is generated from the Dialer's purpose registry (\`libs/engine/net-dialer/src/purposes.ts\`) by \`pnpm nx run net-dialer:outbound-calls\`. Do not edit it by hand: \`pnpm nx run net-dialer:outbound-calls-check\` fails when it differs from the registry.

## Current state

${String(active.length)} purpose${active.length === 1 ? ' is' : 's are'} in the product today and ${String(planned)} ${planned === 1 ? 'is' : 'are'} registered ahead of the code that will use ${planned === 1 ? 'it' : 'them'}. Every destination is one the person configured, and the product contacts none of them until they do. With no broker profile added and updates off, the product makes **no outbound calls**: the deny-all egress test (\`pnpm nx run engine:egress\`) starts the engine behind a guard that records and refuses every connection attempt, name lookup and datagram, exercises it, and fails on a single one. The guard covers the engine's JavaScript; a run of the container with no network at all is still to come.

## Rules

- Every outbound socket goes through the Dialer and the trust store, so each call has a registered purpose. A Dialer given the registry refuses a purpose that is not on it.
- Update checks are **opt-in**, asked once at first run, and never on by default.
- There is no telemetry and no crash-report upload. A diagnostics bundle is written to a local file the person chooses; sending it anywhere is the person's act, to an endpoint they configured.
- Desktop builds disable the spellchecker or bundle its dictionaries, because the default one downloads dictionaries from a third-party CDN.

## Audited calls

${table(purposes)}
`;
}
