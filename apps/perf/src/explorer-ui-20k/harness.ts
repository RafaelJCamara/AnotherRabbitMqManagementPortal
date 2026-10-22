// The browser side of AC-27: the REAL engine bundle serves the REAL production web build under the real
// Content-Security-Policy (the way `web-csp-check` does), a real Chromium opens the explorer's queue page at
// 1280x720, and the fake data port stands where the engine's `inventory.query` would answer: the harness answers
// that one HTTP route from a 20,000-row deterministic fake (`@app/explorer-model/testing`) through the DevTools
// `Fetch` domain. Everything else is real: the app shell, the router, `EngineApi`/`HttpClient`, the window source,
// AG Grid, the filter bar, the live socket to the engine.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConnectionIdSchema } from '@app/contracts';
import type { FakeExplorerData } from '@app/explorer-model/testing';
import { createExplorerFakeDeps } from '@app/svc-explorer';

import { sleep, type Browser, type CdpEvent } from './cdp';
import { PAGE_SCRIPT } from './page-script';
import type { Expect, Step } from './plan';
import type { LongTask, RequestRecord, Sample } from './verdict';

/** Extra time the data port waits before it answers; 0 outside a self-check of the gate. */
const ANSWER_DELAY_MS = Number(
  process.env.PERF_EXPLORER_UI_BROWSER_ANSWER_DELAY_MS ?? 0,
);

export const VIEWPORT = { width: 1280, height: 720 } as const;
/** The connection id of the page's address (`/c/perf/...`); no such connection exists in the engine. */
export const CID = 'perf';

const CSP_TEXT =
  /Content Security Policy|Content-Security-Policy|Trusted ?Types|TrustedHTML|TrustedScript|TrustedScriptURL|Refused to/i;

export interface RunningEngine {
  /** `http://127.0.0.1:<port>/#t=<token>` */
  readonly url: string;
  stop(): Promise<void>;
}

/** Starts the built engine bundle in local mode, serving the built web UI. */
export async function startEngine(root: string): Promise<RunningEngine> {
  const dataDir = mkdtempSync(join(tmpdir(), 'perf-ui-data-'));
  const child: ChildProcess = spawn(
    process.execPath,
    [
      join(root, 'dist', 'apps', 'engine', 'main.mjs'),
      '--mode=local',
      '--port=0',
      `--data-dir=${dataDir}`,
      `--ui-dir=${join(root, 'dist', 'apps', 'web', 'browser')}`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  const stderr: string[] = [];
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(String(chunk)));
  const url = await new Promise<string>((resolve, reject) => {
    let pending = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      pending += String(chunk);
      for (const line of pending.split('\n')) {
        if (line.startsWith('http://')) resolve(line.trim());
      }
    });
    child.on('exit', (code) => {
      reject(
        new Error(
          `the engine exited with code ${String(code)}: ${stderr.join('').slice(0, 500)}`,
        ),
      );
    });
    setTimeout(() => {
      reject(new Error('the engine printed no launch URL'));
    }, 30_000);
  });
  return {
    url,
    async stop() {
      if (child.connected) child.send({ t: 'shutdown', deadlineMs: 2000 });
      await sleep(500);
      child.kill();
      await sleep(300);
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // The engine may still release the file; the OS temp cleaner takes it.
      }
    },
  };
}

interface Answered {
  readonly request: RequestRecord;
  /** The request body as the page sent it, for the failure message. */
  readonly body: string;
  /** The data port's own time for the answer (the fake query and the JSON). */
  readonly answerMs: number;
  /** From the browser pausing the request to the fulfilment being acknowledged. */
  readonly roundTripMs: number;
}

