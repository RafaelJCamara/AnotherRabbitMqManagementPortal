// The parts of the AC-27 browser run that need no browser: the judgement, the interaction plan, the browser search
// and the page script (it must compile). The browser run itself is `explorer-ui-20k.browser.perf.ts`.
import { Script } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { findBrowser } from './cdp';
import { PAGE_SCRIPT } from './page-script';
import { planInteractions, signature, type Step } from './plan';
import {
  BUDGETS,
  judge,
  nextStep,
  percentile,
  type AttemptData,
} from './verdict';

const clean = (overrides: Partial<AttemptData> = {}): AttemptData => ({
  samples: Array.from({ length: 100 }, () => ({ kind: 'sort', ms: 40 })),
  requests: Array.from({ length: 80 }, () => ({ offset: 0, limit: 200 })),
  longTasks: [],
  violations: [],
  planned: 100,
  requestingSteps: 80,
  ...overrides,
});

describe('AC-27 harness (no browser): the judgement', () => {
  it('M0-54 harness (AC-27): a clean run passes', () => {
    expect(judge(clean())).toEqual({ deterministic: [], timing: [] });
  });

  it('M0-54 harness (AC-27): a p95 at the budget fails, one under it passes', () => {
    const slow = (ms: number, count: number): AttemptData =>
      clean({
        samples: [
          ...Array.from({ length: 100 - count }, () => ({
            kind: 'sort',
            ms: 10,
          })),
          ...Array.from({ length: count }, () => ({ kind: 'sort', ms })),
        ],
      });
    // 6 of 100 at the budget put the p95 on it: the budget is "under", so it fails.
    expect(judge(slow(BUDGETS.interactionP95Ms, 6)).timing).toHaveLength(1);
    // 5 of 100 are the top 5 %: the p95 is the 95th value, still fast.
    expect(judge(slow(5_000, 5)).timing).toEqual([]);
    expect(judge(slow(BUDGETS.interactionP95Ms - 1, 6)).timing).toEqual([]);
  });

  it('M0-54 harness (AC-27): any long task above 50 ms is a timing failure', () => {
    expect(
      judge(clean({ longTasks: [{ start: 1, duration: 51 }] })).timing,
    ).toHaveLength(1);
    expect(
      judge(clean({ longTasks: [{ start: 1, duration: 50 }] })).timing,
    ).toEqual([]);
  });

  it('M0-54 harness (AC-27): a CSP or Trusted Types report is deterministic and never retried', () => {
    const verdict = judge(clean({ violations: ['console: Refused to apply'] }));
    expect(verdict.deterministic).toHaveLength(1);
    expect(nextStep(verdict, 1, 3)).toBe('failed');
  });

  it('M0-54 harness (AC-27): a request over a block is deterministic', () => {
    const requests = [
      ...clean().requests,
      { offset: 0, limit: BUDGETS.blockLimit + 1 },
    ];
    expect(
      judge(clean({ requests, requestingSteps: 80 })).deterministic,
    ).toHaveLength(1);
    expect(
      judge(
        clean({
          requests: [{ offset: 0, limit: BUDGETS.blockLimit }],
          requestingSteps: 1,
          samples: [{ kind: 'sort', ms: 1 }],
          planned: 1,
        }),
      ).deterministic,
    ).toEqual([]);
  });

  it('M0-54 harness (AC-27): fewer timed interactions than planned, or fewer requests than needing steps, fails', () => {
    expect(judge(clean({ planned: 101 })).deterministic).toHaveLength(1);
    expect(
      judge(clean({ requests: [], requestingSteps: 80 })).deterministic,
    ).toHaveLength(1);
  });

  it('M0-54 harness (AC-27): only timing failures are retried, and only while attempts remain', () => {
    const timing = judge(clean({ longTasks: [{ start: 0, duration: 99 }] }));
    expect(nextStep(timing, 1, 3)).toBe('retry');
    expect(nextStep(timing, 2, 3)).toBe('retry');
    expect(nextStep(timing, 3, 3)).toBe('failed');
    expect(nextStep(judge(clean()), 1, 3)).toBe('passed');
  });

  it('M0-54 harness (AC-27): the percentile is the nearest rank', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 0.95)).toBe(95);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([], 0.95)).toBe(0);
  });
});

