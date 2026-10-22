// `--open`: open the default browser at the launch URL, without the token ever reaching a command
// line (I-10: argv is visible to every process of the machine). The URL is written to a private
// one-page redirect file in a fresh temporary directory and the platform opener is given that
// file's path; the browser reads the file and follows the redirect, and the fragment (the token)
// goes from the file to the address bar without passing through a process list. The file is removed
// after a short delay, and at once when the process exits first (the timer does not keep the process
// alive, so an engine that stops within the delay would otherwise leave the token on disk). The
// opener runs with a copy of the environment that carries none of the engine's own variables, and on
// Windows it is the system's `rundll32.exe`, not whatever the search path finds first. The token is
// in no error either: a failure says only that no opener worked.
import { spawn as nodeSpawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';

/** What the opener needs of a child process. */
export interface OpenerChild {
  once(event: 'spawn' | 'error', listener: () => void): unknown;
  unref(): void;
}

/** The part of `process` the opener listens to: only its end. */
export interface ExitSource {
  once(event: 'exit', listener: () => void): unknown;
  removeListener(event: 'exit', listener: () => void): unknown;
}

export interface OpenerDeps {
  readonly platform: NodeJS.Platform;
  readonly tempRoot: string;
  readonly spawn: (
    command: string,
    args: readonly string[],
    options: {
      readonly stdio: 'ignore';
      readonly detached: true;
      readonly env: NodeJS.ProcessEnv;
    },
  ) => OpenerChild;
  /** Runs `work` after `ms`, without keeping the process alive. */
  readonly later: (work: () => void, ms: number) => void;
  readonly cleanupMs: number;
  /** The environment the opener starts from; the engine's own variables are removed from a copy. */
  readonly env: NodeJS.ProcessEnv;
  /** Where the redirect file is removed, synchronously, when the process ends before the delay. */
  readonly exit: ExitSource;
}

const defaults: OpenerDeps = {
  platform: process.platform,
  tempRoot: tmpdir(),
  spawn: (command, args, options) => nodeSpawn(command, [...args], options),
  later: (work, ms) => {
    setTimeout(work, ms).unref();
  },
  cleanupMs: 30_000,
  env: process.env,
  exit: process,
};

/** Environment names the engine owns (`APP_*`) or that name a secret: none reaches the opener. */
const ENGINE_OR_SECRET_NAME =
  /^APP_|(?:^|_)(?:TOKEN|SECRET|PASSWORD|KEK)(?:_|$)/i;

/** A copy of `env` without the engine's variables (`APP_TOKEN` and `APP_TOKEN_FILE` among them). */
export function openerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!ENGINE_OR_SECRET_NAME.test(name)) copy[name] = value;
  }
  return copy;
}

/** The Windows system directory, looked up without regard to case (`SystemRoot`, `SYSTEMROOT`). */
function systemRootOf(env: NodeJS.ProcessEnv): string {
  for (const [name, value] of Object.entries(env)) {
    if (name.toLowerCase() === 'systemroot' && value) return value;
  }
  return 'C:\\Windows';
}

/**
 * The platform's "open this file with its default program" command. On Windows it is the full path
 * of the system's `rundll32.exe`, so a planted copy earlier on the search path is never run.
 */
export function openerCommand(
  platform: NodeJS.Platform,
  file: string,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: readonly string[] } {
  if (platform === 'win32') {
    return {
      command: win32.join(systemRootOf(env), 'System32', 'rundll32.exe'),
      args: ['url.dll,FileProtocolHandler', file],
    };
  }
  if (platform === 'darwin') return { command: 'open', args: [file] };
  return { command: 'xdg-open', args: [file] };
}

const escapeHtml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

const redirectPage = (url: string): string =>
  `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${escapeHtml(url)}"><title>Opening</title><a href="${escapeHtml(url)}">Continue</a>\n`;

export function createBrowserOpener(
  overrides: Partial<OpenerDeps> = {},
): (url: string) => Promise<void> {
  const deps: OpenerDeps = { ...defaults, ...overrides };
  return async (url) => {
    const dir = await mkdtemp(join(deps.tempRoot, 'app-open-'));
    // The process may end inside the delay: remove the directory synchronously then (an 'exit'
    // listener can do nothing else). Dropped again once the timed removal has run.
    const onExit = (): void => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Nothing more can be done while exiting; the temporary directory is the system's to sweep.
      }
    };
    deps.exit.once('exit', onExit);
    // On Windows a just-written file can be held for a moment by a scanner or the indexer, so a
    // first delete answers EBUSY or EPERM; `maxRetries` retries exactly those codes. A failure to
    // delete is not reported: the temporary directory is the operating system's to sweep.
    const remove = (): Promise<void> =>
      rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      })
        .catch(() => undefined)
        .then(() => {
          deps.exit.removeListener('exit', onExit);
        });
    deps.later(() => {
      void remove();
    }, deps.cleanupMs);
    try {
      const file = join(dir, 'open.html');
      await writeFile(file, redirectPage(url), { mode: 0o600 });
      const { command, args } = openerCommand(deps.platform, file, deps.env);
      await new Promise<void>((resolve, reject) => {
        const child = deps.spawn(command, args, {
          stdio: 'ignore',
          detached: true,
          env: openerEnv(deps.env),
        });
        child.once('error', () => {
          reject(new Error('No program could open the browser.'));
        });
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      });
    } catch (error) {
      // Settled before the rejection, so a caller that sees the failure also sees the file gone.
      await remove();
      throw error;
    }
  };
}