export interface PageRun {
  readonly samples: Sample[];
  readonly requests: Answered[];
  readonly longTasks: LongTask[];
  /** Long tasks of the warm-up and the load, for information. */
  readonly warmupLongTasks: LongTask[];
  readonly violations: string[];
  readonly otherConsole: string[];
  readonly grid: { rowHeight: number; viewportHeight: number };
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/** centre() of the page script: where to click, and what covers it if it is not the target. */
interface Located extends Point {
  readonly covered: string | null;
}

interface CdpResult {
  readonly result: { value?: unknown; description?: string };
  readonly exceptionDetails?: {
    readonly text: string;
    readonly exception?: { readonly description?: string };
  };
}

/** One tab on the explorer page, with the data port answering and everything it reports collected. */
export class ExplorerPage {
  readonly #browser: Browser;
  readonly #sessionId: string;
  readonly #targetId: string;
  readonly #data: FakeExplorerData;
  readonly requests: Answered[] = [];
  readonly violations = new Set<string>();
  readonly otherConsole: string[] = [];
  #inflight = 0;
  #lastActivity = Date.now();

  private constructor(
    browser: Browser,
    sessionId: string,
    targetId: string,
    data: FakeExplorerData,
  ) {
    this.#browser = browser;
    this.#sessionId = sessionId;
    this.#targetId = targetId;
    this.#data = data;
  }

