import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DataKeyRecord } from '@app/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDataKeyVault, type DataKeyVault } from './dek.ts';
import { SecretsError } from './errors.ts';
import {
  createMemoryDataKeyRepository,
  createMemoryKeyring,
  type MemoryDataKeyRepository,
} from './testing.ts';
import type { KeyWrap } from './types.ts';
import { createCtlDeliveredWrap } from './wraps/ctl-delivered.ts';
import { createFileKekWrap } from './wraps/file-kek.ts';
import { createKeyringWrap } from './wraps/keyring.ts';
import { createPassphraseWrap } from './wraps/passphrase.ts';

const COST = { N: 2 ** 14, r: 8, p: 1 } as const;
const PASSPHRASE = 'correct horse battery staple';
const text = (value: string) => new TextEncoder().encode(value);
const read = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

let directory: string;
let kekPath: string;
let otherKekPath: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'vault-'));
  kekPath = join(directory, 'kek');
  otherKekPath = join(directory, 'other-kek');
  await writeFile(kekPath, randomBytes(32));
  await writeFile(otherKekPath, randomBytes(32));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** Random bytes the test can see, so it can search storage for the data key it made. */
function recordingRandom() {
  const produced: Uint8Array[] = [];
  return {
    produced,
    randomBytes: (size: number) => {
      const bytes = new Uint8Array(randomBytes(size));
      produced.push(new Uint8Array(bytes));
      return bytes;
    },
  };
}

function holds(haystack: Uint8Array, needle: Uint8Array): boolean {
  return Buffer.from(haystack).includes(Buffer.from(needle));
}

function everyStoredByte(
  repository: MemoryDataKeyRepository,
  keyring?: { dump(): readonly Uint8Array[] },
): Uint8Array[] {
  return [
    ...repository
      .dump()
      .flatMap((row) => [row.wrapped, text(row.wrapParamsJson), text(row.id)]),
    ...(keyring?.dump() ?? []),
  ];
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

async function failure(work: Promise<unknown>): Promise<SecretsError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(SecretsError);
    return error as SecretsError;
  }
  throw new Error('expected a SecretsError');
}

function vaultOf(
  repository: MemoryDataKeyRepository,
  wraps: KeyWrap[],
  extra: Partial<Parameters<typeof createDataKeyVault>[0]> = {},
): DataKeyVault {
  return createDataKeyVault({ repository, wraps, ...extra });
}

