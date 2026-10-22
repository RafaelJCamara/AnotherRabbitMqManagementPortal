// What the engine's status says about a gap or a doubt, as codes the page words (M1-54, R4, I-13). The engine sends
// fixed words, never broker text; every value this version does not know becomes `unknown-state`, which is shown
// as a doubt and never read as "fine". A healthy `live` status with nothing partial explains nothing.
import { PARTIAL_REASONS } from '@app/contracts';

import type { MetricsStatus } from './ports';

export type ExplanationCode =
  /** Neither Prometheus nor management statistics can be read: there is nothing to chart. */
  | 'no-source'
  | 'loading'
  /** The newest point is older than three intervals (`asOf`). */
  | 'stale'
  | 'unavailable'
  | 'fallback-no-endpoint'
  | 'fallback-failing'
  /** The values come from management sampling. */
  | 'approximate'
  /** One of the engine's `partial` reasons (`reason`). */
  | 'partial'
  | 'dropped-points'
  | 'dropped-series'
  | 'dropped-samples'
  /** A state, source or reason this version does not know. */
  | 'unknown-state';

export interface Explanation {
  readonly code: ExplanationCode;
  /** `problem`: nothing can be shown; `warning`: shown, but not the whole picture; `info`: a caveat. */
  readonly severity: 'problem' | 'warning' | 'info';
  /** For `partial`: the engine's reason; for the rest, absent. */
  readonly reason?: string;
  readonly count?: number;
  readonly asOf?: number;
}

const KNOWN_STATES = ['live', 'stale', 'loading', 'unavailable'] as const;
const KNOWN_SOURCES = ['prometheus', 'management', 'none'] as const;

/** The partial reasons this version words; any other is still listed, under the generic text. */
export const KNOWN_PARTIAL_REASONS: readonly string[] = PARTIAL_REASONS;

export function explainStatus(status: MetricsStatus | null): Explanation[] {
  if (status === null) return [];
  const out: Explanation[] = [];
  const state: string = status.state;
  const source: string = status.source;
  if (!KNOWN_STATES.some((known) => known === state)) {
    out.push({ code: 'unknown-state', severity: 'warning' });
  } else if (state === 'loading') {
    out.push({ code: 'loading', severity: 'info' });
  } else if (state === 'stale') {
    out.push({
      code: 'stale',
      severity: 'warning',
      ...(status.asOf === undefined ? {} : { asOf: status.asOf }),
    });
  } else if (state === 'unavailable') {
    out.push({ code: 'unavailable', severity: 'problem' });
  }
  if (!KNOWN_SOURCES.some((known) => known === source)) {
    out.push({ code: 'unknown-state', severity: 'warning' });
  } else if (source === 'none' && state !== 'loading') {
    out.push({ code: 'no-source', severity: 'problem' });
  }
  if (status.fallbackReason !== undefined) {
    const reason: string = status.fallbackReason;
    out.push(
      reason === 'no-endpoint'
        ? { code: 'fallback-no-endpoint', severity: 'info' }
        : reason === 'failing'
          ? { code: 'fallback-failing', severity: 'warning' }
          : { code: 'unknown-state', severity: 'warning' },
    );
  }
  if (status.approximate) out.push({ code: 'approximate', severity: 'info' });
  for (const reason of status.partial) {
    out.push({ code: 'partial', severity: 'warning', reason });
  }
  const { points, series, samples } = status.dropped;
  if (points > 0) {
    out.push({ code: 'dropped-points', severity: 'warning', count: points });
  }
  if (series > 0) {
    out.push({ code: 'dropped-series', severity: 'warning', count: series });
  }
  if (samples > 0) {
    out.push({ code: 'dropped-samples', severity: 'warning', count: samples });
  }
  return out;
}