  /** Opens a tab, wires the reports and the data port, and loads the queue page. */
  static async open(
    browser: Browser,
    launchUrl: string,
    data: FakeExplorerData,
  ): Promise<ExplorerPage> {
    const { connection } = browser;
    const { targetId } = (await connection.send('Target.createTarget', {
      url: 'about:blank',
    })) as { targetId: string };
    const { sessionId } = (await connection.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    })) as { sessionId: string };
    const page = new ExplorerPage(browser, sessionId, targetId, data);
    connection.onEvent((event) => {
      if (event.sessionId === sessionId) page.#onEvent(event);
    });
    const send = (method: string, params: Record<string, unknown> = {}) =>
      connection.send(method, params, sessionId);
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Audits.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: PAGE_SCRIPT,
    });
    await send('Fetch.enable', {
      patterns: [
        { urlPattern: '*/inventory/queries', requestStage: 'Request' },
        // The page reads the connection's profile before it reads the inventory (a connection with no profile gets the
        // check capabilities prompt, not a list), and no connection `perf` exists in the engine.
        { urlPattern: '*/profile', requestStage: 'Request' },
      ],
    });
    const address = new URL(`/c/${CID}/explorer/queues`, launchUrl);
    address.hash = new URL(launchUrl).hash;
    await send('Page.navigate', { url: address.href });
    return page;
  }

  #note(scope: string, text: string): void {
    const line = `${scope}: ${text.replaceAll(/\s+/g, ' ').slice(0, 300)}`;
    if (CSP_TEXT.test(text)) this.violations.add(line);
    else this.otherConsole.push(line);
  }

  #onEvent(event: CdpEvent): void {
    const { method } = event;
    const params = event.params;
    if (method === 'Fetch.requestPaused') {
      const url = (params.request as { url: string }).url;
      if (new URL(url).pathname.endsWith('/profile'))
        void this.#answerProfile(params);
      else void this.#answer(params);
    } else if (method === 'Log.entryAdded') {
      const entry = params.entry as { level: string; text: string };
      if (entry.level === 'error' || CSP_TEXT.test(entry.text))
        this.#note('log', entry.text);
    } else if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails as {
        text: string;
        exception?: { description?: string };
      };
      this.#note('exception', details.exception?.description ?? details.text);
    } else if (method === 'Runtime.consoleAPICalled') {
      const type = params.type as string;
      if (type === 'error' || type === 'warning') {
        const args = params.args as {
          value?: unknown;
          description?: string;
        }[];
        this.#note(
          'console',
          args
            .map((arg) =>
              typeof arg.value === 'string'
                ? arg.value
                : (arg.description ?? ''),
            )
            .join(' '),
        );
      }
    } else if (method === 'Audits.issueAdded') {
      const issue = params.issue as {
        code: string;
        details: {
          contentSecurityPolicyIssueDetails?: {
            violatedDirective?: string;
            blockedURL?: string;
            contentSecurityPolicyViolationType?: string;
          };
        };
      };
      if (issue.code === 'ContentSecurityPolicyIssue') {
        const d = issue.details.contentSecurityPolicyIssueDetails ?? {};
        this.violations.add(
          `issue: ${String(d.contentSecurityPolicyViolationType)} ${String(d.violatedDirective)} ${d.blockedURL ?? ''}`,
        );
      }
    }
  }

  /** Answers one paused `profile.get` with the profile of a probed connection (the explorer fakes' sample). */
  async #answerProfile(
    params: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const record = await createExplorerFakeDeps().profiles.get(
      ConnectionIdSchema.parse('c1'),
    );
    const body = JSON.stringify({
      profile: { ...(record?.profile as object), connectionId: CID },
    });
    await this.#browser.connection
      .send(
        'Fetch.fulfillRequest',
        {
          requestId: params.requestId as string,
          responseCode: 200,
          responseHeaders: [
            { name: 'content-type', value: 'application/json' },
          ],
          body: Buffer.from(body).toString('base64'),
        },
        this.#sessionId,
      )
      .catch(() => undefined);
  }

  /** Answers one paused `inventory.query` from the fake data port. */
  async #answer(params: Readonly<Record<string, unknown>>): Promise<void> {
    const paused = performance.now();
    this.#inflight++;
    this.#lastActivity = Date.now();
    const requestId = params.requestId as string;
    const request = params.request as { postData?: string; url: string };
    try {
      const body = JSON.parse(request.postData ?? '{}') as {
        window: { offset: number; limit: number };
      };
      // Self-check knob (PERF_EXPLORER_UI_BROWSER_ANSWER_DELAY_MS): slows the data port to prove the gate can fail.
      if (ANSWER_DELAY_MS > 0) await sleep(ANSWER_DELAY_MS);
      const began = performance.now();
      const output = await this.#data.query(
        { ...body, cid: CID } as Parameters<FakeExplorerData['query']>[0],
        new AbortController().signal,
      );
      const json = JSON.stringify(output);
      const answerMs = performance.now() - began;
      await this.#browser.connection
        .send(
          'Fetch.fulfillRequest',
          {
            requestId,
            responseCode: 200,
            responseHeaders: [
              { name: 'content-type', value: 'application/json' },
            ],
            body: Buffer.from(json).toString('base64'),
          },
          this.#sessionId,
        )
        .catch(() => undefined); // a request the page already abandoned
      this.requests.push({
        request: { offset: body.window.offset, limit: body.window.limit },
        body: request.postData ?? '',
        answerMs,
        roundTripMs: performance.now() - paused,
      });
    } finally {
      this.#inflight--;
      this.#lastActivity = Date.now();
    }
  }

  async #evaluate(expression: string, awaitPromise = false): Promise<unknown> {
    const answer = (await this.#browser.connection.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise },
      this.#sessionId,
    )) as unknown as CdpResult;
    if (answer.exceptionDetails !== undefined) {
      throw new Error(
        answer.exceptionDetails.exception?.description ??
          answer.exceptionDetails.text,
      );
    }
    return answer.result.value;
  }

  /** Evaluates `window.__perf.<call>` and returns its JSON value. */
  call<T>(call: string): Promise<T> {
    return this.#evaluate(`window.__perf.${call}`) as Promise<T>;
  }

  async waitFor(
    expression: string,
    what: string,
    timeoutMs = 30_000,
  ): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if ((await this.#evaluate(expression).catch(() => false)) === true)
        return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  /** Waits until the first rows are on screen, then reads the grid geometry. */
  async ready(): Promise<{
    rowHeight: number;
    viewportHeight: number;
    columns: string[];
  }> {
    await this.waitFor(
      `document.querySelector('app-data-grid .ag-row[row-index="0"]') !== null && document.querySelector('.counts') !== null`,
      'the first rows of the queue page',
    );
    // Lazy chunks, the live socket's first answer and the first renders settle here.
    await this.quiet(400);
    const grid = await this.call<{ rowHeight: number; viewportHeight: number }>(
      'measureGrid()',
    );
    const columns = await this.call<string[]>('visibleHeaders()'); // sortable ones
    return { ...grid, columns };
  }

  /** Waits until nothing is in flight and nothing has been asked for `quietMs`. */
  async quiet(quietMs = 100): Promise<void> {
    for (;;) {
      await sleep(25);
      if (this.#inflight === 0 && Date.now() - this.#lastActivity >= quietMs)
        return;
    }
  }

  async #mouse(type: string, x: number, y: number): Promise<void> {
    await this.#browser.connection.send(
      'Input.dispatchMouseEvent',
      { type, x, y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 },
      this.#sessionId,
    );
  }

  /** Where a real mouse click goes: the centre of the target, which must be the topmost element there. */
  async #locate(selector: string): Promise<Point> {
    return this.#checked(
      await this.call<Located | null>(`centre(${JSON.stringify(selector)})`),
      selector,
    );
  }

  async #locateOption(picker: number, value: string): Promise<Point> {
    return this.#checked(
      await this.call<Located | null>(
        `optionBox(${String(picker)}, ${JSON.stringify(value)})`,
      ),
      `option ${value} of facet ${String(picker)}`,
    );
  }

  #checked(found: Located | null, what: string): Point {
    if (found === null) throw new Error(`nothing to click: ${what}`);
    if (found.covered !== null) {
      throw new Error(
        `${what} is covered at (${String(found.x)}, ${String(found.y)}) by ${found.covered}`,
      );
    }
    return found;
  }

  /** A real mouse click: move, press, release. */
  async #clickAt(point: Point): Promise<void> {
    await this.#mouse('mouseMoved', point.x, point.y);
    await this.#mouse('mousePressed', point.x, point.y);
    await this.#mouse('mouseReleased', point.x, point.y);
  }

  async #click(selector: string): Promise<void> {
    await this.#clickAt(await this.#locate(selector));
  }

  /** Unmeasured: returns the viewport to the first row before a filter (see 	oTop in the page script). */
  async #backToTop(): Promise<void> {
    if ((await this.#evaluate('window.__perf.toTop(20000)', true)) === true) {
      await this.quiet(100);
    }
  }

  /** Runs one planned step: the unmeasured set-up, then the timed input. Resolves the time in ms. */
  async run(
    step: Step,
    grid: { rowHeight: number },
  ): Promise<Sample & { frames: number }> {
    const arm = (expect: Expect, trigger: 'click' | 'enter' | 'now') =>
      this.#evaluate(
        `window.__perf.arm(${JSON.stringify(expect)}, ${JSON.stringify(trigger)}, 20000)`,
        true,
      ) as Promise<{ ms: number; frames: number }>;
    const timed = async (
      expect: Expect,
      trigger: 'click' | 'enter' | 'now',
      input: () => Promise<void>,
    ): Promise<{ ms: number; frames: number }> => {
      if (await this.call<boolean>(`alreadyTrue(${JSON.stringify(expect)})`)) {
        throw new Error(
          `the step would time nothing: the page already shows ${JSON.stringify(expect)}`,
        );
      }
      const armed = arm(expect, trigger);
      // A rejection of `armed` before the input is awaited must not be lost.
      armed.catch(() => undefined);
      await input();
      return armed;
    };
    // Unmeasured: let the layout stop moving, so the point to click is where the element will be.
    await this.#evaluate('window.__perf.settle(5, 3000)', true);
    let timing: { ms: number; frames: number };
    switch (step.kind) {
      case 'scroll':
        timing = await timed(step.expect, 'now', async () => {
          await this.call(`scrollTo(${String(step.index * grid.rowHeight)})`);
        });
        break;
      case 'text-filter':
        await this.#backToTop();
        timing = await timed(step.expect, 'enter', async () => {
          await this.call(
            `typeAndEnter('.text-input', ${JSON.stringify(step.text)})`,
          );
        });
        break;
      case 'sort': {
        timing = await timed(step.expect, 'click', async () => {
          // Located just before the click: the layout can still move (a banner, the filter chips).
          await this.#clickAt(
            await this.#locate(
              `app-data-grid .ag-header-cell[col-id="${step.column}"]`,
            ),
          );
        });
        break;
      }
      case 'facet': {
        await this.#backToTop();
        const picker = step.facet === 'vhosts' ? 1 : 2;
        const toggle = `app-facet-picker:nth-of-type(${String(picker)}) .toggle`;
        // Unmeasured: open the panel.
        await this.#click(toggle);
        await this.waitFor(
          `document.querySelector('app-facet-picker:nth-of-type(${String(picker)}) .panel') !== null`,
          'the facet panel',
          5_000,
        );
        if (step.facet === 'vhosts' && step.checked) {
          timing = await timed(step.expect, 'enter', async () => {
            await this.call(
              `typeAndEnter('app-facet-picker:nth-of-type(1) .panel .add input', ${JSON.stringify(step.value)})`,
            );
          });
        } else {
          timing = await timed(step.expect, 'click', async () => {
            await this.#clickAt(await this.#locateOption(picker, step.value));
          });
        }
        // Unmeasured: close the panel so it never covers the header.
        await this.#click(toggle);
        await this.waitFor(
          `document.querySelector('app-facet-picker:nth-of-type(${String(picker)}) .panel') === null`,
          'the facet panel to close',
          5_000,
        );
        break;
      }
    }
    return { kind: step.kind, ms: timing.ms, frames: timing.frames };
  }

  /** Everything the page reported, read once at the end. */
  async report(from: number): Promise<{
    longTasks: LongTask[];
    pageViolations: string[];
    now: number;
  }> {
    const longTasks = await this.call<LongTask[]>('longTasksSince(0)');
    const violations = await this.call<
      {
        directive: string;
        blocked: string;
        source: string;
        sample: string;
        disposition: string;
      }[]
    >('violations');
    return {
      longTasks: longTasks.filter((task) => task.start >= from),
      pageViolations: violations.map(
        (v) =>
          `event: ${v.disposition} ${v.directive} blocked=${v.blocked} at ${v.source} sample=${v.sample}`,
      ),
      now: await this.call<number>('now()'),
    };
  }

  /**
   * Proves the two detectors are alive in this very page before anything is measured: a task that blocks the main
   * thread for 90 ms must appear as a long task, and an inline script (refused by the Content-Security-Policy and
   * Trusted Types) must appear as a report. Both are cleared afterwards. A gate that cannot fire proves nothing.
   */
  async detectorsAreAlive(): Promise<string[]> {
    const problems: string[] = [];
    await this.call('busy(90)');
    await sleep(300);
    const long = await this.call<LongTask[]>('longTasksSince(0)');
    if (!long.some((task) => task.duration >= 50)) {
      problems.push(
        'a 90 ms busy loop was not reported as a long task: the long-task gate cannot fire',
      );
    }
    this.violations.clear();
    await this.call('provokeViolation()');
    await sleep(300);
    if (this.violations.size === 0) {
      problems.push(
        'an inline script was not reported as a CSP / Trusted Types violation: the violation gate cannot fire',
      );
    }
    this.violations.clear();
    await this.call('clearReports()');
    return problems;
  }

  async screenshot(): Promise<Buffer> {
    const shot = (await this.#browser.connection.send(
      'Page.captureScreenshot',
      { format: 'png' },
      this.#sessionId,
    )) as { data: string };
    return Buffer.from(shot.data, 'base64');
  }

  async close(): Promise<void> {
    await this.#browser.connection
      .send('Target.closeTarget', { targetId: this.#targetId })
      .catch(() => undefined);
  }
}
