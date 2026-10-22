import { PARTIAL_REASONS } from '@app/contracts';
import { describe, expect, it } from 'vitest';

import { explainStatus, KNOWN_PARTIAL_REASONS } from './explain';
import type { MetricsStatus } from './ports';
import { quietStatus } from './testing';

const codes = (status: MetricsStatus | null): string[] =>
  explainStatus(status).map((e) => e.code);

describe('M1-54 status explanations', () => {
  it('AC-10 every engine status becomes a stated reason and an unknown one is not fine', () => {
    // Nothing known and a healthy status explain nothing.
    expect(explainStatus(null)).toEqual([]);
    expect(explainStatus(quietStatus())).toEqual([]);

    // Statistics off and no Prometheus: the source is none, which is a problem, not a quiet chart.
    expect(
      explainStatus(
        quietStatus({ state: 'unavailable', source: 'none', asOf: undefined }),
      ),
    ).toEqual([
      { code: 'unavailable', severity: 'problem' },
      { code: 'no-source', severity: 'problem' },
    ]);
    // Before the first round: loading only (the source is not known yet).
    expect(codes(quietStatus({ state: 'loading', source: 'none' }))).toEqual([
      'loading',
    ]);
    expect(explainStatus(quietStatus({ state: 'stale', asOf: 42 }))).toEqual([
      { code: 'stale', severity: 'warning', asOf: 42 },
    ]);
    expect(
      explainStatus(quietStatus({ state: 'stale', asOf: undefined }))[0],
    ).toEqual({
      code: 'stale',
      severity: 'warning',
    });

    // The fallbacks and the approximation.
    expect(
      explainStatus(
        quietStatus({
          source: 'management',
          fallbackReason: 'no-endpoint',
          approximate: true,
        }),
      ),
    ).toEqual([
      { code: 'fallback-no-endpoint', severity: 'info' },
      { code: 'approximate', severity: 'info' },
    ]);
    expect(
      codes(quietStatus({ source: 'management', fallbackReason: 'failing' })),
    ).toEqual(['fallback-failing']);

    // Each partial reason of the contract, in the engine's words, and what was dropped, counted.
    for (const reason of PARTIAL_REASONS) {
      expect(explainStatus(quietStatus({ partial: [reason] }))).toEqual([
        { code: 'partial', severity: 'warning', reason },
      ]);
      expect(KNOWN_PARTIAL_REASONS).toContain(reason);
    }
    expect(
      explainStatus(
        quietStatus({ dropped: { points: 3, series: 2, samples: 1 } }),
      ),
    ).toEqual([
      { code: 'dropped-points', severity: 'warning', count: 3 },
      { code: 'dropped-series', severity: 'warning', count: 2 },
      { code: 'dropped-samples', severity: 'warning', count: 1 },
    ]);

    // A state, a source or a fallback reason this version does not know is a doubt, never silence.
    const future = (patch: Record<string, unknown>): MetricsStatus => ({
      ...quietStatus(),
      ...patch,
    });
    expect(codes(future({ state: 'degraded' }))).toEqual(['unknown-state']);
    expect(codes(future({ source: 'otlp' }))).toEqual(['unknown-state']);
    expect(codes(future({ fallbackReason: 'quota' }))).toEqual([
      'unknown-state',
    ]);
    // An unknown partial reason is still listed, with the engine's word.
    expect(explainStatus(future({ partial: ['new-reason'] }))).toEqual([
      { code: 'partial', severity: 'warning', reason: 'new-reason' },
    ]);
    expect(KNOWN_PARTIAL_REASONS).not.toContain('new-reason');
  });
});