describe('AC-27 harness (no browser): the interaction plan', () => {
  const options = {
    steps: 120,
    seed: 54,
    visibleRows: 8,
    tailRows: 11,
    sortColumns: ['name', 'vhost', 'type', 'state'],
  } as const;

  it('M0-54 harness (AC-27): the plan is the same on every run and uses every kind of interaction', async () => {
    const first = await planInteractions(options);
    const second = await planInteractions(options);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(new Set(first.map((step) => step.kind))).toEqual(
      new Set(['scroll', 'text-filter', 'facet', 'sort']),
    );
    const other = await planInteractions({ ...options, seed: 55 });
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(first));
  });

  it('M0-54 harness (AC-27): every expectation is a window of real rows of the oracle', async () => {
    const plan = await planInteractions(options);
    for (const step of plan) {
      const { rows, scrolledRows, matched } = step.expect;
      expect(rows.length).toBeLessThanOrEqual(options.visibleRows);
      if (matched === 0) {
        expect(rows).toEqual([]);
      } else {
        expect(rows.length).toBe(Math.min(options.visibleRows, matched));
        rows.forEach((row, offset) => {
          expect(row.index).toBe(scrolledRows + offset);
          expect(row.name).toMatch(/^queue-\d{5}$/);
        });
      }
      // Anything but a scroll lands at the top of the list.
      if (step.kind !== 'scroll') expect(scrolledRows).toBe(0);
      if (step.kind === 'scroll') {
        expect(step.index).toBe(scrolledRows);
        expect(step.index + options.tailRows).toBeLessThanOrEqual(matched);
      }
    }
  });

  it('M0-54 harness (AC-27): a text filter step shows only rows whose name holds the text', async () => {
    const plan = await planInteractions({ ...options, steps: 200 });
    const texts = plan.filter(
      (step): step is Extract<Step, { kind: 'text-filter' }> =>
        step.kind === 'text-filter',
    );
    expect(texts.length).toBeGreaterThan(10);
    for (const step of texts) {
      for (const row of step.expect.rows) {
        expect(row.name.toLowerCase()).toContain(step.text.toLowerCase());
      }
    }
  });

  it('M0-54 harness (AC-27): no step repeats the screen the one before left, so none times nothing', async () => {
    const plan = await planInteractions({ ...options, steps: 200 });
    let previous = '';
    for (const step of plan) {
      const now = signature(step.expect);
      if (step.kind === 'scroll' || step.kind === 'sort') {
        expect(now).not.toBe(previous);
      }
      previous = now;
    }
  });

  it('M0-54 harness (AC-27): a sort click cycles ascending, descending, none on one column', async () => {
    const plan = await planInteractions({
      ...options,
      steps: 400,
      sortColumns: ['name'],
    });
    const marks = plan
      .filter((step) => step.kind === 'sort')
      .map((step) => step.expect.sort?.aria);
    expect(marks.length).toBeGreaterThan(30);
    const next: Record<string, string> = {
      none: 'ascending',
      ascending: 'descending',
      descending: 'none',
    };
    let before = 'none';
    for (const mark of marks) {
      expect(mark).toBe(next[before]);
      before = mark ?? 'none';
    }
  });
});

describe('AC-27 harness (no browser): the page script and the browser search', () => {
  it('M0-54 harness (AC-27): the page script compiles', () => {
    expect(() => new Script(PAGE_SCRIPT)).not.toThrow();
  });

  it('M0-54 harness (AC-27): a variable that names a missing browser is no browser, not a fall-through', () => {
    const exists = (path: string): boolean => path === '/real/chrome';
    expect(findBrowser({ PERF_BROWSER: '/missing' }, 'linux', exists)).toBe(
      undefined,
    );
    expect(findBrowser({ PERF_BROWSER: '/real/chrome' }, 'linux', exists)).toBe(
      '/real/chrome',
    );
    expect(findBrowser({}, 'linux', () => false)).toBe(undefined);
  });

  it('M0-54 harness (AC-27): Chrome is looked for before Edge, and on PATH on Linux', () => {
    const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const edge =
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    expect(findBrowser({}, 'win32', (p) => p === chrome || p === edge)).toBe(
      chrome,
    );
    expect(findBrowser({}, 'win32', (p) => p === edge)).toBe(edge);
    expect(
      findBrowser({ PATH: '/usr/bin' }, 'linux', (p) =>
        p.endsWith('google-chrome'),
      ),
    ).toMatch(/google-chrome$/);
  });
});
