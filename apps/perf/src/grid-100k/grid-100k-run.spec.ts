// The parts of the grid-100k browser run that need no browser: the judgement of AC-1, AC-4 and AC-16, the seeded
// plan, the page server and the page script (it must compile). The browser run is `grid-100k.perf.ts`.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';

import { afterEach, describe, expect, it } from 'vitest';

import { PAGE_SCRIPT } from './page-script';
import { nameAtRow, nextSort, planJumps, seeded, type Step } from './plan';
import { startPageServer, type PageServer } from './server';
import { ROWS, type PageState, type PolicyState } from './shared';
import {
  BUDGETS,
  COMPARABLE_BLOCKS,
  framesPerSecond,
  judgeMemory,
  judgePolicy,
  judgeScroll,
  literalRatio,
  longestFrameGap,
  nextStep,
  type MemoryData,
  type PolicyData,
  type ScrollData,
} from './verdict';

const state = (overrides: Partial<PageState> = {}): PageState => ({
  rows: ROWS,
  answerLatencyMs: 15,
  blockSize: 200,
  blockLimit: 25,
  blocks: 25,
  maxBlocks: 25,
  requests: 400,
  maxLimit: 200,
  maxInflight: 2,
  misaligned: 0,
  distinctBlocks: 40,
  domRows: 40,
  maxDomRows: 40,
  rowCount: ROWS,
  scrollTop: 240_000,
  rowHeight: 32,
  viewportHeight: 600,
  ...overrides,
});

/** 60 frames a second for six seconds. */
const steady = (fps = 60, seconds = 6): number[] =>
  Array.from(
    { length: Math.round(fps * seconds) + 1 },
    (_, i) => 100 + (i * 1000) / fps,
  );

const scroll = (overrides: Partial<ScrollData> = {}): ScrollData => ({
  stamps: steady(),
  longTasks: [],
  state: state(),
  distinctBlocksBefore: 1,
  scrollFrom: 0,
  scrollTo: 240_000,
  rowHeight: 32,
  minFrames: 60,
  ...overrides,
});

describe('M0-53 grid-100k harness (no browser): AC-1 judgement', () => {
  it('M0-53 harness (AC-1): a clean scroll passes', () => {
    expect(judgeScroll(scroll())).toEqual({ deterministic: [], timing: [] });
  });

  it('M0-53 harness (AC-1): frames per second are intervals over time, and the budget is 55', () => {
    expect(framesPerSecond(steady(60))).toBeCloseTo(60, 5);
    expect(framesPerSecond([])).toBe(0);
    expect(framesPerSecond([5])).toBe(0);
    expect(longestFrameGap([0, 16, 100, 116])).toBe(84);
    expect(judgeScroll(scroll({ stamps: steady(54) })).timing).toHaveLength(1);
    expect(judgeScroll(scroll({ stamps: steady(55.5) })).timing).toEqual([]);
    expect(BUDGETS.fps).toBe(55);
  });

  it('M0-53 harness (AC-1): a main-thread task above 50 ms is a timing failure, 50 ms is not', () => {
    expect(
      judgeScroll(scroll({ longTasks: [{ start: 1, duration: 51 }] })).timing,
    ).toHaveLength(1);
    expect(
      judgeScroll(scroll({ longTasks: [{ start: 1, duration: 50 }] })).timing,
    ).toEqual([]);
  });

  it('M0-53 harness (AC-1): a scroll that does not pass more than 25 blocks, or a dead recorder, is deterministic', () => {
    const few = judgeScroll(
      scroll({ state: state({ distinctBlocks: 26 }), distinctBlocksBefore: 1 }),
    );
    expect(few.deterministic).toHaveLength(1); // 25 blocks asked for, not more than 25
    expect(nextStep(few, 1, 3)).toBe('failed');
    expect(
      judgeScroll(scroll({ stamps: steady(60, 0.5), minFrames: 60 }))
        .deterministic,
    ).toHaveLength(1);
    expect(
      judgeScroll(scroll({ scrollTo: 100_000 })).deterministic, // 3,125 rows, under 25 x 200
    ).toHaveLength(1);
  });

  it('M0-53 harness (AC-1): a request over a block, or off a block boundary, is deterministic', () => {
    expect(
      judgeScroll(scroll({ state: state({ maxLimit: 201 }) })).deterministic,
    ).toHaveLength(1);
    expect(
      judgeScroll(scroll({ state: state({ misaligned: 1 }) })).deterministic,
    ).toHaveLength(1);
  });
});

