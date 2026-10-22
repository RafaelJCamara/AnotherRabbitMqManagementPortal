// The pure side of the local web mode: where it binds, which token it uses, which public origins it
// accepts, and what the container banner says. Nothing here opens a file or a socket.
import { describe, expect, it } from 'vitest';

import { parseArgs, UsageError } from '../entry/args.ts';
import { readEnvConfig } from '../entry/env.ts';
import { ModeRefusedError } from './types.ts';
import {
  containerNotice,
  launchUrl,
  resolveWebBinding,
} from './web-binding.ts';

const TOKEN = 'A'.repeat(20) + 'b'.repeat(20);
const native = (...flags: string[]) =>
  parseArgs(['--mode=local', '--data-dir=/d', ...flags]);
const container = (
  flags: string[] = [],
  env: Record<string, string> = {},
  readFile?: (path: string) => string,
) =>
  resolveWebBinding(
    parseArgs(['--mode=local', ...flags]),
    readEnvConfig({ APP_RUNTIME: 'container', ...env }, readFile),
    readFile,
  );

const refusal = (work: () => unknown): Error => {
  try {
    work();
  } catch (error) {
    return error as Error;
  }
  throw new Error('did not throw');
};

describe('native binding', () => {
  it('M0-59 AC-1 binds 127.0.0.1 on a system-picked port, opens no browser, makes its own token', () => {
    const binding = resolveWebBinding(native());

    expect(binding).toMatchObject({
      runtime: 'native',
      host: '127.0.0.1',
      port: 0,
      publicOrigins: [],
      open: false,
      dataDir: '/d',
    });
    expect(binding.token.source).toBe('generated');
    expect(binding.token.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(resolveWebBinding(native()).token.value).not.toBe(
      binding.token.value,
    );
  });

  it('M0-59 AC-1 accepts the loopback spellings, and only them', () => {
    expect(resolveWebBinding(native('--host=127.0.0.1')).host).toBe(
      '127.0.0.1',
    );
    expect(resolveWebBinding(native('--host=localhost')).host).toBe(
      '127.0.0.1',
    );
    expect(resolveWebBinding(native('--host=::1')).host).toBe('::1');
    expect(resolveWebBinding(native('--host=[::1]')).host).toBe('::1');
  });

  it('M0-59 AC-2 refuses every other host with guidance, and does not echo it', () => {
    for (const host of [
      '0.0.0.0',
      '::',
      '[::]',
      '192.168.1.20',
      '10.0.0.5',
      'example.com',
      '127.0.0.2',
      'LOCALHOST.example.com',
    ]) {
      const error = refusal(() => resolveWebBinding(native(`--host=${host}`)));

      expect(error).toBeInstanceOf(ModeRefusedError);
      expect(error.message).toContain('SSH tunnel');
      expect(error.message).toContain('container');
      expect(error.message).toContain('127.0.0.1');
      expect(error.message).not.toContain(host);
    }
  });

  it('M0-59 AC-2 a host from the environment is held to the same rule', () => {
    const error = refusal(() =>
      resolveWebBinding(native(), readEnvConfig({ APP_HOST: '0.0.0.0' })),
    );

    expect(error).toBeInstanceOf(ModeRefusedError);
  });

  it('M0-59 AC-5 --open asks for a browser, --no-open and nothing do not', () => {
    expect(resolveWebBinding(native('--open')).open).toBe(true);
    expect(resolveWebBinding(native('--no-open')).open).toBe(false);
    expect(resolveWebBinding(native()).open).toBe(false);
  });

  it('keeps needing a data directory outside the container', () => {
    expect(() => resolveWebBinding(parseArgs(['--mode=local']))).toThrow(
      UsageError,
    );
  });

  it('M0-59 AC-1 a flag wins over the variable', () => {
    const binding = resolveWebBinding(
      parseArgs(['--mode=local', '--port=7', '--data-dir=/flag']),
      readEnvConfig({ APP_PORT: '9', APP_DATA_DIR: '/env' }),
    );

    expect(binding).toMatchObject({ port: 7, dataDir: '/flag' });
  });
});

describe('the launch token', () => {
  it('M0-59 AC-4 --token-file supplies it, a trailing newline is dropped', () => {
    const binding = resolveWebBinding(
      native('--token-file=/run/secrets/t'),
      {},
      () => `${TOKEN}\n`,
    );

    expect(binding.token).toEqual({ value: TOKEN, source: 'file' });
  });

  it('M0-59 AC-4 a bad file is a usage error that names the flag and prints neither path nor content', () => {
    for (const content of ['short', `${TOKEN}!`, 'x'.repeat(513), '']) {
      const error = refusal(() =>
        resolveWebBinding(
          native('--token-file=/secret/place/t'),
          {},
          () => content,
        ),
      );

      expect(error).toBeInstanceOf(UsageError);
      expect(error.message).toContain('--token-file');
      expect(error.message).not.toContain('/secret/place');
      expect(error.message).not.toContain(content === '' ? '\u0000' : content);
    }
    const unreadable = refusal(() =>
      resolveWebBinding(native('--token-file=/secret/place/t'), {}, () => {
        throw new Error('ENOENT /secret/place/t');
      }),
    );

    expect(unreadable).toBeInstanceOf(UsageError);
    expect(unreadable.message).toContain('--token-file');
    expect(unreadable.message).not.toContain('/secret/place');
  });

  it('M0-59 AC-7 APP_TOKEN and APP_TOKEN_FILE supply it; the flag wins; a weak one is refused without being printed', () => {
    const files: Record<string, string> = {
      '/run/secrets/env-file': `${TOKEN}\n`,
      '/run/secrets/flag-file': 'F'.repeat(40),
    };
    const readFile = (path: string): string => files[path] ?? '';

    expect(container([], { APP_TOKEN: TOKEN }, readFile).token).toEqual({
      value: TOKEN,
      source: 'env',
    });
    expect(
      container([], { APP_TOKEN_FILE: '/run/secrets/env-file' }, readFile).token
        .value,
    ).toBe(TOKEN);
    expect(
      container(
        ['--token-file=/run/secrets/flag-file'],
        { APP_TOKEN: TOKEN },
        readFile,
      ).token,
    ).toEqual({ value: 'F'.repeat(40), source: 'file' });
    const weak = refusal(() => container([], { APP_TOKEN: 'hunter2' }));
    expect(weak).toBeInstanceOf(UsageError);
    expect(weak.message).toContain('APP_TOKEN');
    expect(weak.message).not.toContain('hunter2');
  });
});

describe('container binding (ADR-016)', () => {
  it('M0-59 AC-7 listens on 0.0.0.0:8765 with data in /data and a token it made', () => {
    const binding = container();

    expect(binding).toMatchObject({
      runtime: 'container',
      host: '0.0.0.0',
      port: 8765,
      dataDir: '/data',
      open: false,
    });
    expect(binding.token.source).toBe('generated');
  });

  it('M0-59 AC-7 the port, the data directory and the key file come from flags or variables', () => {
    const binding = container([], {
      APP_PORT: '9000',
      APP_DATA_DIR: '/vol',
      APP_KEK_PATH: '/run/secrets/kek',
      APP_UI_DIR: '/ui',
    });

    expect(binding).toMatchObject({
      port: 9000,
      dataDir: '/vol',
      kekFile: '/run/secrets/kek',
      uiDir: '/ui',
    });
    expect(
      container(['--port=1', '--data-dir=/x'], { APP_PORT: '9' }),
    ).toMatchObject({
      port: 1,
      dataDir: '/x',
    });
  });

  it('M0-59 AC-7 refuses --open, and a host that names the LAN', () => {
    expect(refusal(() => container(['--open']))).toBeInstanceOf(UsageError);
    expect(refusal(() => container(['--host=192.168.1.5']))).toBeInstanceOf(
      ModeRefusedError,
    );
    expect(container(['--host=::']).host).toBe('::');
    expect(container(['--host=127.0.0.1']).host).toBe('127.0.0.1');
  });

  it('M0-59 AC-7 a runtime other than native or container is a usage error that names the variable', () => {
    const error = refusal(() => readEnvConfig({ APP_RUNTIME: 'cloud9' }));

    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain('runtime');
    expect(error.message).not.toContain('cloud9');
  });

  it('M0-59 AC-7 an unknown APP_ variable is a usage error, because a misspelt setting must not be ignored', () => {
    const error = refusal(() => readEnvConfig({ APP_PUBLIC_ORIGINS: 'x' }));

    expect(error).toBeInstanceOf(UsageError);
  });
});

describe('public origins (A-12)', () => {
  it('M0-59 AC-9 accepts loopback-form origins, exactly spelled', () => {
    expect(
      container(['--public-origin=http://127.0.0.1:9000']).publicOrigins,
    ).toEqual(['http://127.0.0.1:9000']);
    expect(
      container([], {
        APP_PUBLIC_ORIGIN:
          'http://localhost:9000, http://[::1]:9001,http://localhost:9000',
      }).publicOrigins,
    ).toEqual(['http://localhost:9000', 'http://[::1]:9001']);
  });

  it('M0-59 AC-9 refuses an origin outside loopback with guidance, whatever the scheme', () => {
    for (const origin of [
      'https://portal.example.com',
      'http://192.168.1.5:8765',
      'https://127.0.0.1.evil.example',
    ]) {
      const error = refusal(() => container([`--public-origin=${origin}`]));

      expect(error).toBeInstanceOf(ModeRefusedError);
      expect(error.message).toContain('authentication');
      expect(error.message).toContain('https');
      expect(error.message).toContain('SSH tunnel');
      expect(error.message).not.toContain('example.com');
    }
  });

  it('M0-59 AC-9 refuses what is not a plain origin', () => {
    for (const origin of [
      'http://127.0.0.1:9000/',
      'http://127.0.0.1:9000/path',
      'http://user:pw@127.0.0.1:9000',
      'ftp://127.0.0.1',
      'localhost:9000',
      'http://127.0.0.1:80',
      '*',
      ',',
    ]) {
      expect(
        refusal(() => container([`--public-origin=${origin}`])),
        origin,
      ).toBeInstanceOf(UsageError);
    }
    expect(
      refusal(() =>
        container([
          `--public-origin=${Array.from({ length: 9 }, (_, i) => `http://127.0.0.1:${String(9000 + i)}`).join(',')}`,
        ]),
      ),
    ).toBeInstanceOf(UsageError);
  });
});

describe('what a person is shown', () => {
  const address = { host: '0.0.0.0', port: 8765 };

  it('M0-59 AC-10 the banner prints the loopback publish line, the forbidden publishes and the vault note', () => {
    const binding = container();

    const text = containerNotice(binding, address).join('\n');

    expect(text).toContain('docker run -p 127.0.0.1:8765:8765');
    expect(text).toContain('-p 8765:8765');
    expect(text).toContain('-p 0.0.0.0:');
    expect(text).toContain('--network host');
    expect(text).toContain('APP_KEK_PATH');
    expect(text).not.toContain(binding.token.value);
  });

  it('M0-59 AC-10 the host port comes from the public origin, the inside port from the bind', () => {
    const remapped = container(['--public-origin=http://127.0.0.1:9000']);

    expect(containerNotice(remapped, address).join('\n')).toContain(
      'docker run -p 127.0.0.1:9000:8765',
    );
    expect(launchUrl(remapped, address)).toBe(
      `http://127.0.0.1:9000/#t=${remapped.token.value}`,
    );
    expect(
      containerNotice(container([], { APP_KEK_PATH: '/k', APP_PORT: '7777' }), {
        port: 7777,
      }).join('\n'),
    ).toContain('docker run -p 127.0.0.1:7777:7777');
  });

  it('M0-59 AC-10 without a public origin the URL uses the bound port on 127.0.0.1; native prints the bound address, bracketed for IPv6', () => {
    const binding = container();

    expect(launchUrl(binding, address)).toBe(
      `http://127.0.0.1:8765/#t=${binding.token.value}`,
    );
    const v4 = resolveWebBinding(native());
    expect(launchUrl(v4, { host: '127.0.0.1', port: 4310 })).toBe(
      `http://127.0.0.1:4310/#t=${v4.token.value}`,
    );
    const v6 = resolveWebBinding(native('--host=::1'));
    expect(launchUrl(v6, { host: '::1', port: 4310 })).toBe(
      `http://[::1]:4310/#t=${v6.token.value}`,
    );
  });

  it('M0-59 AC-10 says where the token came from, never the token', () => {
    const fromEnv = container([], { APP_TOKEN: TOKEN });

    const text = containerNotice(fromEnv, address).join('\n');

    expect(text).toContain('docker inspect');
    expect(text).not.toContain(TOKEN);
  });
});
