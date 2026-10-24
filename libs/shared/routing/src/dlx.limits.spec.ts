import { describe, expect, it } from 'vitest';

import { findDlxLoops } from './cycles.ts';
import { deadLetterPath } from './dlx.ts';
import {
  bind,
  bindX,
  exchange,
  expiring,
  queue,
  topologyOf,
} from './testing.ts';
import type { TopologyBinding, TopologyQueue } from './types.ts';

const names = (prefix: string, count: number): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix}${String(i)}`);

describe('dead-letter limits', () => {
  it('M1-03 AC-10 dlx the step limit cuts a long chain, counts it and says the answer is not exact', () => {
    const queues: TopologyQueue[] = [];
    const bindings: TopologyBinding[] = [];
    for (let i = 0; i < 6; i += 1) {
      queues.push(expiring(`q${String(i)}`, `x${String(i)}`));
      bindings.push(bind(`x${String(i)}`, `q${String(i + 1)}`, ''));
    }
    queues.push(queue('q6'));
    const t = topologyOf(
      names('x', 6).map((n) => exchange(n, 'fanout')),
      queues,
      bindings,
    );
    const full = deadLetterPath(t, 'q0');
    expect(full.reached).toEqual(['q1', 'q2', 'q3', 'q4', 'q5', 'q6']);
    expect(full.exact).toBe(true);
    expect(full.truncation.steps).toBe(0);

    const cut = deadLetterPath(t, 'q0', { limits: { maxDlxSteps: 2 } });
    expect(cut.truncation.steps).toBeGreaterThan(0);
    expect(cut.exact).toBe(false);
    expect(cut.paths.some((p) => p.end.kind === 'truncated')).toBe(true);
    expect(cut.reached).toEqual(['q1', 'q2']);
  });

  it('M1-03 AC-10 dlx the path limit keeps the first paths and counts the rest', () => {
    const targets = names('t', 5);
    const t = topologyOf(
      [exchange('x', 'fanout')],
      [expiring('src', 'x'), ...targets.map((n) => queue(n))],
      targets.map((n) => bind('x', n)),
    );
    const result = deadLetterPath(t, 'src', { limits: { maxDlxPaths: 2 } });
    expect(result.paths).toHaveLength(2);
    expect(result.truncation.paths).toBe(3);
    expect(result.exact).toBe(false);
    expect(result.reached).toEqual(targets);
  });

  it('M1-03 AC-10 dlx the loop limit keeps the first loops and counts the rest', () => {
    const loops = names('s', 3);
    const t = topologyOf(
      loops.map((n) => exchange(`x-${n}`)),
      loops.map((n) => expiring(n, `x-${n}`, n)),
      loops.map((n) => bind(`x-${n}`, n, n)),
    );
    const result = findDlxLoops(t, { maxDlxLoops: 1 });
    expect(result.loops.map((l) => l.queues)).toEqual([['s0']]);
    expect(result.truncation.loops).toBe(2);
    expect(findDlxLoops(t).truncation.loops).toBe(0);
  });

  it('M1-03 AC-10 dlx the candidate limit of a hash exchange is counted', () => {
    const targets = names('t', 5);
    const t = topologyOf(
      [exchange('h', 'x-consistent-hash')],
      [expiring('src', 'h', 'k'), ...targets.map((n) => queue(n))],
      targets.map((n) => bind('h', n, '1')),
    );
    const result = deadLetterPath(t, 'src', {
      limits: { maxDlxCandidates: 2 },
    });
    expect(result.reached).toEqual(['t0', 't1']);
    expect(result.truncation.candidates).toBe(3);
    expect(result.exact).toBe(false);
  });

  it('M1-03 AC-10 dlx the binding scan limit of an open-key walk is counted', () => {
    const targets = names('t', 5);
    const t = topologyOf(
      [exchange('x')],
      [expiring('src', 'x'), ...targets.map((n) => queue(n))],
      targets.map((n, i) => bind('x', n, `k${String(i)}`)),
    );
    const result = deadLetterPath(t, 'src', {
      limits: { maxBindingsScanned: 2 },
    });
    expect(result.truncation.steps).toBeGreaterThan(0);
    expect(result.reached).toEqual(['t0', 't1']);
    expect(result.exact).toBe(false);
  });

  it('M1-03 AC-10 dlx the exchange limit of an open-key walk is counted', () => {
    const t = topologyOf(
      [exchange('x1'), exchange('x2'), exchange('x3')],
      [expiring('src', 'x1'), queue('end')],
      [bindX('x1', 'x2', 'k'), bindX('x2', 'x3', 'k'), bind('x3', 'end', 'k')],
    );
    const result = deadLetterPath(t, 'src', { limits: { maxExchanges: 2 } });
    expect(result.truncation.steps).toBeGreaterThan(0);
    expect(result.reached).toEqual([]);
    expect(result.exact).toBe(false);
  });

  it('M1-03 AC-10 dlx with the default limits 5,000 queues feeding one sink are scanned and nothing is cut', () => {
    const sources = names('s', 5000);
    const t = topologyOf(
      [exchange('sink', 'fanout')],
      [...sources.map((n) => expiring(n, 'sink')), queue('end')],
      [bind('sink', 'end')],
    );
    const started = Date.now();
    const result = findDlxLoops(t);
    expect(result.loops).toEqual([]);
    expect(result.truncation).toEqual({
      sources: 0,
      steps: 0,
      paths: 0,
      loops: 0,
      candidates: 0,
    });
    // Counts are asserted, time is only printed (a loaded runner is not a defect).
    console.info(
      `M1-03 dlx 5,000 sources scanned in ${String(Date.now() - started)} ms`,
    );
  });
});
