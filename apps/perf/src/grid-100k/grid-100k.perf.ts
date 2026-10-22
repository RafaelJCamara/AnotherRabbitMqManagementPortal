// perf:grid-100k (M0-53 AC-1, AC-4, AC-16; spike S-14): the real `<app-data-grid>` in a REAL Chromium at 1280x720,
// reading 100,000 rows through the engine-windowed infinite row model (block 200, at most 25 blocks resident) from
// a fake engine window (`createFakeWindowSource`, 15 ms an answer). The harness page is a bare Angular app built by
// the `grid-100k-page` target and served by a small static server that sends the engine's own Content-Security-
// Policy (spike S-04: Trusted Types enforced, `style-src` with a nonce, no `unsafe-eval`) with a fresh nonce.
//
//   AC-1   wheel input scrolls more than 25 blocks' worth of rows; frames per second and main-thread tasks.
//   AC-4   300 seeded random jumps (and sort clicks) over all 100k rows; blocks, DOM rows and the JS heap after a
//          forced collection, against the heap after the first five windows.
//   AC-16  mount, scroll, open the menu, change theme and density under the enforced policy: zero reports.
//
// WHAT THIS DOES NOT MEASURE: a real engine (the window is a function in the page, no network and no JSON), a GPU or
// a physical display (headless, software compositing, one machine), a user's hardware. The figures are that
// machine's and are printed with it. "Frames" are `requestAnimationFrame` callbacks, not light on a screen.
//
// `pnpm nx run perf:grid-100k`. Without a Chromium-family browser the tests are SKIPPED, loudly, and prove nothing;
// set PERF_REQUIRE_BROWSER (CI does) to make a missing browser a failure instead.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it, type TestContext } from 'vitest';

import {
  BROWSER_ENV,
  findBrowser,
  launchBrowser,
  sleep,
  type Browser,
} from '../explorer-ui-20k/cdp';

import { GridPage, type Geometry } from './page';
import { nameAtRow, planJumps, type SortDirection } from './plan';
import {
  startPageServer,
  type PageServer,
  type PageServerOptions,
} from './server';
import { ANSWER_LATENCY_MS, ROWS, VIEWPORT } from './shared';
import {
  BUDGETS,
  framesPerSecond,
  judgeMemory,
  judgePolicy,
  judgeScroll,
  literalRatio,
  longestFrameGap,
  nextStep,
  type Verdict,
} from './verdict';

const root = resolve(import.meta.dirname, '../../../..');
const pageDir = join(root, 'dist', 'apps', 'perf-grid-page', 'browser');

// Vitest 5 hides the console output of a passing test, and these figures are the point of the run.
const report = (line: string): void => {
  process.stdout.write(line + '\n');
};

/** A timing or memory failure may repeat the run this many times in all (see verdict.ts); other failures never do. */
const MAX_ATTEMPTS = Number(process.env.PERF_GRID_100K_ATTEMPTS ?? 3);
/** AC-1: the wheel gesture's speed and length. 6 s at 40,000 px/s is 240,000 px: 7,500 rows of 32 px, 37 blocks. */
const SCROLL_SPEED = Number(process.env.PERF_GRID_100K_SCROLL_SPEED ?? 40_000);
const SCROLL_SECONDS = 6;
/** AC-4: jumps in all, the heap baseline is read after the fifth, and a sort click comes before every 30th jump. */
const JUMPS = Number(process.env.PERF_GRID_100K_JUMPS ?? 300);
const BASELINE_AFTER = 5;
const SORT_EVERY = 30;
const SEED = 53;
/**
 * Self-checks of the gates (not for a normal run): PERF_GRID_100K_BREAK=jank|leak|violate makes the page worse on
 * purpose (a 60 ms task in every answer; every answer kept for good; an inline script at boot), and the run must
 * fail on the gate that belongs to it.
 */
