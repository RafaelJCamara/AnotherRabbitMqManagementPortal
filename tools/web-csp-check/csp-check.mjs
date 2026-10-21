// `nx run web-csp-check:csp-check`: the production web build, served by the real engine bundle in
// local mode under the real Content-Security-Policy, opened in a real browser at 1280x720.
// It fails when the page is unstyled (the shell grid has fewer than two columns, the activity bar and
// the workspace share an x position, the page scrolls sideways) or when the browser reports one CSP
// or Trusted Types violation. Without a browser binary it says so loudly and exits 0 (exit 1 when
// CSP_CHECK_REQUIRE_BROWSER is set, as CI does): it never prints a green result it did not earn.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { BROWSER_ENV, findBrowser, launchBrowser, sleep } from './cdp.mjs';

export const VIEWPORT = { width: 1280, height: 720 };

/** The shell lives under `/c/:cid`; every other address shows the "no connection" view. */
export const PAGES = [
  { name: 'shell', path: '/c/csp-check/explorer', expectShell: true },
  { name: 'no-connection', path: '/', expectShell: false },
];

const CSP_TEXT =
  /Content Security Policy|Content-Security-Policy|Trusted ?Types|TrustedHTML|TrustedScript|TrustedScriptURL|Refused to/i;

/** Page-side listener, installed before any script of the page runs. */
const COLLECTOR = `
  window.__cspEvents = [];
  window.addEventListener('securitypolicyviolation', (event) => {
    window.__cspEvents.push({
      directive: event.effectiveDirective,
      blocked: String(event.blockedURI).slice(0, 120),
      source: String(event.sourceFile).slice(0, 120) + ':' + String(event.lineNumber),
      sample: String(event.sample).slice(0, 120),
      disposition: event.disposition,
    });
  }, true);
`;

/** Everything that is read from the page once it has rendered. */
const MEASURE = `(() => {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const shell = document.querySelector('.shell');
  const style = shell ? getComputedStyle(shell) : null;
  return JSON.stringify({
    appRootChildren: document.querySelector('app-root')?.childElementCount ?? -1,
    shell: shell === null ? null : {
      display: style.display,
      columns: style.gridTemplateColumns === 'none' ? [] : style.gridTemplateColumns.split(' ').filter(Boolean),
      box: box(shell),
      activity: box(document.querySelector('app-activity-bar')),
      main: box(document.querySelector('.main')),
    },
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    styleElements: document.querySelectorAll('style').length,
    nonceOfRoot: document.querySelector('app-root')?.getAttribute('ngCspNonce') ?? null,
    metaNonce: document.querySelector('meta[name="csp-nonce"]')?.getAttribute('content') ?? null,
    events: window.__cspEvents ?? [],
  });
})()`;

/**
 * The failures of a measured page; an empty list is a pass. Pure, so the judgement is tested
 * without a browser.
 */
export function judge(report, { expectShell = true } = {}) {
  const failures = [];
  const { shell } = report;
  // A page without the shell (no connection chosen) is judged by the checks after this block only.
  if (expectShell && (shell === null || shell === undefined)) {
    failures.push(
      `the shell did not render (app-root has ${String(report.appRootChildren)} children)`,
    );
  } else if (expectShell && shell) {
    if (shell.display !== 'grid')
      failures.push(`the shell is display:${shell.display}, not grid`);
    if (shell.columns.length < 2)
      failures.push(
        `the shell grid has ${String(shell.columns.length)} column(s), expected 2 or more`,
      );
    if (
      shell.activity !== null &&
      shell.main !== null &&
      shell.main.x <= shell.activity.x
    )
      failures.push(
        `the workspace (x=${String(shell.main.x)}) is not to the right of the activity bar (x=${String(shell.activity.x)})`,
      );
    if (shell.activity === null || shell.main === null)
      failures.push('the activity bar or the workspace region is missing');
  }
  if (report.scrollWidth > report.clientWidth)
    failures.push(
      `the page scrolls sideways (scrollWidth ${String(report.scrollWidth)} > clientWidth ${String(report.clientWidth)})`,
    );
  if (report.metaNonce === null || report.metaNonce === '')
    failures.push('the page has no csp-nonce meta tag');
  if (report.nonceOfRoot !== report.metaNonce)
    failures.push('ngCspNonce of the app root differs from the csp-nonce meta');
  for (const violation of report.violations)
    failures.push(`CSP/Trusted Types report: ${violation}`);
  return failures;
}