describe('AC-2 a Linux keyring that reports basic_text or none', () => {
  for (const kind of ['basic_text', 'none', 'unknown'] as const) {
    it(`AC-2 ${kind}: requiresMasterPassword is true and no DEK is stored unwrapped`, async () => {
      const repository = createMemoryDataKeyRepository();
      const keyring = createMemoryKeyring(kind);
      const random = recordingRandom();
      const vault = vaultOf(
        repository,
        [
          createKeyringWrap({ backend: keyring }),
          createPassphraseWrap({ cost: COST }),
        ],
        { randomBytes: random.randomBytes },
      );

      const before = await vault.open();
      expect(vault.requiresMasterPassword()).toBe(true);
      expect(before).toEqual({
        state: 'locked',
        wrapKind: 'passphrase',
        needs: 'passphrase',
      });
      // Not even a row yet: a key made now could not be wrapped.
      expect(repository.dump()).toHaveLength(0);
      expect(keyring.dump()).toHaveLength(0);
      expect(random.produced).toHaveLength(0);

      const after = await vault.open({ passphrase: PASSPHRASE });
      expect(after.state).toBe('unlocked');
      expect(vault.requiresMasterPassword()).toBe(true);
      const [row] = repository.dump();
      expect(row?.wrapKind).toBe('passphrase');
      // The only 32-byte random value the vault drew for a key is the DEK; it is nowhere in storage.
      const dek = random.produced.find((bytes) => bytes.byteLength === 32);
      expect(dek).toBeDefined();
      for (const stored of everyStoredByte(repository, keyring)) {
        expect(holds(stored, must(dek))).toBe(false);
      }
      expect(keyring.dump()).toHaveLength(0);
    });
  }

  it('AC-2 with no master-password wrap configured, nothing is created and the cipher refuses', async () => {
    const repository = createMemoryDataKeyRepository();
    const vault = vaultOf(repository, [
      createKeyringWrap({ backend: createMemoryKeyring('basic_text') }),
    ]);
    const status = await vault.open();
    expect(status).toEqual({
      state: 'unavailable',
      reason: 'keyring:keyring-basic_text',
    });
    expect(vault.requiresMasterPassword()).toBe(true);
    expect(repository.dump()).toHaveLength(0);
    expect(
      (await failure(vault.fields.seal('t', 'c', 'r', text('v')))).code,
    ).toBe('VAULT_LOCKED');
  });

  it('a keyring with a real secret store does not ask for a master password and keeps the KEK, not the DEK', async () => {
    const repository = createMemoryDataKeyRepository();
    const keyring = createMemoryKeyring('secret-service');
    const random = recordingRandom();
    const vault = vaultOf(
      repository,
      [
        createKeyringWrap({ backend: keyring }),
        createPassphraseWrap({ cost: COST }),
      ],
      { randomBytes: random.randomBytes },
    );
    const status = await vault.open();
    expect(status.state).toBe('unlocked');
    expect(vault.requiresMasterPassword()).toBe(false);
    expect(repository.dump()[0]?.wrapKind).toBe('keyring');
    expect(keyring.dump()).toHaveLength(1);
    const dek = random.produced.find((bytes) => bytes.byteLength === 32);
    for (const stored of everyStoredByte(repository, keyring)) {
      expect(holds(stored, must(dek))).toBe(false);
    }
  });

  it('before open has run, requiresMasterPassword answers true', () => {
    const vault = vaultOf(createMemoryDataKeyRepository(), [
      createKeyringWrap({ backend: createMemoryKeyring() }),
    ]);
    expect(vault.requiresMasterPassword()).toBe(true);
    expect(vault.status()).toEqual({ state: 'closed' });
  });
});