const BREAK =
  { jank: '?jank=60', leak: '?leak', violate: '?violate' }[
    process.env.PERF_GRID_100K_BREAK ?? ''
  ] ?? '';

const rounded = (value: number, digits = 1): number =>
  Number(value.toFixed(digits));

interface Session {
  readonly browser: Browser;
  readonly server: PageServer;
  readonly machine: Record<string, unknown>;
}

/**
 * Finds a browser (or skips loudly / fails), serves the page, launches Chromium, runs `body`, and cleans up. The
 * page build is a prerequisite of the target, not of this test.
 */
async function withBrowser(
  ctx: TestContext,
  ac: string,
  body: (session: Session) => Promise<void>,
  serverOptions: PageServerOptions = {},
): Promise<void> {
  const executable = findBrowser();
  if (executable === undefined) {
    const message = `${ac} SKIPPED: no Chromium-family browser binary found (looked at ${BROWSER_ENV.join(', ')}, then Chrome and Edge in their default locations). NOTHING WAS PROVED and no browser figure exists. Install Chrome or Edge, or set PERF_BROWSER to its path.`;
    process.stderr.write(message + '\n');
    if (process.env.PERF_REQUIRE_BROWSER !== undefined) {
      throw new Error(
        message + ' PERF_REQUIRE_BROWSER is set, so this is a failure.',
      );
    }
    ctx.skip(message);
    return;
  }
  if (!existsSync(join(pageDir, 'index.html'))) {
    throw new Error(
      `${pageDir} does not exist: run \`pnpm nx run perf:grid-100k\` (it builds the harness page, \`perf-grid-page\`, first)`,
    );
  }
  const server = await startPageServer(pageDir, serverOptions);
  let browser: Browser;
  try {
    browser = await launchBrowser(executable);
  } catch (error) {
    await server.close();
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
    data: `${String(ROWS)} rows from a fake engine window in the page, ${String(ANSWER_LATENCY_MS)} ms an answer`,
  };
  report(`[perf] grid-100k ${ac} machine ${JSON.stringify(machine)}`);
  try {
    await body({ browser, server, machine });
  } finally {
    await browser.close();
    await server.close();
  }
}

/** Opens the page and proves, before anything is measured, that the two detectors can fire. */
async function openChecked(
  session: Session,
  density: 'comfortable' | 'compact' = 'comfortable',
): Promise<{
  page: GridPage;
  rowHeight: number;
  viewportHeight: number;
}> {
  const page = await GridPage.open(session.browser, session.server.url, BREAK);
  try {
    let geometry = await page.ready();
    if (density === 'compact') {
      await page.grid('setDensity("compact")');
      await page.waitFor(
        `window.__perf.geometry().rowHeight < ${String(geometry.rowHeight)}`,
        'the compact row height',
        10_000,
      );
      await sleep(500);
      geometry = await page.perf<Geometry>('geometry()');
    }
    const seen = await page.state();
    if (seen.rows !== ROWS || seen.rowCount !== ROWS) {
      throw new Error(
        `the page serves ${String(seen.rows)} rows and the grid counts ${String(seen.rowCount)}, not ${String(ROWS)}: the page and the driver disagree`,
      );
    }
    const dead = await page.detectorsAreAlive();
    if (dead.length > 0) throw new Error(dead.join('; '));
    return { page, ...geometry };
  } catch (error) {
    await page.close();
    throw error;
  }
}

/** Runs `attempt` up to MAX_ATTEMPTS times while only timing or memory budgets are missed; asserts the last. */
async function untilJudged<T extends { verdict: Verdict }>(
  name: string,
  attempt: (n: number) => Promise<T>,
): Promise<T> {
  let last: T | undefined;
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    last = await attempt(n);
    const outcome = nextStep(last.verdict, n, MAX_ATTEMPTS);
    if (outcome !== 'retry') break;
    report(
      `[perf] grid-100k ${name} attempt ${String(n)} missed a budget (${last.verdict.timing.join('; ')}); trying again`,
    );
  }
  if (last === undefined) throw new Error('no attempt ran');
  expect([...last.verdict.deterministic, ...last.verdict.timing]).toEqual([]);
  return last;
}

