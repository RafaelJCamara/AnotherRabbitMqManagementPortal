// The driver side of one tab on the harness page: opens it at 1280x720, collects everything the browser reports
// about the policy (CSP and Trusted Types reports from three channels: the page's `securitypolicyviolation`
// events, the DevTools `Audits` issues, and console / exception text), sends real input (mouse clicks, wheel
// gestures, keys) and reads the page's counts and the JS heap. The DevTools plumbing is `cdp.ts` of
// `explorer-ui-20k`, shared on purpose: one browser search, one launch.
import { sleep, type Browser, type CdpEvent } from '../explorer-ui-20k/cdp';

import { PAGE_SCRIPT } from './page-script';
import { VIEWPORT, type PageState, type PolicyState } from './shared';

const CSP_TEXT =
  /Content Security Policy|Content-Security-Policy|Trusted ?Types|TrustedHTML|TrustedScript|TrustedScriptURL|Refused to/i;

interface Point {
  readonly x: number;
  readonly y: number;
}

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

export interface LongTask {
  readonly start: number;
  readonly duration: number;
}

export interface Geometry {
  readonly rowHeight: number;
  readonly viewportHeight: number;
  readonly scrollHeight: number;
}

export interface WantedRow {
  readonly index: number;
  readonly name: string;
}

export class GridPage {
  readonly #browser: Browser;
  readonly #sessionId: string;
  readonly #targetId: string;
  /** CSP / Trusted Types reports from the DevTools channels (the page's own are read with `reports()`). */
  readonly violations: string[] = [];
  readonly otherConsole: string[] = [];

  private constructor(browser: Browser, sessionId: string, targetId: string) {
    this.#browser = browser;
    this.#sessionId = sessionId;
    this.#targetId = targetId;
  }