describe('the vault with each wrap', () => {
  it('file KEK: creates a key, seals, and a restarted process opens the same data', async () => {
    const repository = createMemoryDataKeyRepository();
    const first = vaultOf(repository, [createFileKekWrap({ path: kekPath })]);
    expect((await first.open()).state).toBe('unlocked');
    const sealed = await first.fields.seal(
      'profiles',
      'password',
      'p1',
      text('s3cret'),
    );

    const second = vaultOf(repository, [createFileKekWrap({ path: kekPath })]);
    expect((await second.open()).state).toBe('unlocked');
    expect(repository.dump()).toHaveLength(1);
    expect(
      read(await second.fields.open('profiles', 'password', 'p1', sealed)),
    ).toBe('s3cret');
    expect(second.requiresMasterPassword()).toBe(false);
  });

  it('passphrase: asks first, unlocks with it, and a restart needs it again', async () => {
    const repository = createMemoryDataKeyRepository();
    const first = vaultOf(repository, [createPassphraseWrap({ cost: COST })]);
    await first.open({ passphrase: PASSPHRASE });
    const sealed = await first.fields.seal('t', 'c', 'r', text('value'));

    const second = vaultOf(repository, [createPassphraseWrap({ cost: COST })]);
    expect(await second.open()).toEqual({
      state: 'locked',
      wrapKind: 'passphrase',
      needs: 'passphrase',
    });
    expect(
      (await failure(second.fields.open('t', 'c', 'r', sealed))).code,
    ).toBe('VAULT_LOCKED');
    await second.open({ passphrase: PASSPHRASE });
    expect(read(await second.fields.open('t', 'c', 'r', sealed))).toBe('value');
  });

  it('desktop: waits for main to deliver the key, stores only a check value, and checks the key on restart', async () => {
    const repository = createMemoryDataKeyRepository();
    const dek = new Uint8Array(randomBytes(32));
    const first = vaultOf(repository, [createCtlDeliveredWrap()]);
    expect(await first.open()).toEqual({
      state: 'locked',
      wrapKind: 'ctl-delivered',
      needs: 'dek',
    });
    expect(repository.dump()).toHaveLength(0);
    await first.open({ dek });
    const sealed = await first.fields.seal('t', 'c', 'r', text('v'));
    expect(repository.dump()[0]?.wrapKind).toBe('ctl-delivered');
    for (const stored of everyStoredByte(repository)) {
      expect(holds(stored, dek)).toBe(false);
    }

    const restarted = vaultOf(repository, [createCtlDeliveredWrap()]);
    await restarted.open({ dek });
    expect(read(await restarted.fields.open('t', 'c', 'r', sealed))).toBe('v');
  });

  it('desktop: a different delivered key is refused and replaces nothing', async () => {
    const repository = createMemoryDataKeyRepository();
    const dek = new Uint8Array(randomBytes(32));
    await vaultOf(repository, [createCtlDeliveredWrap()]).open({ dek });
    const [before] = repository.dump();

    const impostor = vaultOf(repository, [createCtlDeliveredWrap()]);
    const error = await failure(
      impostor.open({ dek: new Uint8Array(randomBytes(32)) }),
    );
    expect(error.code).toBe('UNWRAP_FAILED');
    expect(repository.dump()).toEqual([before]);
    expect(impostor.status().state).not.toBe('unlocked');
    expect(
      (
        await failure(
          vaultOf(repository, [createCtlDeliveredWrap()]).open({
            dek: new Uint8Array(16),
          }),
        )
      ).code,
    ).toBe('INVALID_INPUT');
  });
});

describe('a stored key is never replaced', () => {
  it('a wrong passphrase is refused, retryable, and leaves the one row alone', async () => {
    const repository = createMemoryDataKeyRepository();
    const first = vaultOf(repository, [createPassphraseWrap({ cost: COST })]);
    await first.open({ passphrase: PASSPHRASE });
    const sealed = await first.fields.seal('t', 'c', 'r', text('keep me'));
    const [before] = repository.dump();

    const second = vaultOf(repository, [createPassphraseWrap({ cost: COST })]);
    const error = await failure(
      second.open({ passphrase: 'not the passphrase' }),
    );
    expect(error.code).toBe('UNWRAP_FAILED');
    expect(error.retryable).toBe(true);
    expect(repository.dump()).toEqual([before]);
    expect(
      (await failure(second.fields.seal('t', 'c', 'r', text('v')))).code,
    ).toBe('VAULT_LOCKED');

    await second.open({ passphrase: PASSPHRASE });
    expect(read(await second.fields.open('t', 'c', 'r', sealed))).toBe(
      'keep me',
    );
  });

  it('a different KEK file is told apart from damage and creates nothing', async () => {
    const repository = createMemoryDataKeyRepository();
    await vaultOf(repository, [createFileKekWrap({ path: kekPath })]).open();
    const [before] = repository.dump();
    const error = await failure(
      vaultOf(repository, [createFileKekWrap({ path: otherKekPath })]).open(),
    );
    expect(error.code).toBe('KEK_MISMATCH');
    expect(repository.dump()).toEqual([before]);
  });

  it('a missing or unreadable KEK file makes the vault unavailable, not empty', async () => {
    const repository = createMemoryDataKeyRepository();
    await vaultOf(repository, [createFileKekWrap({ path: kekPath })]).open();
    const gone = vaultOf(repository, [
      createFileKekWrap({ path: join(directory, 'missing') }),
    ]);
    expect(await gone.open()).toEqual({
      state: 'unavailable',
      reason: 'kek-invalid',
    });
    expect(repository.dump()).toHaveLength(1);
  });

  it('a key wrapped by a kind this process was not configured with is refused and replaces nothing', async () => {
    const repository = createMemoryDataKeyRepository();
    await vaultOf(repository, [createPassphraseWrap({ cost: COST })]).open({
      passphrase: PASSPHRASE,
    });
    const error = await failure(
      vaultOf(repository, [createFileKekWrap({ path: kekPath })]).open(),
    );
    expect(error.code).toBe('WRAP_NOT_CONFIGURED');
    expect(repository.dump()).toHaveLength(1);
  });

  it('a keyring that lost its entry refuses, and a basic_text keyring on the same store does not create a new key', async () => {
    const repository = createMemoryDataKeyRepository();
    const keyring = createMemoryKeyring();
    await vaultOf(repository, [createKeyringWrap({ backend: keyring })]).open();
    const empty = createMemoryKeyring();
    expect(
      (
        await failure(
          vaultOf(repository, [createKeyringWrap({ backend: empty })]).open(),
        )
      ).code,
    ).toBe('UNWRAP_FAILED');
    const insecure = vaultOf(repository, [
      createKeyringWrap({ backend: createMemoryKeyring('basic_text') }),
    ]);
    expect((await insecure.open()).state).toBe('unavailable');
    expect(repository.dump()).toHaveLength(1);
  });
});