function saveScreenshot(name: string, shot: Buffer): void {
  const dir = join(root, 'dist', 'perf');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), shot);
}

describe('grid 100k browser perf', () => {
  it('M0-53 AC-1 scrolls 100k rows at 55 fps or better with no task above 50 ms', async (ctx) => {
    await withBrowser(ctx, 'AC-1', async (session) => {
      // Both densities of the design system: 32 px rows and 24 px rows (the grid follows the density token).
      for (const density of ['comfortable', 'compact'] as const) {
        await untilJudged(`AC-1 ${density}`, async (n) => {
          const { page, rowHeight } = await openChecked(session, density);
          try {
            const before = await page.state();
            const at = await page.locate('app-root .ag-grid-viewport');
            const distance = SCROLL_SPEED * SCROLL_SECONDS;
            const scrollFrom = before.scrollTop;
            const startedAt = await page.perf<number>('startFrames()');
            await page.wheel(at, distance, SCROLL_SPEED, 60_000);
            const frames = await page.perf<{ stamps: number[]; to: number }>(
              'stopFrames()',
            );
            const { longTasks } = await page.reports();
            const state = await page.state();
            const during = longTasks.filter((task) => task.start >= startedAt);
            const verdict = judgeScroll({
              stamps: frames.stamps,
              longTasks: during,
              state,
              distinctBlocksBefore: before.distinctBlocks,
              scrollFrom,
              scrollTo: state.scrollTop,
              rowHeight,
              minFrames: 60,
            });
            report(
              `[perf] grid-100k AC-1 (browser, fake engine window, headless, one machine) ${JSON.stringify(
                {
                  density,
                  attempt: n,
                  fps: rounded(framesPerSecond(frames.stamps)),
                  frames: frames.stamps.length,
                  windowMs: rounded(
                    (frames.stamps.at(-1) ?? 0) - (frames.stamps[0] ?? 0),
                    0,
                  ),
                  longestFrameGapMs: rounded(longestFrameGap(frames.stamps), 0),
                  longTasks: during.length,
                  longestTaskMs: rounded(
                    Math.max(0, ...during.map((task) => task.duration)),
                    0,
                  ),
                  rowsTraversed: Math.round(
                    (state.scrollTop - scrollFrom) / rowHeight,
                  ),
                  rowHeightPx: rowHeight,
                  blocksAskedFor: state.distinctBlocks - before.distinctBlocks,
                  blocksResident: state.blocks,
                  requests: state.requests,
                  requestLimitMax: state.maxLimit,
                  requestsInFlightMax: state.maxInflight,
                  domRows: state.domRows,
                  otherConsole: [...new Set(page.otherConsole)].slice(0, 5),
                },
              )}`,
            );
            saveScreenshot(
              `grid-100k-scroll-${density}.png`,
              await page.screenshot(),
            );
            return { verdict };
          } finally {
            await page.close();
          }
        });
      }
      report(
        `[perf] grid-100k AC-1 verdict: budgets at least ${String(BUDGETS.fps)} fps and no task above ${String(BUDGETS.longTaskMs)} ms, more than the grid's blocks traversed`,
      );
    });
  }, 1_800_000);

  it('M0-53 AC-4 memory stays flat across 100k rows', async (ctx) => {
    await withBrowser(ctx, 'AC-4', async (session) => {
      await untilJudged('AC-4', async (n) => {
        const { page, rowHeight, viewportHeight } = await openChecked(session);
        try {
          await page.grid('startSampling()');
          const visibleRows = Math.max(
            1,
            Math.floor(viewportHeight / rowHeight),
          );
          const plan = planJumps({
            jumps: JUMPS,
            seed: SEED,
            visibleRows,
            sortEvery: SORT_EVERY,
          });
          let sort: SortDirection = 'none';
          let jumps = 0;
          let firstFive = 0;
          let mid = 0;
          let blocksAtMid = 0;
          const answered: number[] = [];
          for (const step of plan) {
            if (step.kind === 'sort') {
              sort = step.to;
              const aria = {
                asc: 'ascending',
                desc: 'descending',
                none: 'none',
              }[sort];
              await page.click(
                await page.locate('app-root .ag-header-cell[col-id="name"]'),
              );
              await page.waitFor(
                `document.querySelector('app-root .ag-header-cell[col-id="name"]').getAttribute('aria-sort') === '${aria}'`,
                `the sort mark ${aria}`,
                10_000,
              );
              // A new sort reloads the blocks and the grid returns to its first row; bring the page to rest there
              // (by content) before the next jump, so no late reset can undo it.
              await page.perf(
                `jump(0, [{ index: 0, name: ${JSON.stringify(nameAtRow(0, sort))} }], 20000)`,
                true,
              );
              continue;
            }
            const last = step.index + visibleRows - 2;
            const wanted = [
              { index: step.index, name: nameAtRow(step.index, sort) },
              { index: last, name: nameAtRow(last, sort) },
            ];
            const timing = await page.perf<{ ms: number }>(
              `jump(${String(step.index * rowHeight)}, ${JSON.stringify(wanted)}, 20000)`,
              true,
            );
            answered.push(timing.ms);
            jumps += 1;
            if (jumps === BASELINE_AFTER) {
              await sleep(200);
              firstFive = await page.heapAfterGc();
            }
            if (jumps === Math.floor(JUMPS / 2)) {
              await sleep(200);
              mid = await page.heapAfterGc();
              blocksAtMid = (await page.state()).blocks;
            }
          }
          await sleep(300);
          const finalBytes = await page.heapAfterGc();
          const state = await page.state();
          const data = {
            firstFiveBytes: firstFive,
            midBytes: mid,
            finalBytes,
            blocksAtMid,
            blocksAtFinal: state.blocks,
            jumps,
            planned: JUMPS,
            state,
          };
          const verdict = judgeMemory(data);
          const sorted = [...answered].sort((a, b) => a - b);
          report(
            `[perf] grid-100k AC-4 (browser, fake engine window, headless, one machine) ${JSON.stringify(
              {
                attempt: n,
                jumps,
                sortClicks: plan.filter((s) => s.kind === 'sort').length,
                heapAfterFiveWindowsMB: rounded(firstFive / 1024 ** 2, 2),
                heapMidRunMB: rounded(mid / 1024 ** 2, 2),
                heapAfterAllJumpsMB: rounded(finalBytes / 1024 ** 2, 2),
                ratioFinalOverMidRun: rounded(finalBytes / mid, 3),
                ratioFinalOverFirstFiveWindows: rounded(literalRatio(data), 3),
                blocksResidentMax: state.maxBlocks,
                blocksResidentMidRun: blocksAtMid,
                blocksResidentAtEnd: state.blocks,
                domRowsMax: state.maxDomRows,
                requests: state.requests,
                distinctBlocksAskedFor: state.distinctBlocks,
                requestLimitMax: state.maxLimit,
                requestsInFlightMax: state.maxInflight,
                jumpToRowsMsP50: rounded(
                  sorted[Math.floor(sorted.length / 2)] ?? 0,
                ),
                jumpToRowsMsMax: rounded(sorted.at(-1) ?? 0),
                otherConsole: [...new Set(page.otherConsole)].slice(0, 5),
              },
            )}`,
          );
          return { verdict };
        } finally {
          await page.close();
        }
      });
      report(
        `[perf] grid-100k AC-4 verdict: budgets heap at the end at most ${String(BUDGETS.heapRatio)} times the heap at mid-run (equal cache), at most 25 blocks resident, requests of at most 200 rows; the figure against the first ${String(BASELINE_AFTER)} windows is printed, not asserted (OQ-940)`,
      );
    });
  }, 1_800_000);

  it('M0-53 AC-16 the grid runs under the enforced S-04 policy with zero violations', async (ctx) => {
    // Twice: under the engine's policy as it is, and under the same policy without `style-src-attr 'unsafe-inline'`
    // (then `style-src 'self' 'nonce-N'` alone decides, and no markup may carry a style attribute).
    for (const strict of [false, true]) {
      await withBrowser(
        ctx,
        'AC-16',
        async (session) => {
          const { page, rowHeight } = await openChecked(session);
          try {
            // Scroll: a jump, then wheel input.
            await page.perf(
              `jump(${String(5000 * rowHeight)}, [{ index: 5000, name: 'queue-5000' }], 20000)`,
              true,
            );
            await page.wheel(
              await page.locate('app-root .ag-grid-viewport'),
              3000,
              6000,
              30_000,
            );
            const state = await page.state();
            // Menu: a real right click on a cell a few rows below the top of the viewport.
            const row = Math.ceil(state.scrollTop / rowHeight) + 2;
            await page.perf(
              `waitFor([{ index: ${String(row)}, name: 'queue-${String(row)}' }], 20000)`,
              true,
            );
            await page.click(
              await page.locate(
                `app-root .ag-row[row-index="${String(row)}"] .ag-cell[col-id="name"]`,
              ),
              'right',
            );
            await page.waitFor(
              'window.__perf.menu() !== null',
              'the menu',
              5000,
            );
            await sleep(200);
            const menu = await page.perf<{
              items: number;
              focusedIndex: number;
            } | null>('menu()');
            await page.key('Escape', 'Escape', 27);
            await page
              .waitFor(
                'window.__perf.menu() === null',
                'the menu to close',
                5000,
              )
              .catch(() => undefined);
            const closed = (await page.perf<unknown>('menu()')) === null;
            // Theme and density.
            const before = await page.policy();
            // The machine may already prefer dark: switch to the other one.
            const other = before.theme === 'dark' ? 'light' : 'dark';
            await page.grid(`setTheme(${JSON.stringify(other)})`);
            await page.grid('setDensity("compact")');
            await sleep(500);
            const after = await page.policy();
            const violations = await page.allViolations();
            const verdict = judgePolicy({
              policies: session.server.policies,
              violations,
              before,
              after,
              menu,
              menuClosedByEscape: closed,
              scrolled: state.scrollTop > 0,
            });
            report(
              `[perf] grid-100k AC-16 (browser, enforced S-04 policy${strict ? ' without style-src-attr' : ''}, headless, one machine) ${JSON.stringify(
                {
                  policy: [...new Set(session.server.policies)][0]?.replace(
                    /nonce-[^']+/,
                    'nonce-N',
                  ),
                  responses: session.server.policies.length,
                  cspOrTrustedTypesReports: violations.length,
                  styleElements: after.styleElements,
                  noncedStyleElements: after.noncedStyleElements,
                  theme: `${String(before.theme)} -> ${String(after.theme)}`,
                  density: `${String(before.density)} -> ${String(after.density)}`,
                  rowHeightPx: `${String(before.rowHeight)} -> ${String(after.rowHeight)}`,
                  gridBackground: `${before.gridBackground} -> ${after.gridBackground}`,
                  gridRootStyleAttribute: after.gridRootStyleAttribute,
                  menu,
                  otherConsole: [...new Set(page.otherConsole)].slice(0, 5),
                },
              )}`,
            );
            saveScreenshot('grid-100k-policy.png', await page.screenshot());
            expect([...verdict.deterministic, ...verdict.timing]).toEqual([]);
          } finally {
            await page.close();
          }
        },
        { strictStyleAttributes: strict },
      );
    }
  }, 600_000);
});