  /** Opens a tab, wires the reports, and loads the harness page. */
  static async open(
    browser: Browser,
    url: string,
    query = '',
  ): Promise<GridPage> {
    const { connection } = browser;
    const { targetId } = (await connection.send('Target.createTarget', {
      url: 'about:blank',
    })) as { targetId: string };
    const { sessionId } = (await connection.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    })) as { sessionId: string };
    const page = new GridPage(browser, sessionId, targetId);
    connection.onEvent((event) => {
      if (event.sessionId === sessionId) page.#onEvent(event);
    });
    const send = (method: string, params: Record<string, unknown> = {}) =>
      connection.send(method, params, sessionId);
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Audits.enable');
    await send('HeapProfiler.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: PAGE_SCRIPT,
    });
    await send('Page.navigate', { url: url + query });
    return page;
  }

  #note(scope: string, text: string): void {
    const line = `${scope}: ${text.replaceAll(/\s+/g, ' ').slice(0, 300)}`;
    if (CSP_TEXT.test(text)) this.violations.push(line);
    else this.otherConsole.push(line);
  }

  #onEvent(event: CdpEvent): void {
    const { method, params } = event;
    if (method === 'Log.entryAdded') {
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
        const args = params.args as { value?: unknown; description?: string }[];
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
        this.violations.push(
          `issue: ${String(d.contentSecurityPolicyViolationType)} ${String(d.violatedDirective)} ${d.blockedURL ?? ''}`,
        );
      }
    }
  }

  async #send(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    return this.#browser.connection.send(
      method,
      params,
      this.#sessionId,
      timeoutMs,
    );
  }

  async evaluate(expression: string, awaitPromise = false): Promise<unknown> {
    const answer = (await this.#send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    })) as unknown as CdpResult;
    if (answer.exceptionDetails !== undefined) {
      throw new Error(
        answer.exceptionDetails.exception?.description ??
          answer.exceptionDetails.text,
      );
    }
    return answer.result.value;
  }

  /** `window.__perf.<call>` (the page script). */
  perf<T>(call: string, awaitPromise = false): Promise<T> {
    return this.evaluate(`window.__perf.${call}`, awaitPromise) as Promise<T>;
  }

  /** `window.__grid.<call>` (the harness app's hooks). */
  grid<T>(call: string): Promise<T> {
    return this.evaluate(`window.__grid.${call}`) as Promise<T>;
  }

  async waitFor(
    expression: string,
    what: string,
    timeoutMs = 30_000,
  ): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if ((await this.evaluate(expression).catch(() => false)) === true) return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  /** Waits until the first rows are on screen and loaded, then lets the first renders settle. */
  async ready(): Promise<Geometry> {
    await this.waitFor(
      `window.__grid !== undefined && window.__perf.describe().firstRows.some((row) => row.startsWith('0:queue-'))`,
      'the first rows of the grid',
    );
    await sleep(500);
    return this.perf<Geometry>('geometry()');
  }

  state(): Promise<PageState> {
    return this.grid<PageState>('state()');
  }

  policy(): Promise<PolicyState> {
    return this.grid<PolicyState>('policy()');
  }

  /** Where a real mouse click goes: the centre of the target, which must be the topmost element there. */
  async locate(selector: string): Promise<Point> {
    const found = await this.perf<Located | null>(
      `centre(${JSON.stringify(selector)})`,
    );
    if (found === null) throw new Error(`nothing to click: ${selector}`);
    if (found.covered !== null) {
      throw new Error(
        `${selector} is covered at (${String(found.x)}, ${String(found.y)}) by ${found.covered}`,
      );
    }
    return found;
  }

  async #mouse(
    type: string,
    point: Point,
    button: 'left' | 'right' | 'none',
  ): Promise<void> {
    await this.#send('Input.dispatchMouseEvent', {
      type,
      x: point.x,
      y: point.y,
      button,
      clickCount: type === 'mouseMoved' ? 0 : 1,
      buttons: type === 'mousePressed' ? (button === 'right' ? 2 : 1) : 0,
    });
  }

  /** A real mouse click: move, press, release. */
  async click(point: Point, button: 'left' | 'right' = 'left'): Promise<void> {
    await this.#mouse('mouseMoved', point, 'none');
    await this.#mouse('mousePressed', point, button);
    await this.#mouse('mouseReleased', point, button);
  }

  async key(key: string, code: string, keyCode: number): Promise<void> {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await this.#send('Input.dispatchKeyEvent', {
        type,
        key,
        code,
        windowsVirtualKeyCode: keyCode,
      });
    }
  }

  /**
   * Wheel input over the grid: the browser synthesises a mouse-wheel gesture of `distance` pixels (scrolling down)
   * at `speed` pixels per second and the call returns when it has been delivered (so its length is
   * distance / speed). The input is the browser's own, not a script writing `scrollTop`.
   */
  async wheel(
    at: Point,
    distance: number,
    speed: number,
    timeoutMs: number,
  ): Promise<void> {
    await this.#send(
      'Input.synthesizeScrollGesture',
      {
        x: at.x,
        y: at.y,
        yDistance: -distance,
        speed,
        gestureSourceType: 'mouse',
        preventFling: true,
      },
      timeoutMs,
    );
  }

  /** The used JS heap after two forced collections (the live set, not the garbage). */
  async heapAfterGc(): Promise<number> {
    await this.#send('HeapProfiler.collectGarbage');
    await sleep(100);
    await this.#send('HeapProfiler.collectGarbage');
    const usage = (await this.#send('Runtime.getHeapUsage')) as {
      usedSize: number;
    };
    return usage.usedSize;
  }

  /** The reports the page collected itself (`securitypolicyviolation` events) and the long tasks. */
  async reports(): Promise<{
    pageViolations: string[];
    longTasks: LongTask[];
  }> {
    return {
      pageViolations: await this.perf<string[]>('violations'),
      longTasks: await this.perf<LongTask[]>('longTasksSince(0)'),
    };
  }

  /** Everything refused so far, from every channel (the page's events and the DevTools issues and text). */
  async allViolations(): Promise<string[]> {
    const { pageViolations } = await this.reports();
    return [...new Set([...this.violations, ...pageViolations])];
  }

  /**
   * Proves the two detectors are alive in this very page: a task that blocks the main thread for 90 ms must appear
   * as a long task, and an inline script (refused by the policy and by Trusted Types) must appear as a report. What
   * the page had reported before (boot included) is kept; only what the check itself caused is removed. A gate that
   * cannot fire proves nothing.
   */
  async detectorsAreAlive(): Promise<string[]> {
    const problems: string[] = [];
    const beforeViolations = this.violations.length;
    const beforePage = await this.perf<string[]>('violations');
    const beforeLong = await this.perf<LongTask[]>('longTasksSince(0)');
    await this.perf('busy(90)');
    await sleep(300);
    const long = await this.perf<LongTask[]>('longTasksSince(0)');
    if (long.length <= beforeLong.length) {
      problems.push(
        'a 90 ms busy loop was not reported as a long task: the long-task gate cannot fire',
      );
    }
    await this.perf('provokeViolation()');
    await sleep(300);
    const channels =
      this.violations.length -
      beforeViolations +
      ((await this.perf<string[]>('violations')).length - beforePage.length);
    if (channels === 0) {
      problems.push(
        'an inline script was not reported as a CSP / Trusted Types violation: the violation gate cannot fire',
      );
    }
    // Remove what the check caused: restore the earlier reports exactly.
    this.violations.length = beforeViolations;
    await this.evaluate(
      `window.__perf.violations.length = ${String(beforePage.length)}; window.__perf.longTasks.splice(${String(beforeLong.length)})`,
    );
    return problems;
  }

  async screenshot(): Promise<Buffer> {
    const shot = (await this.#send('Page.captureScreenshot', {
      format: 'png',
    })) as { data: string };
    return Buffer.from(shot.data, 'base64');
  }

  async close(): Promise<void> {
    await this.#browser.connection
      .send('Target.closeTarget', { targetId: this.#targetId })
      .catch(() => undefined);
  }
}