describe('opening is safe to repeat and to race', () => {
  it('two opens of one vault create one key', async () => {
    const repository = createMemoryDataKeyRepository();
    const vault = vaultOf(repository, [createFileKekWrap({ path: kekPath })]);
    await Promise.all([vault.open(), vault.open(), vault.open()]);
    expect(repository.dump()).toHaveLength(1);
  });

  it('two processes starting together end with one active key that both can use', async () => {
    const repository = createMemoryDataKeyRepository();
    const a = vaultOf(repository, [createFileKekWrap({ path: kekPath })]);
    const b = vaultOf(repository, [createFileKekWrap({ path: kekPath })]);
    await Promise.all([a.open(), b.open()]);
    expect(
      repository.dump().filter((row) => row.state === 'active'),
    ).toHaveLength(1);
    const sealed = await a.fields.seal('t', 'c', 'r', text('shared'));
    expect(read(await b.fields.open('t', 'c', 'r', sealed))).toBe('shared');
  });

  it('lock forgets the keys and open unlocks again', async () => {
    const vault = vaultOf(createMemoryDataKeyRepository(), [
      createFileKekWrap({ path: kekPath }),
    ]);
    await vault.open();
    const sealed = await vault.fields.seal('t', 'c', 'r', text('v'));
    vault.lock();
    expect(vault.status()).toEqual({
      state: 'locked',
      wrapKind: 'file-kek',
      needs: 'nothing',
    });
    expect((await failure(vault.fields.open('t', 'c', 'r', sealed))).code).toBe(
      'VAULT_LOCKED',
    );
    expect(
      (await failure(vault.payloads.encrypt(text('v'), 'a:b:c'))).code,
    ).toBe('VAULT_LOCKED');
    await vault.open();
    expect(read(await vault.fields.open('t', 'c', 'r', sealed))).toBe('v');
  });
});

describe('locking while the vault is opening', () => {
  it('the lock wins: the keys that were being unwrapped are dropped, not committed', async () => {
    const repository = createMemoryDataKeyRepository();
    const wrap = createFileKekWrap({ path: kekPath });
    await vaultOf(repository, [wrap]).open();

    // A wrap that parks inside `unwrap` until the test lets it go.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const slow: KeyWrap = {
      ...wrap,
      async unwrap(wrapped, binding, input) {
        reached();
        await gate;
        return wrap.unwrap(wrapped, binding, input);
      },
    };
    const vault = vaultOf(repository, [slow]);

    const opening = vault.open();
    const outcome = failure(opening);
    await inside;
    vault.lock();
    release();

    expect((await outcome).code).toBe('VAULT_LOCKED');
    expect(vault.status().state).toBe('locked');
    expect(
      (await failure(vault.fields.seal('t', 'c', 'r', text('v')))).code,
    ).toBe('VAULT_LOCKED');

    // A later open, with nothing in the way, unlocks.
    release();
    expect((await vault.open()).state).toBe('unlocked');
  });
});

