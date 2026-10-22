// A minimal Chrome DevTools Protocol driver on Node's built-in WebSocket: no Playwright, no puppeteer, no new
// dependency. It is the TypeScript form of `tools/web-csp-check/cdp.mjs` (the browser search, the headless launch
// with a throw-away profile, `send` / `onEvent`), kept in step with it by hand because a test project does not
// import a tool script. The browser is looked for in the same environment variables and default locations.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/** Environment variables that name a browser binary, first match wins (the same list as web-csp-check). */
export const BROWSER_ENV = [
  'CSP_CHECK_BROWSER',
  'PERF_BROWSER',
  'CSP_SPIKE_BROWSER',
] as const;

const CANDIDATES: Readonly<Record<string, readonly string[]>> = {
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
 * The browser binary to use, or `undefined` (the caller says so loudly and never reports green). A set variable
 * whose path does not exist means "no browser", not a fall-through. The parameters let a test steer the search.
 */
export function findBrowser(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: string = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
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
      for (const dir of (env.PATH ?? '').split(delimiter)) {
        if (dir !== '' && exists(join(dir, candidate)))
          return join(dir, candidate);
      }
    }
  }
  return undefined;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** One DevTools event. */
export interface CdpEvent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId?: string;
}

interface Waiter {
  readonly method: string;
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
}

export class Connection {
  readonly #socket: WebSocket;
  #nextId = 1;
  readonly #pending = new Map<number, Waiter>();
  readonly #listeners: ((event: CdpEvent) => void)[] = [];

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        error?: { message: string };
        result?: Record<string, unknown>;
        method?: string;
        params?: Record<string, unknown>;
        sessionId?: string;
      };
      if (message.id !== undefined) {
        const waiter = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error !== undefined) {
          waiter?.reject(
            new Error(`${waiter.method}: ${message.error.message}`),
          );
        } else {
          waiter?.resolve(message.result ?? {});
        }
      } else if (message.method !== undefined) {
        const cdpEvent: CdpEvent = {
          method: message.method,
          params: message.params ?? {},
          ...(message.sessionId === undefined
            ? {}
            : { sessionId: message.sessionId }),
        };
        for (const listener of this.#listeners) listener(cdpEvent);
      }
    });
  }

  static async open(url: string): Promise<Connection> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => {
        resolve();
      });
      socket.addEventListener('error', () => {
        reject(new Error(`cannot connect to ${url}`));
      });
    });
    return new Connection(socket);
  }

  /** Sends a command; it answers within `timeoutMs` or the run fails loudly instead of hanging. */
  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 60_000,
  ): Promise<Record<string, unknown>> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new Error(
            `${method}: no answer from the browser after ${String(timeoutMs / 1000)} s`,
          ),
        );
      }, timeoutMs);
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

  onEvent(listener: (event: CdpEvent) => void): void {
    this.#listeners.push(listener);
  }

  close(): void {
    this.#socket.close();
  }
}

export interface Browser {
  readonly executable: string;
  /** For example `Chrome/155.0.8059.85`. */
  readonly product: string;
  readonly connection: Connection;
  close(): Promise<void>;
}

/** Starts `executable` headless with a throw-away profile; the returned object closes both again. */
export async function launchBrowser(executable: string): Promise<Browser> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'perf-browser-profile-'));
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
    // A hidden or backgrounded page would throttle timers and frames and distort every figure.
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-gpu',
    'about:blank',
  ];
  if (process.env.CI !== undefined) args.push('--no-sandbox');
  const child = spawn(executable, args, { stdio: 'ignore' });
  const portFile = join(userDataDir, 'DevToolsActivePort');
  let lines: string[] | undefined;
  for (let attempt = 0; attempt < 200 && lines === undefined; attempt++) {
    await sleep(100);
    if (existsSync(portFile))
      lines = readFileSync(portFile, 'utf8').split('\n');
  }
  if (lines?.[0] === undefined || lines[1] === undefined) {
    child.kill();
    throw new Error(`${executable} did not open a DevTools port`);
  }
  const connection = await Connection.open(
    `ws://127.0.0.1:${lines[0]}${lines[1]}`,
  );
  const version = await connection.send('Browser.getVersion');
  return {
    executable,
    product: String(version.product),
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
