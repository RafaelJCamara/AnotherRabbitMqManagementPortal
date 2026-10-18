import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ConfigError } from './errors.ts';
import { envVarName } from './layers.ts';
import { loadConfig } from './load-config.ts';

const Schema = z.strictObject({
  server: z
    .strictObject({
      bind: z.string().default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(8080),
      publicUrl: z.string().optional(),
      trustProxy: z.boolean().default(false),
    })
    .prefault({}),
  database: z
    .strictObject({
      url: z.string().optional(),
      poolMax: z.number().int().positive().default(10),
    })
    .prefault({}),
  egress: z
    .strictObject({
      allow: z.array(z.string()).default([]),
      denyPrivate: z.boolean().default(true),
    })
    .prefault({}),
  logging: z
    .strictObject({
      level: z.enum(['debug', 'info', 'warn']).default('info'),
    })
    .prefault({}),
});

/** An in-memory file system for the loader. */
function files(map: Record<string, string>) {
  return (path: string): string => {
    const content = map[path];
    if (content === undefined) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    }
    return content;
  };
}

/** The error a load throws, so a test can inspect its issues. */
function failure(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig: sources', () => {
  it('fills the defaults of the schema when no source is given', () => {
    expect(loadConfig(Schema, { env: {} })).toEqual({
      server: { bind: '127.0.0.1', port: 8080, trustProxy: false },
      database: { poolMax: 10 },
      egress: { allow: [], denyPrivate: true },
      logging: { level: 'info' },
    });
  });

  it('reads a YAML file and a JSON file', () => {
    const readFile = files({
      '/etc/app.yaml': 'server:\n  bind: 0.0.0.0\n  port: 9000\n',
      '/etc/app.json': '{"server": {"bind": "10.1.1.1", "port": 9001}}',
    });
    expect(
      loadConfig(Schema, { env: {}, file: '/etc/app.yaml', readFile }).server,
    ).toMatchObject({ bind: '0.0.0.0', port: 9000 });
    expect(
      loadConfig(Schema, { env: {}, file: '/etc/app.json', readFile }).server,
    ).toMatchObject({ bind: '10.1.1.1', port: 9001 });
  });

  it('accepts an empty file', () => {
    const readFile = files({ '/etc/app.yaml': '' });
    expect(
      loadConfig(Schema, { env: {}, file: '/etc/app.yaml', readFile }).server
        .port,
    ).toBe(8080);
  });

  it('reads PREFIX_SECTION__KEY variables, ignoring other variables', () => {
    const config = loadConfig(Schema, {
      env: {
        APP_SERVER__PUBLIC_URL: 'https://app.example',
        APP_DATABASE__POOL_MAX: '25',
        OTHER_SERVER__BIND: 'ignored',
        APPLE_PIE: 'ignored',
        PATH: '/usr/bin',
      },
    });
    expect(config.server.publicUrl).toBe('https://app.example');
    expect(config.database.poolMax).toBe(25);
    expect(config.server.bind).toBe('127.0.0.1');
  });

  it('uses another prefix when asked', () => {
    const config = loadConfig(Schema, {
      envPrefix: 'KERNEL_TEST',
      env: { KERNEL_TEST_SERVER__BIND: '::1', APP_SERVER__BIND: 'ignored' },
    });
    expect(config.server.bind).toBe('::1');
  });

  it('reads a value from the file named by a *_FILE variable and drops one trailing newline', () => {
    const readFile = files({
      '/run/secrets/db-url': 'postgres://db.internal/app\n',
      '/run/secrets/windows': 'value\r\n',
    });
    const config = loadConfig(Schema, {
      env: {
        APP_DATABASE__URL_FILE: '/run/secrets/db-url',
        APP_SERVER__PUBLIC_URL_FILE: '/run/secrets/windows',
      },
      readFile,
    });
    expect(config.database.url).toBe('postgres://db.internal/app');
    expect(config.server.publicUrl).toBe('value');
  });

  it('converts text from the environment to the type the schema wants', () => {
    const config = loadConfig(Schema, {
      env: {
        APP_SERVER__PORT: '9090',
        APP_SERVER__TRUST_PROXY: 'true',
        APP_EGRESS__DENY_PRIVATE: '0',
        APP_EGRESS__ALLOW: '["a.example","b.example"]',
        APP_DATABASE__POOL_MAX: ' 12 ',
      },
    });
    expect(config.server).toMatchObject({ port: 9090, trustProxy: true });
    expect(config.egress).toEqual({
      allow: ['a.example', 'b.example'],
      denyPrivate: false,
    });
    expect(config.database.poolMax).toBe(12);
  });

  it('converts text read from a file the same way', () => {
    const readFile = files({ '/run/secrets/port': '7000\n' });
    const config = loadConfig(Schema, {
      env: { APP_SERVER__PORT_FILE: '/run/secrets/port' },
      readFile,
    });
    expect(config.server.port).toBe(7000);
  });

  it('does not convert values of a file or of defaults: a wrong type there is an error', () => {
    const readFile = files({ '/etc/app.yaml': 'server:\n  port: "9000"\n' });
    expect(
      failure(() =>
        loadConfig(Schema, { env: {}, file: '/etc/app.yaml', readFile }),
      ).issues.map((issue) => issue.path),
    ).toEqual(['server.port']);
  });

  it('does not change the defaults object it is given', () => {
    const defaults = { server: { bind: '10.0.0.1' } };
    loadConfig(Schema, { env: { APP_SERVER__PORT: '81' }, defaults });
    expect(defaults).toEqual({ server: { bind: '10.0.0.1' } });
  });
});