describe('retired keys', () => {
  it('values sealed under a retired key still open, and new ones use the active key', async () => {
    const repository = createMemoryDataKeyRepository();
    const wrap = createFileKekWrap({ path: kekPath });
    const first = vaultOf(repository, [wrap]);
    await first.open();
    const oldValue = await first.fields.seal('t', 'c', 'r', text('old'));
    const [oldRecord] = repository.dump() as [DataKeyRecord];

    // A rotation as the future rewrap job will do it: a new key is inserted, the old one retired.
    await repository.retire(oldRecord.id, 2);
    const newId = 'c'.repeat(32);
    const dek = new Uint8Array(randomBytes(32));
    const wrapped = await wrap.wrap(dek, { purpose: 'main', dekId: newId });
    expect(
      await repository.insert({
        id: newId,
        purpose: 'main',
        wrapKind: 'file-kek',
        wrapParamsJson: JSON.stringify(wrapped.params),
        wrapped: wrapped.bytes,
        state: 'active',
        createdAt: 3,
        retiredAt: null,
      }),
    ).toBe(true);

    const second = vaultOf(repository, [wrap]);
    const status = await second.open();
    expect(status).toMatchObject({ state: 'unlocked', keyId: newId });
    expect(read(await second.fields.open('t', 'c', 'r', oldValue))).toBe('old');
    const fresh = await second.fields.seal('t', 'c', 'r', text('new'));
    expect(Buffer.from(fresh.subarray(1, 17)).toString('hex')).toBe(newId);
  });

  it('the store allows one active key per purpose', async () => {
    const repository = createMemoryDataKeyRepository();
    await vaultOf(repository, [createFileKekWrap({ path: kekPath })]).open();
    const [active] = repository.dump() as [DataKeyRecord];
    expect(await repository.insert({ ...active, id: 'd'.repeat(32) })).toBe(
      false,
    );
    expect(await repository.insert({ ...active })).toBe(false);
  });
});