function startEngine(root, dataDir) {
  const child = spawn(
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
  let pending = '';
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  const url = new Promise((resolveUrl, reject) => {
    child.stdout.on('data', (chunk) => {
      pending += String(chunk);
      for (const line of pending.split('\n')) {
        if (line.startsWith('http://')) resolveUrl(line.trim());
      }
    });
    child.on('exit', (code) =>
      reject(
        new Error(
          `the engine exited with code ${String(code)}: ${stderr.join('').slice(0, 500)}`,
        ),
      ),
    );
    setTimeout(
      () => reject(new Error('the engine printed no launch URL')),
      30000,
    );
  });
  return { child, url };
}

async function measure(browser, url, outDir, name, expectShell) {
  const { connection } = browser;
  const { targetId } = await connection.send('Target.createTarget', {
    url: 'about:blank',
  });
  const { sessionId } = await connection.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  const violations = new Set();
  const consoleErrors = [];
  const note = (scope, text) => {
    const line = `${scope}: ${text.replaceAll(/\s+/g, ' ').slice(0, 300)}`;
    if (CSP_TEXT.test(text)) violations.add(line);
    else consoleErrors.push(line);
  };
  connection.onEvent((event) => {
    if (event.sessionId !== sessionId) return;
    const { method, params } = event;
    if (method === 'Log.entryAdded') {
      if (params.entry.level === 'error' || CSP_TEXT.test(params.entry.text))
        note('log', params.entry.text);
    } else if (method === 'Runtime.exceptionThrown') {
      note(
        'exception',
        params.exceptionDetails.exception?.description ??
          params.exceptionDetails.text,
      );
    } else if (method === 'Runtime.consoleAPICalled') {
      if (params.type === 'error' || params.type === 'warning')
        note(
          'console',
          params.args
            .map((arg) => String(arg.value ?? arg.description ?? ''))
            .join(' '),
        );
    } else if (method === 'Audits.issueAdded') {
      const issue = params.issue;
      if (issue.code === 'ContentSecurityPolicyIssue') {
        const d = issue.details.contentSecurityPolicyIssueDetails ?? {};
        violations.add(
          `issue: ${String(d.contentSecurityPolicyViolationType)} ${String(d.violatedDirective)} ${String(d.blockedURL ?? '')}`,
        );
      }
    }
  });
  await connection.send('Page.enable', {}, sessionId);
  await connection.send('Runtime.enable', {}, sessionId);
  await connection.send('Log.enable', {}, sessionId);
  await connection.send('Audits.enable', {}, sessionId);
  await connection.send(
    'Emulation.setDeviceMetricsOverride',
    {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    },
    sessionId,
  );
  await connection.send(
    'Page.addScriptToEvaluateOnNewDocument',
    { source: COLLECTOR },
    sessionId,
  );
  await connection.send('Page.navigate', { url }, sessionId);

  const evaluate = async (expression) => {
    const result = await connection
      .send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)
      .catch(() => undefined);
    return result?.result.value;
  };
  const started = Date.now();
  while (
    Date.now() - started < 30000 &&
    expectShell &&
    (await evaluate('document.querySelector(".shell") !== null')) !== true
  ) {
    await sleep(150);
  }
  // Lazy chunks, the first route and late style insertions settle here.
  await sleep(2000);
  const report = JSON.parse((await evaluate(MEASURE)) ?? 'null');
  const shot = await connection
    .send('Page.captureScreenshot', { format: 'png' }, sessionId)
    .catch(() => undefined);
  if (shot !== undefined) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, name + '-1280x720.png'),
      Buffer.from(shot.data, 'base64'),
    );
  }
  await connection
    .send('Target.closeTarget', { targetId })
    .catch(() => undefined);
  for (const event of report?.events ?? [])
    violations.add(
      `event: ${event.disposition} ${event.directive} blocked=${event.blocked} at ${event.source} sample=${event.sample}`,
    );
  return { ...report, violations: [...violations], consoleErrors };
}

export async function run(root) {
  const executable = findBrowser();
  if (executable === undefined) {
    const message = `csp-check SKIPPED: no Chromium-family browser binary found (looked at ${BROWSER_ENV.join(', ')}, then Chrome and Edge in their default locations). Nothing was proved. Install Chrome or Edge, or set CSP_CHECK_BROWSER to its path.`;
    if (process.env['CSP_CHECK_REQUIRE_BROWSER'] !== undefined) {
      console.error(message);
      return 1;
    }
    console.warn(message);
    return 0;
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'csp-check-data-'));
  const engine = startEngine(root, dataDir);
  let browser;
  try {
    // The launch URL is `http://127.0.0.1:<port>/#t=<token>`; each page is opened with the token.
    const launch = new URL(await engine.url);
    browser = await launchBrowser(executable);
    console.log(`browser   ${browser.product} (${executable})`);
    console.log(
      `viewport  ${String(VIEWPORT.width)}x${String(VIEWPORT.height)}`,
    );
    let failed = 0;
    for (const page of PAGES) {
      const url = new URL(page.path, launch);
      url.hash = launch.hash;
      const report = await measure(
        browser,
        url.href,
        join(root, 'dist', 'csp-check'),
        page.name,
        page.expectShell,
      );
      const failures = judge(report, { expectShell: page.expectShell });
      console.log(`--- ${page.name} (${page.path})`);
      console.log(
        `shell     display=${String(report.shell?.display)} columns=[${(report.shell?.columns ?? []).join(' ')}] activity.x=${String(report.shell?.activity?.x)} main.x=${String(report.shell?.main?.x)}`,
      );
      console.log(
        `scroll    scrollWidth=${String(report.scrollWidth)} clientWidth=${String(report.clientWidth)}`,
      );
      console.log(
        `nonce     meta=${String(report.metaNonce)} root=${String(report.nonceOfRoot)} style elements=${String(report.styleElements)}`,
      );
      console.log(
        `reports   ${String(report.violations.length)} CSP / Trusted Types`,
      );
      for (const line of report.consoleErrors) console.log(`other     ${line}`);
      for (const failure of failures) console.error(`FAIL      ${failure}`);
      failed += failures.length;
    }
    if (failed === 0) console.log('csp-check passed');
    return failed === 0 ? 0 : 1;
  } finally {
    await browser?.close();
    if (engine.child.connected)
      engine.child.send({ t: 'shutdown', deadlineMs: 2000 });
    await sleep(500);
    engine.child.kill();
    await sleep(300);
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // The engine may still release the file; the OS temp cleaner takes it.
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  run(root).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