const memory = (overrides: Partial<MemoryData> = {}): MemoryData => ({
  firstFiveBytes: 5_300_000,
  midBytes: 6_800_000,
  finalBytes: 6_900_000,
  blocksAtMid: 22,
  blocksAtFinal: 21,
  jumps: 300,
  planned: 300,
  state: state(),
  ...overrides,
});

describe('M0-53 grid-100k harness (no browser): AC-4 judgement', () => {
  it('M0-53 harness (AC-4): a flat heap passes', () => {
    expect(judgeMemory(memory())).toEqual({ deterministic: [], timing: [] });
  });

  it('M0-53 harness (AC-4): the heap is compared at a comparable cache, with 1.15 as the limit', () => {
    expect(
      judgeMemory(memory({ finalBytes: 6_800_000 * 1.16 })).timing,
    ).toHaveLength(1);
    expect(
      judgeMemory(memory({ finalBytes: 6_800_000 * 1.149 })).timing,
    ).toEqual([]);
    expect(BUDGETS.heapRatio).toBe(1.15);
    // The figure the spec first wrote is printed, and is not what is asserted (OQ in docs/open-questions.md).
    expect(literalRatio(memory())).toBeCloseTo(6_900_000 / 5_300_000, 6);
    expect(literalRatio(memory())).toBeGreaterThan(BUDGETS.heapRatio);
  });

  it('M0-53 harness (AC-4): a cache that was not comparable is not judged', () => {
    const verdict = judgeMemory(
      memory({ blocksAtFinal: COMPARABLE_BLOCKS - 1 }),
    );
    expect(verdict.deterministic).toHaveLength(1);
    expect(
      judgeMemory(memory({ blocksAtMid: COMPARABLE_BLOCKS - 1 })).deterministic,
    ).toHaveLength(1);
    expect(
      judgeMemory(memory({ blocksAtMid: COMPARABLE_BLOCKS })).deterministic,
    ).toEqual([]);
  });

  it('M0-53 harness (AC-4): more than 25 blocks resident, a long window, a misaligned request or a missing jump is deterministic', () => {
    for (const bad of [
      memory({ state: state({ maxBlocks: 26 }) }),
      memory({ state: state({ maxLimit: 201 }) }),
      memory({ state: state({ misaligned: 3 }) }),
      memory({ jumps: 299 }),
      memory({ state: state({ requests: 10 }) }),
      memory({ midBytes: 0 }),
    ]) {
      const verdict = judgeMemory(bad);
      expect(verdict.deterministic.length).toBeGreaterThan(0);
      expect(nextStep(verdict, 1, 3)).toBe('failed');
    }
  });

  it('M0-53 harness: a timing or memory miss is retried until the last attempt, a clean run is not', () => {
    const miss = judgeMemory(memory({ finalBytes: 99_000_000 }));
    expect(nextStep(miss, 1, 3)).toBe('retry');
    expect(nextStep(miss, 3, 3)).toBe('failed');
    expect(nextStep(judgeMemory(memory()), 1, 3)).toBe('passed');
  });
});

const policyState = (overrides: Partial<PolicyState> = {}): PolicyState => ({
  nonce: 'abc',
  styleElements: 19,
  noncedStyleElements: 19,
  gridRootStyleAttribute: null,
  theme: 'light',
  density: 'comfortable',
  gridBackground: 'rgb(255, 255, 255)',
  rowHeight: 32,
  menuOpen: false,
  ...overrides,
});

const POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self' 'nonce-abc'; require-trusted-types-for 'script'";

const policy = (overrides: Partial<PolicyData> = {}): PolicyData => ({
  policies: [POLICY],
  violations: [],
  before: policyState(),
  after: policyState({
    theme: 'dark',
    density: 'compact',
    gridBackground: 'rgb(20, 23, 28)',
    rowHeight: 24,
  }),
  menu: { items: 2, focusedIndex: 0 },
  menuClosedByEscape: true,
  scrolled: true,
  ...overrides,
});

