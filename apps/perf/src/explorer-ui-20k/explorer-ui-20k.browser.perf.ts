// perf:explorer-ui-20k-browser (M0-54 slice K, AC-27): what the explorer's interactions cost in a REAL browser.
// The production web build is served by the real engine bundle under the real Content-Security-Policy (the way
// `web-csp-check` does it); a real Chromium opens the queue page at 1280x720; a fake data port of 20,000 queues
// answers `inventory.query` over the DevTools `Fetch` domain (see harness.ts). A fixed sequence of scroll jumps,
// text filters, facet changes and sorts runs, each timed from the input to the end of the frame whose DOM holds
// the new rows, checked by content against an oracle (see plan.ts and page-script.ts). The filter's 200 ms pause
// is excluded by construction (Enter applies the filter at once).
//
// WHAT THIS DOES NOT MEASURE: a real broker, the real engine's `svc-explorer` (the engine bundle registers no
// explorer module yet, OQ-441), a network (the answer comes from the harness over the DevTools protocol), the
// live `explorer.window` topic (the engine ends that subscription: the connection does not exist), a GPU or a
// physical display (headless, software compositing, one machine). The figure is that machine's, not a budget
// proved for users' hardware; the run says which machine and browser it measured on.
//
// `pnpm nx run perf:explorer-ui-20k-browser`. Without a Chromium-family browser the test is SKIPPED, loudly, and
// proves nothing; set PERF_REQUIRE_BROWSER (CI does) to make a missing browser a failure instead.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BROWSER_ENV, findBrowser, launchBrowser, type Browser } from './cdp';
import { ExplorerPage, startEngine, VIEWPORT } from './harness';
import {
  createPageData,
  planInteractions,
  SORT_COLUMNS_DEFAULT,
  type Step,
} from './plan';
import {
  BUDGETS,
  judge,
  nextStep,
  summarise,
  type AttemptData,
  type Verdict,
} from './verdict';

const root = resolve(import.meta.dirname, '../../../..');

// Vitest 5 hides the console output of a passing test, and these figures are the point of the run.
const report = (line: string): void => {
  process.stdout.write(line + '\n');
};

/** Timed interactions per attempt, after the warm-up (a fixed sequence, so figures compare run to run). */
const INTERACTIONS = Number(
  process.env.PERF_EXPLORER_UI_BROWSER_INTERACTIONS ?? 500,
);
/** Steps run first and not counted: chunks, JIT and the grid's first render are warm afterwards. */
const WARMUP = 12;
/** A timing failure may repeat the run this many times in all (see verdict.ts); other failures never do. */
const MAX_ATTEMPTS = Number(process.env.PERF_EXPLORER_UI_BROWSER_ATTEMPTS ?? 3);
/** Nothing in flight and nothing asked for this long: the previous interaction has settled. */
const SETTLE_MS = 100;
const SEED = 54;

const rounded = (value: number): number => Number(value.toFixed(1));

interface AttemptReport {
  readonly data: AttemptData;
  readonly verdict: Verdict;
  readonly line: Record<string, unknown>;
  readonly screenshot: Buffer;
}