describe('a damaged or edited key record', () => {
  async function stored(wraps: KeyWrap[], input?: { passphrase: string }) {
    const repository = createMemoryDataKeyRepository();
    await vaultOf(repository, wraps).open(input);
    return { repository, record: must(repository.dump()[0]) };
  }

  async function replaced(
    repository: MemoryDataKeyRepository,
    record: DataKeyRecord,
    patch: Partial<DataKeyRecord>,
  ) {
    const copy = createMemoryDataKeyRepository();
    await copy.insert({ ...record, ...patch });
    return copy;
  }

  it('a wrapped key copied under another id does not open', async () => {
    const { repository, record } = await stored([
      createFileKekWrap({ path: kekPath }),
    ]);
    const moved = await replaced(repository, record, { id: 'e'.repeat(32) });
    const error = await failure(
      vaultOf(moved, [createFileKekWrap({ path: kekPath })]).open(),
    );
    expect(error.code).toBe('UNWRAP_FAILED');
  });

  it('a wrapped key under another purpose does not open', async () => {
    const { repository, record } = await stored([
      createFileKekWrap({ path: kekPath }),
    ]);
    const moved = await replaced(repository, record, { purpose: 'captures' });
    const error = await failure(
      vaultOf(moved, [createFileKekWrap({ path: kekPath })], {
        purpose: 'captures',
      }).open(),
    );
    expect(error.code).toBe('UNWRAP_FAILED');
  });

  for (const [name, patch] of [
    [
      'truncated bytes',
      (r: DataKeyRecord) => ({ wrapped: r.wrapped.subarray(0, 30) }),
    ],
    [
      'flipped bytes',
      (r: DataKeyRecord) => ({
        wrapped: Uint8Array.from(r.wrapped, (b, i) => (i === 40 ? b ^ 1 : b)),
      }),
    ],
    ['params that are not JSON', () => ({ wrapParamsJson: '{nope' })],
    ['params that are an array', () => ({ wrapParamsJson: '[1]' })],
    [
      'params with an object value',
      () => ({ wrapParamsJson: '{"kekCheck":{}}' }),
    ],
    [
      'params too large',
      () => ({ wrapParamsJson: JSON.stringify({ x: 'y'.repeat(5000) }) }),
    ],
  ] as const) {
    it(`refuses a record with ${name}`, async () => {
      const { repository, record } = await stored([
        createFileKekWrap({ path: kekPath }),
      ]);
      const edited = await replaced(repository, record, patch(record));
      const error = await failure(
        vaultOf(edited, [createFileKekWrap({ path: kekPath })]).open(),
      );
      expect(['UNWRAP_FAILED', 'KEK_MISMATCH']).toContain(error.code);
    });
  }

  it('refuses a passphrase record that asks for a gigantic scrypt cost, without allocating it', async () => {
    const { repository, record } = await stored(
      [createPassphraseWrap({ cost: COST })],
      { passphrase: PASSPHRASE },
    );
    const params = JSON.parse(record.wrapParamsJson) as Record<string, unknown>;
    for (const patch of [
      { N: 2 ** 30 },
      { N: 2 ** 20, r: 16 },
      { N: 2 ** 21, r: 1 },
      { N: 1000 },
      { N: 2 ** 10 },
      { r: 0 },
      { p: 99 },
      { kdf: 'argon2id' },
      { salt: 'AAAA' },
    ]) {
      const edited = await replaced(repository, record, {
        wrapParamsJson: JSON.stringify({ ...params, ...patch }),
      });
      const started = Date.now();
      const error = await failure(
        vaultOf(edited, [createPassphraseWrap({ cost: COST })]).open({
          passphrase: PASSPHRASE,
        }),
      );
      expect(error.code).toBe('UNWRAP_FAILED');
      expect(Date.now() - started).toBeLessThan(2000);
    }
  });

  it('a store with no active key is refused rather than extended', async () => {
    const { repository, record } = await stored([
      createFileKekWrap({ path: kekPath }),
    ]);
    await repository.retire(record.id, 5);
    const error = await failure(
      vaultOf(repository, [createFileKekWrap({ path: kekPath })]).open(),
    );
    expect(error.code).toBe('UNWRAP_FAILED');
    expect(repository.dump()).toHaveLength(1);
  });
});

describe('no secret in an error', () => {
  it('names neither the passphrase, a key, nor the KEK path', async () => {
    const repository = createMemoryDataKeyRepository();
    const random = recordingRandom();
    const wrongPassphrase = 'wrong passphrase value 123';
    await vaultOf(repository, [createPassphraseWrap({ cost: COST })], {
      randomBytes: random.randomBytes,
    }).open({ passphrase: PASSPHRASE });
    const dek = Buffer.from(must(random.produced[0])).toString('hex');

    const errors = [
      await failure(
        vaultOf(repository, [createPassphraseWrap({ cost: COST })]).open({
          passphrase: wrongPassphrase,
        }),
      ),
      await failure(
        vaultOf(repository, [
          createFileKekWrap({ path: join(directory, 'missing-kek') }),
        ]).open(),
      ),
      await failure(
        vaultOf(createMemoryDataKeyRepository(), [
          createPassphraseWrap({ cost: COST }),
        ]).open({ passphrase: 'short' }),
      ),
    ];
    for (const error of errors) {
      const everything = `${error.message}${String(error.stack)}${JSON.stringify(error)}`;
      expect(everything).not.toContain(wrongPassphrase);
      expect(everything).not.toContain(PASSPHRASE);
      expect(everything).not.toContain(dek);
      expect(everything).not.toContain('missing-kek');
    }
  });
});