describe('M0-53 grid-100k harness (no browser): AC-16 judgement', () => {
  it('M0-53 harness (AC-16): a clean run passes', () => {
    expect(judgePolicy(policy())).toEqual({ deterministic: [], timing: [] });
  });

  it('M0-53 harness (AC-16): any report is a deterministic failure and is never retried', () => {
    const verdict = judgePolicy(
      policy({ violations: ['log: Refused to apply'] }),
    );
    expect(verdict.deterministic).toHaveLength(1);
    expect(nextStep(verdict, 1, 3)).toBe('failed');
  });

  it('M0-53 harness (AC-16): the policy that was sent must hold the S-04 rules and no unsafe-eval', () => {
    expect(judgePolicy(policy({ policies: [] })).deterministic).toHaveLength(1);
    expect(
      judgePolicy(
        policy({
          policies: [POLICY.replace(" require-trusted-types-for 'script'", '')],
        }),
      ).deterministic,
    ).toHaveLength(1);
    expect(
      judgePolicy(
        policy({ policies: [POLICY + " ; script-src 'unsafe-eval'"] }),
      ).deterministic,
    ).toHaveLength(1);
  });

  it('M0-53 harness (AC-16): the nonce must be set and on every style element', () => {
    expect(
      judgePolicy(policy({ before: policyState({ nonce: '' }) })).deterministic,
    ).toHaveLength(1);
    expect(
      judgePolicy(
        policy({
          after: policyState({
            theme: 'dark',
            gridBackground: 'x',
            rowHeight: 24,
            noncedStyleElements: 18,
          }),
        }),
      ).deterministic,
    ).toHaveLength(1);
    expect(
      judgePolicy(
        policy({
          after: policyState({
            theme: 'dark',
            gridBackground: 'x',
            rowHeight: 24,
            styleElements: 0,
            noncedStyleElements: 0,
          }),
        }),
      ).deterministic,
    ).toHaveLength(1);
  });

  it('M0-53 harness (AC-16): the menu, the scroll, the theme, the density and an inline style attribute are each checked', () => {
    const failures = (data: Partial<PolicyData>): number =>
      judgePolicy(policy(data)).deterministic.length;
    expect(failures({ menu: null })).toBe(1);
    expect(failures({ menu: { items: 2, focusedIndex: 1 } })).toBe(1);
    expect(failures({ menuClosedByEscape: false })).toBe(1);
    expect(failures({ scrolled: false })).toBe(1);
    expect(failures({ after: policyState() })).toBe(3); // theme, background and row height did not change
    expect(
      failures({
        after: policyState({
          theme: 'dark',
          gridBackground: 'x',
          rowHeight: 24,
          gridRootStyleAttribute: '--ag-x: 1',
        }),
      }),
    ).toBe(1);
  });
});

describe('M0-53 grid-100k harness (no browser): the plan', () => {
  it('M0-53 harness (AC-4): the plan is seeded: the same seed gives the same jumps, another seed other ones', () => {
    const a = planJumps({
      jumps: 300,
      seed: 53,
      visibleRows: 20,
      sortEvery: 30,
    });
    const b = planJumps({
      jumps: 300,
      seed: 53,
      visibleRows: 20,
      sortEvery: 30,
    });
    const c = planJumps({
      jumps: 300,
      seed: 54,
      visibleRows: 20,
      sortEvery: 30,
    });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    const next = seeded(1);
    const values = Array.from({ length: 1000 }, () => next());
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
  });

  it('M0-53 harness (AC-4): 300 jumps over all rows, sorts mid-period, none in the last half period', () => {
    const plan = planJumps({
      jumps: 300,
      seed: 53,
      visibleRows: 20,
      sortEvery: 30,
    });
    const jumps = plan.filter(
      (s): s is Extract<Step, { kind: 'jump' }> => s.kind === 'jump',
    );
    const sorts = plan.filter((s) => s.kind === 'sort');
    expect(jumps).toHaveLength(300);
    expect(sorts).toHaveLength(10);
    for (const jump of jumps) {
      expect(jump.index).toBeGreaterThanOrEqual(0);
      expect(jump.index + 20).toBeLessThanOrEqual(ROWS + 1);
    }
    // "All 100k rows": the jumps cover the whole range, not one corner of it.
    expect(Math.min(...jumps.map((j) => j.index))).toBeLessThan(ROWS / 20);
    expect(Math.max(...jumps.map((j) => j.index))).toBeGreaterThan(
      (ROWS * 19) / 20,
    );
    // The last sort comes before jump 285: the last 16 jumps follow no sort, so the cache is full again.
    const afterLastSort = plan.slice(
      plan.map((s) => s.kind).lastIndexOf('sort') + 1,
    );
    expect(afterLastSort.filter((s) => s.kind === 'jump')).toHaveLength(16);
    expect(
      planJumps({ jumps: 10, seed: 1, visibleRows: 20, sortEvery: 0 }).every(
        (s) => s.kind === 'jump',
      ),
    ).toBe(true);
  });

  it('M0-53 harness (AC-4): the sort cycle is none, ascending, descending, none; names follow the direction', () => {
    expect(nextSort('none')).toBe('asc');
    expect(nextSort('asc')).toBe('desc');
    expect(nextSort('desc')).toBe('none');
    expect(nameAtRow(7, 'none')).toBe('queue-7');
    expect(nameAtRow(7, 'asc')).toBe('queue-7');
    expect(nameAtRow(7, 'desc')).toBe(`queue-${String(ROWS - 8)}`);
  });
});

