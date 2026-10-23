// Is the death history the broker's own record? Up to 3.13 the broker interprets a client-published
// `x-death` (it merges it into its record); from 4.0 it keeps it as an opaque header, delivers it
// verbatim until the next dead-lettering and then replaces it (release notes 4.0.1; tap-streams-ops
// T3). Which of the two applies is registry data (`clientDeathHeaderInterpreted`, I-3) and arrives
// as the context; this file never sees a version.
//
// On the 4.x side the message alone cannot prove a copy: the copy of a broker header is
// byte-identical. The verdict is therefore evidence-based. Evidence of a client copy is the
// caller's hint, a replay stamp of this product, a header only a republishing framework writes, or
// a history without `x-first-death-*`; a disagreement between first/last and the records makes the
// history `inconsistent`. A consistent record without such evidence is `broker-shaped` and trusted,
// and its reasons say nothing proves it was not copied (OQ-1043).
import { lookupNamed } from './counters.ts';
import type { MessageParts } from './entries.ts';
import type { ReadContext } from './read.ts';
import type { DeathTrust, HistoryFlag, TrustReason } from './types.ts';

/** Headers this product writes on a replay (research: a redrive tool writes its own headers). */
export const REPLAY_STAMPS: readonly string[] = [
  'x-redrive-count',
  'x-redriven-from',
  'x-redriven-at',
];

/** Headers a republishing framework writes (Spring AMQP / Spring Cloud Stream, research C6). */
export const REPUBLISH_MARKERS: readonly string[] = [
  'x-original-exchange',
  'x-original-routingKey',
  'x-exception-message',
  'x-exception-stacktrace',
];

export interface Markers {
  readonly stamps: readonly string[];
  readonly republish: readonly string[];
}

/** Which of the fixed marker headers are present. Only names are read, never values. */
export function findMarkers(ctx: ReadContext, parts: MessageParts): Markers {
  const present = (names: readonly string[]): string[] =>
    names.filter((name) => lookupNamed(ctx, parts.named, name) !== undefined);
  return {
    stamps: present(REPLAY_STAMPS),
    republish: present(REPUBLISH_MARKERS),
  };
}

export interface TrustInput {
  readonly interpreted: boolean | null;
  readonly hasHistory: boolean;
  readonly clientPublished: boolean;
  readonly markers: Markers;
  readonly flags: ReadonlySet<HistoryFlag>;
}

export function assessTrust(input: TrustInput): DeathTrust {
  if (!input.hasHistory) {
    return { trusted: false, state: 'no-history', reasons: [] };
  }
  const evidence: TrustReason[] = [];
  if (input.clientPublished) evidence.push('client-published-hint');
  if (input.markers.stamps.length > 0) evidence.push('replay-stamp');
  if (input.markers.republish.length > 0) evidence.push('republish-marker');
  if (input.flags.has('first-death-header-missing')) {
    evidence.push('first-death-header-missing');
  }

  if (input.interpreted === null) {
    return {
      trusted: false,
      state: 'unknown-broker',
      reasons: ['broker-behaviour-unknown', ...evidence],
    };
  }
  if (
    input.flags.has('first-death-mismatch') ||
    input.flags.has('last-death-mismatch')
  ) {
    return {
      trusted: false,
      state: 'inconsistent',
      reasons: ['first-last-mismatch', ...evidence],
    };
  }
  if (input.interpreted) {
    return {
      trusted: true,
      state: 'interpreted',
      reasons: ['broker-interprets-client-value', ...evidence],
    };
  }
  if (evidence.length > 0) {
    return { trusted: false, state: 'client-supplied', reasons: evidence };
  }
  return {
    trusted: true,
    state: 'broker-shaped',
    reasons: ['provenance-unproven'],
  };
}
