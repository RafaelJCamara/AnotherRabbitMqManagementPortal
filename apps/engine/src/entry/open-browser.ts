// `--open`: open the default browser at the launch URL, without the token ever reaching a command
// line (I-10: argv is visible to every process of the machine). The URL is written to a private
// one-page redirect file in a fresh temporary directory and the platform opener is given that
// file's path; the browser reads the file and follows the redirect, and the fragment (the token)
// goes from the file to the address bar without passing through a process list. The file is removed
// after a short delay. The token is in no error either: a failure says only that no opener worked.
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** What the opener needs of a child process. */
export interface OpenerChild {
  once(event: 'spawn' | 'error', listener: () => void): unknown;
  unref(): void;
}

export interface OpenerDeps {
  readonly platform: NodeJS.Platform;
  readonly tempRoot: string;
  readonly spawn: (
    command: string,
    args: readonly string[],
    options: { readonly stdio: 'ignore'; readonly detached: true },
  ) => OpenerChild;
  /** Runs `work` after `ms`, without keeping the process alive. */
  readonly later: (work: () => void, ms: number) => void;
  readonly cleanupMs: number;
}

const defaults: OpenerDeps = {
  platform: process.platform,
  tempRoot: tmpdir(),
  spawn: (command, args, options) => nodeSpawn(command, [...args], options),
  later: (work, ms) => {
    setTimeout(work, ms).unref();
  },
  cleanupMs: 30_000,
};

/** The platform's "open this file with its default program" command. */
export function openerCommand(
  platform: NodeJS.Platform,
  file: string,
): { command: string; args: readonly string[] } {
  if (platform === 'win32') {
    return {
      command: 'rundll32.exe',
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
    // On Windows a just-written file can be held for a moment by a scanner or the indexer, so a
    // first delete answers EBUSY or EPERM; `maxRetries` retries exactly those codes. A failure to
    // delete is not reported: the temporary directory is the operating system's to sweep.
    const remove = (): Promise<void> =>
      rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      }).catch(() => undefined);
    deps.later(() => {
      void remove();
    }, deps.cleanupMs);
    try {
      const file = join(dir, 'open.html');
      await writeFile(file, redirectPage(url), { mode: 0o600 });
      const { command, args } = openerCommand(deps.platform, file);
      await new Promise<void>((resolve, reject) => {
        const child = deps.spawn(command, args, {
          stdio: 'ignore',
          detached: true,
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