describe('loadConfig: precedence', () => {
  const Key = z.strictObject({ key: z.string().optional() });
  const sources = ['default', 'file', 'envFile', 'env'] as const;

  it('environment beats *_FILE, which beats the file, which beats the defaults', () => {
    const readFile = files({
      '/etc/app.yaml': 'key: from-file\n',
      '/run/secret': 'from-env-file',
    });
    const load = (present: ReadonlySet<(typeof sources)[number]>) =>
      loadConfig(Key, {
        defaults: present.has('default') ? { key: 'from-default' } : {},
        ...(present.has('file') ? { file: '/etc/app.yaml' } : {}),
        env: {
          ...(present.has('envFile') ? { APP_KEY_FILE: '/run/secret' } : {}),
          ...(present.has('env') ? { APP_KEY: 'from-env' } : {}),
        },
        readFile,
      }).key;

    expect(load(new Set(['default', 'file', 'envFile', 'env']))).toBe(
      'from-env',
    );
    expect(load(new Set(['default', 'file', 'envFile']))).toBe('from-env-file');
    expect(load(new Set(['default', 'file']))).toBe('from-file');
    expect(load(new Set(['default']))).toBe('from-default');
    expect(load(new Set([]))).toBeUndefined();
  });

  it('property: the highest-precedence source that is present always wins', () => {
    const readFile = files({
      '/etc/app.yaml': 'key: from-file\n',
      '/run/secret': 'from-env-file',
    });
    const expectedBySource = {
      env: 'from-env',
      envFile: 'from-env-file',
      file: 'from-file',
      default: 'from-default',
    } as const;
    fc.assert(
      fc.property(
        fc.subarray([...sources], { minLength: 0, maxLength: 4 }),
        (present) => {
          const has = new Set(present);
          const winner = (['env', 'envFile', 'file', 'default'] as const).find(
            (source) => has.has(source),
          );
          const value = loadConfig(Key, {
            defaults: has.has('default') ? { key: 'from-default' } : {},
            ...(has.has('file') ? { file: '/etc/app.yaml' } : {}),
            env: {
              ...(has.has('envFile') ? { APP_KEY_FILE: '/run/secret' } : {}),
              ...(has.has('env') ? { APP_KEY: 'from-env' } : {}),
            },
            readFile,
          }).key;
          expect(value).toBe(
            winner === undefined ? undefined : expectedBySource[winner],
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it('merges sections key by key across sources', () => {
    const readFile = files({
      '/etc/app.yaml': 'server:\n  bind: 192.168.0.1\n  port: 1000\n',
    });
    const config = loadConfig(Schema, {
      file: '/etc/app.yaml',
      env: { APP_SERVER__PORT: '2000' },
      defaults: { server: { publicUrl: 'https://d.example' } },
      readFile,
    });
    expect(config.server).toEqual({
      bind: '192.168.0.1',
      port: 2000,
      publicUrl: 'https://d.example',
      trustProxy: false,
    });
  });
});

describe('loadConfig: unknown keys', () => {
  it('rejects an unknown key in the file, naming it', () => {
    const readFile = files({
      '/etc/app.yaml': 'server:\n  bnd: 0.0.0.0\nextra: 1\n',
    });
    const error = failure(() =>
      loadConfig(Schema, { env: {}, file: '/etc/app.yaml', readFile }),
    );
    expect(error.message).toContain('bnd');
    expect(error.message).toContain('extra');
  });

  it('rejects an unknown key in the environment, so a typo is not silently ignored', () => {
    const error = failure(() =>
      loadConfig(Schema, { env: { APP_SERVER__PROT: '1' } }),
    );
    expect(error.message).toContain('prot');
  });

  it('rejects an unknown key in the defaults', () => {
    expect(() =>
      loadConfig(Schema, { env: {}, defaults: { nope: true } }),
    ).toThrow(ConfigError);
  });

  it('rejects keys that a lenient schema would have stripped', () => {
    const Lenient = z.object({ a: z.object({ b: z.string().optional() }) });
    const error = failure(() =>
      loadConfig(Lenient, {
        env: {},
        defaults: { a: { b: 'x', c: 'y' }, d: 1 },
      }),
    );
    expect(error.issues.map((issue) => issue.path).sort()).toEqual([
      'a.c',
      'd',
    ]);
  });

  it('rejects keys that would change a prototype', () => {
    const readFile = files({
      '/etc/app.json': '{"server": {"constructor": {"x": 1}}}',
    });
    expect(() =>
      loadConfig(Schema, { env: {}, file: '/etc/app.json', readFile }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig(Schema, { env: { APP_SERVER__CONSTRUCTOR: 'x' } }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig(Schema, {
        env: {},
        defaults: JSON.parse('{"__proto__":{"a":1}}') as Record<
          string,
          unknown
        >,
      }),
    ).toThrow(ConfigError);
  });
});

describe('loadConfig: errors', () => {
  it('lists every problem with its path', () => {
    const error = failure(() =>
      loadConfig(Schema, {
        env: { APP_SERVER__PORT: '99999', APP_LOGGING__LEVEL: 'loud' },
      }),
    );
    expect(error.issues.map((issue) => issue.path).sort()).toEqual([
      'logging.level',
      'server.port',
    ]);
  });

  it('never prints a value, whatever is wrong with it', () => {
    const readFile = files({
      '/etc/bad.yaml':
        'server: [canary-yaml-secret\n  bind: canary-yaml-bind: x\n',
      '/etc/types.yaml':
        'database:\n  url: 12345\n  poolMax: canary-file-secret\n',
    });
    const attempts: (() => unknown)[] = [
      () => loadConfig(Schema, { env: { APP_LOGGING__LEVEL: 'canary-level' } }),
      () => loadConfig(Schema, { env: { APP_SERVER__PORT: 'canary-port' } }),
      () => loadConfig(Schema, { env: { APP_EGRESS__ALLOW: 'canary-list' } }),
      () => loadConfig(Schema, { env: {}, file: '/etc/bad.yaml', readFile }),
      () => loadConfig(Schema, { env: {}, file: '/etc/types.yaml', readFile }),
      () =>
        loadConfig(Schema, {
          env: { APP_DATABASE__URL_FILE: '/run/secrets/canary-missing' },
          readFile,
        }),
    ];
    for (const attempt of attempts) {
      const message = failure(attempt).message;
      expect(message).not.toContain('canary-');
    }
  });

  it('reports an unreadable *_FILE by variable name and error code, not by path', () => {
    const error = failure(() =>
      loadConfig(Schema, {
        env: { APP_DATABASE__URL_FILE: '/run/secrets/missing' },
        readFile: files({}),
      }),
    );
    expect(error.issues).toEqual([
      {
        path: 'database.url',
        message:
          'cannot read the file named by APP_DATABASE__URL_FILE (ENOENT).',
      },
    ]);
  });

  it('reports a missing or malformed config file', () => {
    const readFile = files({
      '/etc/list.yaml': '- a\n- b\n',
      '/etc/broken.yaml': 'server: {bind: [\n',
    });
    expect(
      failure(() =>
        loadConfig(Schema, { env: {}, file: '/etc/none.yaml', readFile }),
      ).message,
    ).toContain('cannot read the config file (ENOENT)');
    expect(
      failure(() =>
        loadConfig(Schema, { env: {}, file: '/etc/list.yaml', readFile }),
      ).message,
    ).toContain('object at the top level');
    expect(
      failure(() =>
        loadConfig(Schema, { env: {}, file: '/etc/broken.yaml', readFile }),
      ).message,
    ).toMatch(/not valid JSON or YAML at line \d+, column \d+/);
  });

  it('rejects malformed variable names and two variables for one key', () => {
    expect(() =>
      loadConfig(Schema, { env: { APP_server__bind: 'x' } }),
    ).toThrow(ConfigError);
    expect(() => loadConfig(Schema, { env: { APP_SERVER__: 'x' } })).toThrow(
      ConfigError,
    );
    expect(() =>
      loadConfig(Schema, {
        env: { APP_SERVER: 'x', APP_SERVER__BIND: 'y' },
      }),
    ).toThrow(/conflicts/);
  });
});

describe('envVarName', () => {
  it('derives the variable from the key path', () => {
    expect(envVarName('APP', ['server', 'publicUrl'])).toBe(
      'APP_SERVER__PUBLIC_URL',
    );
    expect(envVarName('APP', ['logging', 'level'])).toBe('APP_LOGGING__LEVEL');
  });

  it('property: setting the derived variable sets exactly that key', () => {
    const word = fc.stringMatching(/^[a-z]{1,6}(?:[A-Z][a-z]{1,5}){0,2}$/);
    const Anything = z.record(z.string(), z.record(z.string(), z.string()));
    fc.assert(
      fc.property(
        word,
        word,
        fc.string({ maxLength: 20 }),
        (section, key, value) => {
          const config = loadConfig(Anything, {
            env: { [envVarName('APP', [section, key])]: value },
          });
          expect(config).toEqual({ [section]: { [key]: value } });
        },
      ),
      { numRuns: 200 },
    );
  });
});
