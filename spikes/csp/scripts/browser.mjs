// Minimal Chrome DevTools Protocol driver on Node's built-in WebSocket: no Playwright, no
// puppeteer, no new dependency. It launches a headless Chromium-family browser, opens a page,
// and collects what Chrome itself reports about CSP and Trusted Types (Audits issues, console
// and log entries of the page and of its dedicated workers) next to the page's own probe data.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const CANDIDATES = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'microsoft-edge',
  ],
};

export function findBrowser() {
  const fromEnv = process.env['CSP_SPIKE_BROWSER'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  for (const candidate of CANDIDATES[process.platform] ?? []) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (existsSync(candidate)) return candidate;
    } else {
      for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
        if (dir !== '' && existsSync(join(dir, candidate)))
          return join(dir, candidate);
      }
    }
  }
  throw new Error(
    'No Chromium-family browser found. Install Chrome or Edge, or set CSP_SPIKE_BROWSER to its path.',
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Connection {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #listeners = [];

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const waiter = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error !== undefined)
          waiter?.reject(
            new Error(`${waiter.method}: ${message.error.message}`),
          );
        else waiter?.resolve(message.result);
      } else {
        for (const listener of this.#listeners) listener(message);
      }
    });
  }

  static async open(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener(
        'error',
        () => reject(new Error(`cannot connect to ${url}`)),
        { once: true },
      );
    });
    return new Connection(socket);
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      // Every command answers within seconds or the run fails loudly instead of hanging.
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method}: no answer from the browser after 30 s`));
      }, 30000);
      this.#pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  onEvent(listener) {
    this.#listeners.push(listener);
  }

  close() {
    this.#socket.close();
  }
}

export async function launchBrowser() {
  const executable = findBrowser();
  const userDataDir = mkdtempSync(join(tmpdir(), 'csp-spike-profile-'));
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-component-update',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-gpu',
    'about:blank',
  ];
  if (process.env['CI'] !== undefined) args.push('--no-sandbox');
  const child = spawn(executable, args, { stdio: 'ignore' });
  const portFile = join(userDataDir, 'DevToolsActivePort');
  let lines;
  for (let attempt = 0; attempt < 200 && lines === undefined; attempt++) {
    await sleep(100);
    if (existsSync(portFile))
      lines = readFileSync(portFile, 'utf8').split('\n');
  }
  if (lines === undefined) {
    child.kill();
    throw new Error(`${executable} did not open a DevTools port`);
  }
  const connection = await Connection.open(
    `ws://127.0.0.1:${lines[0]}${lines[1]}`,
  );
  const version = await connection.send('Browser.getVersion');
  return {
    executable,
    product: version.product,
    userAgent: version.userAgent,
    connection,
    async close() {
      connection.close();
      child.kill();
      await sleep(300);
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // Chrome may still hold the profile on Windows; the OS temp cleaner takes it.
      }
    },
  };
}

const CSP_TEXT =
  /Content Security Policy|Trusted ?Types|TrustedHTML|TrustedScript|TrustedScriptURL|Refused to/i;

/**
 * Opens `url`, waits for `window.__spike.done`, and returns the probe data plus what the browser
 * reported about CSP and Trusted Types.
 */
export async function loadPage(
  browser,
  url,
  { timeoutMs = 45000, probeSource = undefined, settleMs = undefined } = {},
) {
  const { connection } = browser;
  const { targetId } = await connection.send('Target.createTarget', {
    url: 'about:blank',
  });
  const { sessionId } = await connection.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  const messages = [];
  const workers = [];
  const record = (scope, text) => {
    if (CSP_TEXT.test(text))
      messages.push(`${scope}: ${text.replaceAll(/\s+/g, ' ').slice(0, 300)}`);
  };

  connection.onEvent((event) => {
    const { method, params } = event;
    if (method === 'Log.entryAdded') {
      const scope = event.sessionId === sessionId ? 'page' : 'worker';
      record(scope, params.entry.text);
    } else if (method === 'Runtime.exceptionThrown') {
      const scope = event.sessionId === sessionId ? 'page' : 'worker';
      record(
        scope,
        params.exceptionDetails.exception?.description ??
          params.exceptionDetails.text,
      );
    } else if (method === 'Runtime.consoleAPICalled') {
      const scope = event.sessionId === sessionId ? 'page' : 'worker';
      record(
        scope,
        params.args
          .map((arg) => String(arg.value ?? arg.description ?? ''))
          .join(' '),
      );
    } else if (method === 'Target.attachedToTarget') {
      const info = params.targetInfo;
      workers.push(
        `${info.type}:${info.url.split('/').slice(3).join('/').slice(0, 80)}`,
      );
      const child = params.sessionId;
      void Promise.all([
        connection.send('Log.enable', {}, child),
        connection.send('Runtime.enable', {}, child),
      ])
        .then(() =>
          connection.send('Runtime.runIfWaitingForDebugger', {}, child),
        )
        .catch(() => undefined);
    }
  });

  await connection.send('Page.enable', {}, sessionId);
  await connection.send('Runtime.enable', {}, sessionId);
  await connection.send('Log.enable', {}, sessionId);
  await connection.send(
    'Target.setAutoAttach',
    { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
    sessionId,
  );
  if (probeSource !== undefined) {
    // For pages that do not load probe.js themselves (the Angular shell).
    await connection.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: probeSource },
      sessionId,
    );
  }
  await connection.send('Page.navigate', { url }, sessionId);

  // A renderer stuck in a loop never answers; give up on it instead of hanging the whole run.
  const evaluate = async (expression) => {
    const answer = connection
      .send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)
      .catch(() => undefined);
    const result = await Promise.race([
      answer,
      sleep(8000).then(() => undefined),
    ]);
    return result?.result.value;
  };
  const started = Date.now();
  let done = false;
  if (settleMs === undefined) {
    while (!done && Date.now() - started < timeoutMs) {
      await sleep(150);
      done = (await evaluate('window.__spike?.done === true')) === true;
    }
  } else {
    await sleep(settleMs);
    done = true;
  }
  await sleep(250);
  const spikeJson = await evaluate('JSON.stringify(window.__spike ?? null)');
  const rootChildren = await evaluate(
    'document.querySelector("app-root")?.childElementCount ?? -1',
  );
  await connection
    .send('Target.closeTarget', { targetId })
    .catch(() => undefined);
  return {
    timedOut: !done,
    appRootChildren: rootChildren,
    spike:
      spikeJson === null || spikeJson === undefined
        ? null
        : JSON.parse(spikeJson),
    messages,
    targets: workers,
  };
}