describe('M0-53 grid-100k harness (no browser): the page server and the page script', () => {
  let server: PageServer | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('M0-53 harness (AC-16): every response carries the engine policy with a fresh nonce, which is also the page nonce', async () => {
    dir = mkdtempSync(join(tmpdir(), 'grid-100k-server-'));
    mkdirSync(join(dir, 'site'));
    writeFileSync(
      join(dir, 'site', 'index.html'),
      '<meta name="csp-nonce" content="__CSP_NONCE__"><app-root ngCspNonce="__CSP_NONCE__"></app-root>',
    );
    writeFileSync(join(dir, 'site', 'main.js'), 'export {};');
    writeFileSync(join(dir, 'secret.txt'), 'outside');
    server = await startPageServer(join(dir, 'site'));

    const first = await fetch(server.url);
    const html = await first.text();
    const header = first.headers.get('content-security-policy') ?? '';
    const nonce = /nonce-([^']+)'/.exec(header)?.[1] ?? '';
    expect(nonce.length).toBeGreaterThan(10);
    expect(html).toBe(
      `<meta name="csp-nonce" content="${nonce}"><app-root ngCspNonce="${nonce}"></app-root>`,
    );
    expect(header).toContain("require-trusted-types-for 'script'");
    expect(header).toContain("style-src 'self' 'nonce-");
    expect(header).not.toContain('unsafe-eval');

    const script = await fetch(new URL('main.js', server.url));
    expect(script.headers.get('content-security-policy')).toContain(
      "script-src 'self'",
    );
    expect(script.headers.get('content-type')).toContain('text/javascript');
    // A fresh nonce for every response.
    const second = await fetch(server.url);
    expect(second.headers.get('content-security-policy')).not.toBe(header);
    expect(server.policies).toHaveLength(3);

    expect(header).toContain("style-src-attr 'unsafe-inline'");
    // The strict variant drops that one rule and nothing else.
    const strict = await startPageServer(join(dir, 'site'), {
      strictStyleAttributes: true,
    });
    try {
      const strictHeader =
        (await fetch(strict.url)).headers.get('content-security-policy') ?? '';
      expect(strictHeader).not.toContain('style-src-attr');
      expect(strictHeader).toContain("style-src 'self' 'nonce-");
      expect(strictHeader).toContain("require-trusted-types-for 'script'");
    } finally {
      await strict.close();
    }

    expect((await fetch(new URL('missing.js', server.url))).status).toBe(404);
    expect(
      (await fetch(new URL('..%2Fsecret.txt', server.url))).status,
    ).toBeGreaterThanOrEqual(403);
  });

  it('M0-53 harness (AC-1): the page script is valid JavaScript and offers what the driver calls', () => {
    expect(() => new Script(PAGE_SCRIPT)).not.toThrow();
    for (const name of [
      'startFrames',
      'stopFrames',
      'jump',
      'waitFor',
      'geometry',
      'centre',
      'menu',
      'busy',
      'provokeViolation',
      'longTasksSince',
    ]) {
      expect(PAGE_SCRIPT).toContain(`perf.${name} =`);
    }
  });
});
