// M1-23 slice E3 (OQ-1455): the provider config store. Two things are proved here: the in-memory fake
// passes the contract suite that the SQLite and Postgres repositories of `persistence` pass
// (`@app/ports/testing`), and `createProviderConfigStore` applies
// `ProviderConfigSchema` on every read and write so a damaged or foreign row is one fixed refusal.
import {
  CREDENTIAL_PROVIDER_MAX_CONFIG_BYTES,
  type CredentialProviderStore,
} from '@app/ports';
import { credentialProviderStoreContract } from '@app/ports/testing';
import { describe, expect, it } from 'vitest';

import { ProviderConfigSchema } from './provider';
import { createProviderConfigStore } from './provider-store';
import { createInMemoryCredentialProviderStore } from './testing';

const CLIENT_CREDENTIALS = {
  kind: 'client-credentials',
  endpoint: 'https://idp.example/oauth/token',
  clientId: 'engine',
  scope: 'rabbitmq.read:*/*',
  usernameClaims: ['sub'],
};

const TOKEN_COMMAND = {
  kind: 'token-command',
  file: '/usr/local/bin/mint-token',
  args: ['--audience', 'rabbitmq'],
  timeoutMs: 10_000,
  maxStdoutBytes: 16_384,
  usernameClaims: ['sub'],
};

