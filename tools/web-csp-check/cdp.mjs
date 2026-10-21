// A minimal Chrome DevTools Protocol driver on Node's built-in WebSocket: no Playwright, no
// puppeteer, no dependency. It finds a Chromium-family browser, starts it headless with a throw-away
// profile, and offers `send` / `onEvent`. Modelled on spikes/csp/scripts/browser.mjs (S-04), which
// is a spike and is not imported from here.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/** Environment variables that name a browser binary, first match wins. */
export const BROWSER_ENV = [
  'CSP_CHECK_BROWSER',
  'PERF_BROWSER',
  'CSP_SPIKE_BROWSER',
];

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

/**
 * The browser binary to use, or `undefined` (the caller says so loudly and never reports green).
 * `env` and `platform` are parameters so a test can steer the search.
 */
export function findBrowser(
  env = process.env,
  platform = process.platform,
  exists = existsSync,
) {
  for (const name of BROWSER_ENV) {
    const value = env[name];
    if (value !== undefined && value !== '') {
      return exists(value) ? value : undefined;
    }
  }
  for (const candidate of CANDIDATES[platform] ?? []) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (exists(candidate)) return candidate;
    } else {
      for (const dir of (env['PATH'] ?? '').split(delimiter)) {
        if (dir !== '' && exists(join(dir, candidate)))
          return join(dir, candidate);
      }
    }
  }
  return undefined;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Starts `executable` headless; the returned object closes it and its profile again. */
export async function launchBrowser(executable) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'csp-check-profile-'));
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
    connection,
    async close() {
      connection.close();
      child.kill();
      await sleep(300);
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // The browser may still hold the profile on Windows; the OS temp cleaner takes it.
      }
    },
  };
}