describe('explorer ui browser perf', () => {
  it('M0-54 AC-27 explorer ui 20k: p95 interaction under 300 ms in a browser', async (ctx) => {
    const executable = findBrowser();
    if (executable === undefined) {
      const message = `AC-27 SKIPPED: no Chromium-family browser binary found (looked at ${BROWSER_ENV.join(', ')}, then Chrome and Edge in their default locations). NOTHING WAS PROVED and no browser figure exists. Install Chrome or Edge, or set PERF_BROWSER to its path.`;
      process.stderr.write(message + '\n');
      if (process.env.PERF_REQUIRE_BROWSER !== undefined) {
        throw new Error(
          message + ' PERF_REQUIRE_BROWSER is set, so this is a failure.',
        );
      }
      ctx.skip(message);
      return;
    }
    for (const built of [
      join(root, 'dist', 'apps', 'engine', 'main.mjs'),
      join(root, 'dist', 'apps', 'web', 'browser', 'index.html'),
    ]) {
      if (!existsSync(built)) {
        throw new Error(
          `${built} does not exist: run \`pnpm nx run perf:explorer-ui-20k-browser\` (it builds web and engine first)`,
        );
      }
    }

    const engine = await startEngine(root);
    let browser: Browser;
    try {
      browser = await launchBrowser(executable);
    } catch (error) {
      await engine.stop();
      throw error;
    }
    const machine = {
      os: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model.trim() ?? 'unknown',
      logicalCpus: cpus().length,
      memoryGb: rounded(totalmem() / 1024 ** 3),
      browser: browser.product,
      viewport: `${String(VIEWPORT.width)}x${String(VIEWPORT.height)}`,
      mode: 'headless=new, software compositing (--disable-gpu), one machine',
    };
    report(`[perf] explorer-ui-20k-browser machine ${JSON.stringify(machine)}`);

    let plan: Step[] | undefined;
    let planKey = '';

    const attempt = async (n: number): Promise<AttemptReport> => {
      const data = createPageData();
      // Fill the sort cache so no measured answer pays for sorting 20,000 rows for the first time.
      for (const column of SORT_COLUMNS_DEFAULT) {
        for (const dir of ['asc', 'desc'] as const) {
          await data.query(
            {
              cid: 'perf',
              kind: 'queues',
              sort: { column, dir },
              window: { offset: 0, limit: 1 },
            } as Parameters<typeof data.query>[0],
            new AbortController().signal,
          );
        }
      }
      const page = await ExplorerPage.open(browser, engine.url, data);
      try {
        const ready = await page.ready();
        const sortColumns = SORT_COLUMNS_DEFAULT.filter((column) =>
          ready.columns.includes(column),
        );
        if (sortColumns.length < 2) {
          throw new Error(
            `fewer than two sortable columns are on screen at ${machine.viewport} (${ready.columns.join(', ')})`,
          );
        }
        const dead = await page.detectorsAreAlive();
        if (dead.length > 0) throw new Error(dead.join('; '));
        const visibleRows = Math.max(
          1,
          Math.floor(ready.viewportHeight / ready.rowHeight) - 1,
        );
        const key = `${sortColumns.join(',')}|${String(visibleRows)}|${String(INTERACTIONS)}`;
        if (plan === undefined || key !== planKey) {
          plan = await planInteractions({
            steps: WARMUP + INTERACTIONS,
            seed: SEED,
            visibleRows,
            tailRows: Math.ceil(ready.viewportHeight / ready.rowHeight) + 1,
            sortColumns,
          });
          planKey = key;
        }
        report(
          `[perf] explorer-ui-20k-browser attempt ${String(n)}: grid row ${String(ready.rowHeight)} px, viewport ${String(ready.viewportHeight)} px, ${String(visibleRows)} rows checked per step, sort columns ${sortColumns.join(',')}`,
        );
        let at = 0;
        const attempted = async (
          step: Step,
        ): Promise<ReturnType<typeof page.run>> => {
          const before = JSON.stringify(await page.call('describe()'));
          try {
            return await page.run(step, ready);
          } catch (error) {
            const recent = page.requests.slice(-4).map((r) => r.body);
            recent.push(
              JSON.stringify(await page.call('debug()').catch(() => null)),
            );
            throw new Error(
              `step ${String(at)} ${JSON.stringify({ ...step, expect: undefined })} failed from ${before}; the last requests were ${recent.join(' | ')}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        };
        for (const step of plan.slice(0, WARMUP)) {
          await attempted(step);
          at++;
          await page.quiet(SETTLE_MS);
        }
        const measureFrom = await page.call<number>('now()');
        const requestsBefore = page.requests.length;
        const measured = plan.slice(WARMUP);
        const samples: AttemptData['samples'][number][] = [];
        const frames: number[] = [];
        for (const step of measured) {
          const timing = await attempted(step);
          at++;
          samples.push({ kind: timing.kind, ms: timing.ms });
          frames.push(timing.frames);
          await page.quiet(SETTLE_MS);
        }
        const seen = await page.report(measureFrom);
        const screenshot = await page.screenshot();
        const requests = page.requests.slice(requestsBefore);
        const violations = [
          ...new Set([...page.violations, ...seen.pageViolations]),
        ];
        const data2: AttemptData = {
          samples,
          requests: requests.map((r) => r.request),
          longTasks: seen.longTasks,
          violations,
          planned: measured.length,
          requestingSteps: measured.filter((step) => step.kind !== 'scroll')
            .length,
        };
        const verdict = judge(data2);
        const all = summarise(samples.map((s) => s.ms));
        const byKind: Record<string, unknown> = {};
        for (const kind of ['scroll', 'text-filter', 'facet', 'sort']) {
          const part = summarise(
            samples.filter((s) => s.kind === kind).map((s) => s.ms),
          );
          byKind[kind] = {
            n: part.count,
            p50: rounded(part.p50),
            p95: rounded(part.p95),
            max: rounded(part.max),
          };
        }
        const answer = summarise(requests.map((r) => r.answerMs));
        const roundTrip = summarise(requests.map((r) => r.roundTripMs));
        const line = {
          attempt: n,
          interactions: samples.length,
          p50Ms: rounded(all.p50),
          p95Ms: rounded(all.p95),
          maxMs: rounded(all.max),
          byKind,
          framesToPaintP95: summarise(frames).p95,
          requests: requests.length,
          requestLimitMax: Math.max(0, ...requests.map((r) => r.request.limit)),
          dataPortAnswerMsP95: rounded(answer.p95),
          interceptionRoundTripMsP95: rounded(roundTrip.p95),
          longTasks: seen.longTasks.map((t) => ({
            start: rounded(t.start),
            durationMs: rounded(t.duration),
          })),
          cspOrTrustedTypesReports: violations.length,
          otherConsole: [...new Set(page.otherConsole)].slice(0, 5),
        };
        return { data: data2, verdict, line, screenshot };
      } finally {
        await page.close();
      }
    };

    try {
      const reports: AttemptReport[] = [];
      let last: AttemptReport | undefined;
      for (let n = 1; n <= MAX_ATTEMPTS; n++) {
        last = await attempt(n);
        reports.push(last);
        report(
          `[perf] explorer-ui-20k-browser (browser, fake data port, headless, one machine) ${JSON.stringify(last.line)}`,
        );
        const outcome = nextStep(last.verdict, n, MAX_ATTEMPTS);
        if (outcome !== 'retry') break;
        report(
          `[perf] explorer-ui-20k-browser attempt ${String(n)} missed a timing budget (${last.verdict.timing.join('; ')}); trying again`,
        );
      }
      if (last === undefined) throw new Error('no attempt ran');
      const dir = join(root, 'dist', 'perf');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'explorer-ui-20k-browser.png'), last.screenshot);
      report(
        `[perf] explorer-ui-20k-browser verdict: ${String(reports.length)} attempt(s) of at most ${String(MAX_ATTEMPTS)}; budgets p95 < ${String(BUDGETS.interactionP95Ms)} ms, block <= ${String(BUDGETS.blockLimit)}, no long task above ${String(BUDGETS.longTaskMs)} ms, zero CSP/Trusted Types reports`,
      );
      expect([...last.verdict.deterministic, ...last.verdict.timing]).toEqual(
        [],
      );
    } finally {
      await browser.close();
      await engine.stop();
    }
  }, 1_800_000);
});
