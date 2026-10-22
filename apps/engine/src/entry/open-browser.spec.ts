import { readdirSync } from 'node:fs';
import { readFile, readdir, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createBrowserOpener,
  openerCommand,
  openerEnv,
  type ExitSource,
  type OpenerChild,
  type OpenerDeps,
} from './open-browser.ts';

const TOKEN = 'k'.repeat(43);
const URL_WITH_TOKEN = `http://127.0.0.1:4310/#t=${TOKEN}`;

const roots: string[] = [];
async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'engine-open-'));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of roots.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

interface Call {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

/** A process-like emitter that remembers its 'exit' listeners and can fire them. */
function fakeProcess(): ExitSource & {
  listeners: () => number;
  end: () => void;
} {
  const listeners = new Set<() => void>();
  return {
    once(_event, listener) {
      listeners.add(listener);
      return this;
    },
    removeListener(_event, listener) {
      listeners.delete(listener);
      return this;
    },
    listeners: () => listeners.size,
    end() {
      for (const listener of [...listeners]) {
        listeners.delete(listener);
        listener();
      }
    },
  };
}

function fakes(outcome: 'spawn' | 'error') {
  const calls: Call[] = [];
  const timers: { work: () => void; ms: number }[] = [];
  const exit = fakeProcess();
  let unref = 0;
  const spawn: OpenerDeps['spawn'] = (command, args, options) => {
    calls.push({ command, args, env: options.env });
    const child: OpenerChild = {
      once(event, listener) {
        if (event === outcome) queueMicrotask(listener);
        return child;
      },
      unref() {
        unref += 1;
      },
    };
    return child;
  };
  return {
    calls,
    timers,
    unrefs: () => unref,
    exit,
    deps: {
      spawn,
      exit,
      later: (work: () => void, ms: number) => {
        timers.push({ work, ms });
      },
    },
  };
}

describe('the browser opener', () => {
  it('M0-59 AC-6 passes the platform opener a file path, never the URL or the token', async () => {
    const tempRoot = await root();
    const fake = fakes('spawn');

    await createBrowserOpener({ ...fake.deps, tempRoot, platform: 'linux' })(
      URL_WITH_TOKEN,
    );

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    const argv = [call?.command ?? '', ...(call?.args ?? [])].join(' ');
    expect(call?.command).toBe('xdg-open');
    expect(argv).not.toContain(TOKEN);
    expect(argv).not.toContain('127.0.0.1');
    expect(argv).toContain(join(tempRoot, 'app-open-'));
    expect(fake.unrefs()).toBe(1);
  });

  it('M0-59 AC-6 the file redirects to the URL, fragment intact, and lives in a directory of its own', async () => {
    const tempRoot = await root();
    const fake = fakes('spawn');

    await createBrowserOpener({ ...fake.deps, tempRoot })(URL_WITH_TOKEN);

    const [folder] = await readdir(tempRoot);
    expect(folder).toMatch(/^app-open-/);
    const page = await readFile(
      join(tempRoot, folder ?? '', 'open.html'),
      'utf8',
    );
    expect(page).toContain(`content="0;url=${URL_WITH_TOKEN}"`);
    expect(page).toContain(`href="${URL_WITH_TOKEN}"`);
  });

  it('M0-59 AC-6 escapes what it writes, so a URL cannot break out of the attribute', async () => {
    const tempRoot = await root();

    await createBrowserOpener({ ...fakes('spawn').deps, tempRoot })(
      'http://127.0.0.1/#t="><script>x</script>',
    );

    const [folder] = await readdir(tempRoot);
    const page = await readFile(
      join(tempRoot, folder ?? '', 'open.html'),
      'utf8',
    );
    expect(page).not.toContain('<script>');
    expect(page).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('M0-59 AC-6 removes the file after the delay, and a delay is scheduled', async () => {
    const tempRoot = await root();
    const fake = fakes('spawn');

    await createBrowserOpener({ ...fake.deps, tempRoot, cleanupMs: 1234 })(
      URL_WITH_TOKEN,
    );

    expect(fake.timers.map((timer) => timer.ms)).toEqual([1234]);
    expect(await readdir(tempRoot)).toHaveLength(1);
    fake.timers[0]?.work();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it('SEC-N7 the redirect file is removed synchronously when the process exits inside the delay', async () => {
    const tempRoot = await root();
    const fake = fakes('spawn');

    await createBrowserOpener({ ...fake.deps, tempRoot })(URL_WITH_TOKEN);
    expect(await readdir(tempRoot)).toHaveLength(1);
    expect(fake.exit.listeners()).toBe(1);

    // The timer never ran: only the process ending removes the directory, and it must do so
    // before `end()` returns (an 'exit' listener cannot wait for anything).
    fake.exit.end();
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it('SEC-N7 the exit listener is dropped once the timed removal ran, so none piles up', async () => {
    const tempRoot = await root();
    const fake = fakes('spawn');

    await createBrowserOpener({ ...fake.deps, tempRoot })(URL_WITH_TOKEN);
    fake.timers[0]?.work();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fake.exit.listeners()).toBe(0);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it('SEC-N7 a failed spawn also drops the exit listener', async () => {
    const tempRoot = await root();
    const fake = fakes('error');

    await createBrowserOpener({ ...fake.deps, tempRoot })(URL_WITH_TOKEN).catch(
      () => undefined,
    );

    expect(fake.exit.listeners()).toBe(0);
  });

  it('SEC-N8 the opener gets a copy of the environment without any APP_* or secret variable', async () => {
    const tempRoot = await root();
    const fake = fakes('spawn');
    const env = {
      PATH: '/usr/bin',
      HOME: '/home/a',
      DISPLAY: ':0',
      APP_TOKEN: TOKEN,
      APP_TOKEN_FILE: '/run/secrets/t',
      app_data_dir: '/data',
      APP_KEK_PATH: '/k',
      ENGINE_TOKEN: TOKEN,
      DB_PASSWORD: 'x',
      TOKENIZER_HOME: '/keep',
    };

    await createBrowserOpener({ ...fake.deps, tempRoot, env })(URL_WITH_TOKEN);

    expect(fake.calls[0]?.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/a',
      DISPLAY: ':0',
      TOKENIZER_HOME: '/keep',
    });
    // The engine's own environment is untouched: the copy is what loses the names.
    expect(env.APP_TOKEN).toBe(TOKEN);
  });

  it('SEC-N8 openerEnv keeps the Windows system variables the opener needs', () => {
    expect(
      openerEnv({ SystemRoot: 'C:\\Windows', Path: 'C:\\x', APP_TOKEN: TOKEN }),
    ).toEqual({ SystemRoot: 'C:\\Windows', Path: 'C:\\x' });
  });

  it('SEC-N8 on Windows the opener is the system rundll32.exe by full path, whatever the search path holds', async () => {
    const tempRoot = await root();
    const fake = fakes('spawn');

    await createBrowserOpener({
      ...fake.deps,
      tempRoot,
      platform: 'win32',
      env: { SYSTEMROOT: 'D:\\WinNT', Path: 'C:\\evil' },
    })(URL_WITH_TOKEN);

    expect(fake.calls[0]?.command).toBe('D:\\WinNT\\System32\\rundll32.exe');
    expect(openerCommand('win32', 'f', {}).command).toBe(
      'C:\\Windows\\System32\\rundll32.exe',
    );
  });

  it('M0-59 AC-6 a failed spawn rejects without the token, and removes the file at once', async () => {
    const tempRoot = await root();
    const fake = fakes('error');

    const failure = await createBrowserOpener({ ...fake.deps, tempRoot })(
      URL_WITH_TOKEN,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain(TOKEN);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it('M0-59 AC-6 picks the opener of each platform', () => {
    expect(
      openerCommand('win32', 'C:\\t\\open.html', { SystemRoot: 'C:\\Windows' }),
    ).toEqual({
      command: 'C:\\Windows\\System32\\rundll32.exe',
      args: ['url.dll,FileProtocolHandler', 'C:\\t\\open.html'],
    });
    expect(openerCommand('darwin', '/t/open.html')).toEqual({
      command: 'open',
      args: ['/t/open.html'],
    });
    expect(openerCommand('freebsd', '/t/open.html').command).toBe('xdg-open');
  });
});
