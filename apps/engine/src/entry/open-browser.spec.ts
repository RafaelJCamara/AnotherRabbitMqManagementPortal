import { readFile, readdir, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createBrowserOpener,
  openerCommand,
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
}

function fakes(outcome: 'spawn' | 'error') {
  const calls: Call[] = [];
  const timers: { work: () => void; ms: number }[] = [];
  let unref = 0;
  const spawn: OpenerDeps['spawn'] = (command, args) => {
    calls.push({ command, args });
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
    deps: {
      spawn,
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
    expect(openerCommand('win32', 'C:\\t\\open.html')).toEqual({
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', 'C:\\t\\open.html'],
    });
    expect(openerCommand('darwin', '/t/open.html')).toEqual({
      command: 'open',
      args: ['/t/open.html'],
    });
    expect(openerCommand('freebsd', '/t/open.html').command).toBe('xdg-open');
  });
});