// The suite that the SQLite and Postgres stores of `persistence` pass too (`@app/ports/testing`).
credentialProviderStoreContract({
  name: 'in-memory fake of svc-identity',
  open: () => {
    let clock = 0;
    let current = createInMemoryCredentialProviderStore(() => clock);
    // `plantRaw` of the fake is on the fake itself, so the harness keeps the typed handle.
    return Promise.resolve({
      get store() {
        return current;
      },
      setClock: (ms: number) => {
        clock = ms;
        return true;
      },
      plantRaw: (
        connectionId: string,
        protocol: 'http' | 'amqp',
        text: string,
      ) => {
        current.plantRaw(connectionId, protocol, text);
        return Promise.resolve();
      },
      reset: () => {
        current = createInMemoryCredentialProviderStore(() => clock);
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    });
  },
});

describe('M1-23 slice E provider store: what only the fake does', () => {
  it('is bounded (I-6): a full fake refuses a new key, still replaces an old one, and the bound is 256 KiB', async () => {
    const store = createInMemoryCredentialProviderStore();
    expect(CREDENTIAL_PROVIDER_MAX_CONFIG_BYTES).toBe(262_144);
    for (let i = 0; i < 2048; i += 1) {
      await store.put(`c${String(i)}`, 'amqp', { n: i });
      await store.put(`c${String(i)}`, 'http', { n: i });
    }

    await expect(store.put('one-more', 'amqp', {})).rejects.toThrow(RangeError);
    await store.put('c0', 'amqp', { n: 'replaced' });

    expect(await store.get('c0', 'amqp')).toMatchObject({
      record: { config: { n: 'replaced' } },
    });
    expect(await store.get('one-more', 'amqp')).toEqual({ kind: 'absent' });
  });

  it('drops the rows of a deleted connection and no other', async () => {
    const store = createInMemoryCredentialProviderStore();
    await store.put('c1', 'amqp', TOKEN_COMMAND);
    await store.put('c1', 'http', TOKEN_COMMAND);
    await store.put('c2', 'amqp', TOKEN_COMMAND);

    store.deleteConnection('c1');

    expect((await store.get('c1', 'amqp')).kind).toBe('absent');
    expect((await store.get('c1', 'http')).kind).toBe('absent');
    expect((await store.get('c2', 'amqp')).kind).toBe('found');
  });
});

describe('M1-23 slice E provider store: the config is validated on every read and write', () => {
  const setup = () => {
    const raw = createInMemoryCredentialProviderStore(() => 7);
    return { raw, store: createProviderConfigStore(raw) };
  };

  it('returns the config the schema returns, with its defaults filled in', async () => {
    const { store } = setup();

    const saved = await store.put('c1', 'amqp', {
      kind: 'token-command',
      file: '/usr/local/bin/mint-token',
    });
    const read = await store.get('c1', 'amqp');

    expect(saved).toEqual({
      kind: 'saved',
      config: ProviderConfigSchema.parse({
        kind: 'token-command',
        file: '/usr/local/bin/mint-token',
      }),
    });
    expect(read).toMatchObject({
      kind: 'found',
      updatedAt: 7,
      config: {
        kind: 'token-command',
        args: [],
        timeoutMs: 10_000,
        maxStdoutBytes: 16_384,
      },
    });
  });

  it.each([
    ['password', { kind: 'password' }],
    ['client-credentials', CLIENT_CREDENTIALS],
    ['static-token', { kind: 'static-token' }],
    ['token-command', TOKEN_COMMAND],
    ['x509-external', { kind: 'x509-external' }],
  ])('round-trips the %s kind', async (kind, input) => {
    const { store } = setup();

    const saved = await store.put('c1', 'amqp', input);
    const read = await store.get('c1', 'amqp');

    expect(saved.kind).toBe('saved');
    expect(read).toMatchObject({ kind: 'found', config: { kind } });
    expect(read.kind === 'found' && read.config).toEqual(
      ProviderConfigSchema.parse(input),
    );
  });

  it('reads an absent row as absent', async () => {
    const { store } = setup();

    expect(await store.get('c1', 'amqp')).toEqual({ kind: 'absent' });
  });

  it.each([
    ['an unknown kind', { kind: 'shell', command: 'rm -rf /' }],
    ['no kind', { endpoint: 'https://idp.example/token' }],
    ['a key the schema does not know', { kind: 'password', extra: 1 }],
    [
      'a client secret smuggled into the config',
      { ...CLIENT_CREDENTIALS, clientSecret: 'canary-secret-123' },
    ],
    [
      'a relative command path',
      { kind: 'token-command', file: 'bin/mint-token' },
    ],
    [
      'a plain http endpoint on a public host',
      { ...CLIENT_CREDENTIALS, endpoint: 'http://idp.example/token' },
    ],
    ['an array', [{ kind: 'password' }]],
    ['null', null],
    ['a string', 'password'],
  ])(
    'refuses %s on a write, stores nothing and repeats nothing',
    async (_label, input) => {
      const { raw, store } = setup();

      const result = await store.put('c1', 'amqp', input);

      expect(result).toEqual({ kind: 'invalid', reason: 'schema' });
      expect(JSON.stringify(result)).not.toContain('canary-secret');
      expect(await raw.get('c1', 'amqp')).toEqual({ kind: 'absent' });
    },
  );

  it.each([
    ['an unknown kind', { kind: 'shell', command: 'rm -rf /' }],
    ['a row from a newer version', { kind: 'password', v: 2 }],
    [
      'a command that is no longer an absolute path',
      { kind: 'token-command', file: 'mint-token' },
    ],
    ['a token command with no file', { kind: 'token-command' }],
    ['an empty object', {}],
    ['a JSON array', []],
    ['JSON null', null],
  ])(
    'reads %s as one fixed refusal, never as data and never a throw',
    async (_label, planted) => {
      const { raw, store } = setup();
      raw.plantRaw('c1', 'amqp', JSON.stringify(planted));

      const read = await store.get('c1', 'amqp');

      expect(read).toEqual({ kind: 'invalid', reason: 'schema' });
      expect(JSON.stringify(read)).not.toContain('rm -rf');
      expect(JSON.stringify(read)).not.toContain('mint-token');
    },
  );

  it('reads a row that is not JSON as the unreadable refusal', async () => {
    const { raw, store } = setup();
    raw.plantRaw('c1', 'amqp', '{"kind":"token-command","file":"/bin/x"');
    raw.plantRaw('c1', 'http', 'not json');

    expect(await store.get('c1', 'amqp')).toEqual({
      kind: 'invalid',
      reason: 'unreadable',
    });
    expect(await store.get('c1', 'http')).toEqual({
      kind: 'invalid',
      reason: 'unreadable',
    });
  });

  it('validates on the way out even when the store returns something the schema never saw', async () => {
    // A store that returns whatever it likes: the wrapper must not trust it.
    const hostile: CredentialProviderStore = {
      get: () =>
        Promise.resolve({
          kind: 'found',
          record: {
            connectionId: 'c1',
            protocol: 'amqp',
            config: { kind: 'token-command', file: '../../bin/sh' },
            updatedAt: 1,
          },
        }),
      put: () => Promise.resolve(),
      delete: () => Promise.resolve(false),
    };

    expect(await createProviderConfigStore(hostile).get('c1', 'amqp')).toEqual({
      kind: 'invalid',
      reason: 'schema',
    });
  });

  it('passes the validated copy, not the caller object, to the store', async () => {
    const seen: unknown[] = [];
    const spy: CredentialProviderStore = {
      get: () => Promise.resolve({ kind: 'absent' }),
      put: (_id, _protocol, config) => {
        seen.push(config);
        return Promise.resolve();
      },
      delete: () => Promise.resolve(false),
    };
    const input = { kind: 'password' };

    await createProviderConfigStore(spy).put('c1', 'amqp', input);

    expect(seen).toEqual([{ kind: 'password' }]);
    expect(seen[0]).not.toBe(input);
  });

  it('keeps the largest valid config the schema allows under the size bound of the store', async () => {
    // Three bytes per UTF-16 unit is the worst case of a BMP character; a quote costs two.
    const wide = '€'.repeat(1019);
    const biggest = ProviderConfigSchema.parse({
      kind: 'token-command',
      file: `/${wide}`,
      args: Array.from({ length: 32 }, () => wide + '"'.repeat(5)),
      usernameClaims: Array.from({ length: 8 }, () => '€'.repeat(64)),
    });
    const bytes = Buffer.byteLength(JSON.stringify(biggest), 'utf8');
    const { store } = setup();

    expect(bytes).toBeGreaterThan(90_000);
    expect(bytes).toBeLessThan(CREDENTIAL_PROVIDER_MAX_CONFIG_BYTES);
    expect(await store.put('c1', 'amqp', biggest)).toMatchObject({
      kind: 'saved',
    });
    expect((await store.get('c1', 'amqp')).kind).toBe('found');
  });

  it('deletes through to the store', async () => {
    const { store } = setup();
    await store.put('c1', 'amqp', { kind: 'password' });

    expect(await store.delete('c1', 'amqp')).toBe(true);
    expect(await store.delete('c1', 'amqp')).toBe(false);
    expect(await store.get('c1', 'amqp')).toEqual({ kind: 'absent' });
  });
});
