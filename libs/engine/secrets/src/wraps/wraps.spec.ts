import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SecretsError } from '../errors.ts';
import { createMemoryKeyring } from '../testing.ts';
import type { KeyWrap, WrapBinding } from '../types.ts';
import { createCtlDeliveredWrap } from './ctl-delivered.ts';
import { createFileKekWrap, parseKek } from './file-kek.ts';
import { createKeyringWrap, isProtectedKeyring } from './keyring.ts';
import {
  createPassphraseWrap,
  DEFAULT_SCRYPT_COST,
  MIN_PASSPHRASE_CHARS,
} from './passphrase.ts';

const binding: WrapBinding = { purpose: 'main', dekId: 'a'.repeat(32) };
const COST = { N: 2 ** 14, r: 8, p: 1 } as const;
const dekOf = () => new Uint8Array(randomBytes(32));

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'wraps-'));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function failure(work: Promise<unknown>): Promise<SecretsError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(SecretsError);
    return error as SecretsError;
  }
  throw new Error('expected a SecretsError');
}

async function roundTrip(
  wrap: KeyWrap,
  input?: Parameters<KeyWrap['wrap']>[2],
) {
  const dek = dekOf();
  const wrapped = await wrap.wrap(dek, binding, input);
  const back = await wrap.unwrap(wrapped, binding, input);
  return { dek, wrapped, back };
}

describe('file KEK wrap', () => {
  const raw = randomBytes(32);

  it('parses 32 raw bytes, 64 hex characters and base64, with surrounding whitespace', () => {
    expect(Buffer.from(parseKek(raw))).toEqual(raw);
    expect(
      Buffer.from(parseKek(Buffer.from(`${raw.toString('hex')}\n`))),
    ).toEqual(raw);
    expect(
      Buffer.from(parseKek(Buffer.from(`  ${raw.toString('base64')}\r\n`))),
    ).toEqual(raw);
    expect(
      Buffer.from(parseKek(Buffer.from(raw.toString('hex').toUpperCase()))),
    ).toEqual(raw);
  });

  it('refuses anything else', () => {
    for (const bad of [
      Buffer.alloc(0),
      Buffer.alloc(31),
      Buffer.alloc(33),
      Buffer.from('not a key'),
      Buffer.from('zz'.repeat(32)),
      // 31 and 33 characters: a text file of exactly 32 characters is 32 raw bytes, and is read as such.
      Buffer.from(randomBytes(16).toString('hex') + 'a'),
      Buffer.from(randomBytes(16).toString('hex').slice(1)),
      Buffer.from(randomBytes(30).toString('base64')),
    ]) {
      expect(() => parseKek(bad)).toThrow(SecretsError);
    }
  });

  it('wraps and unwraps through a file, and reads the file afresh each time', async () => {
    const path = join(directory, 'kek-1');
    await writeFile(path, raw);
    const wrap = createFileKekWrap({ path });
    const { dek, back } = await roundTrip(wrap);
    expect(Buffer.from(back)).toEqual(Buffer.from(dek));

    const wrapped = await wrap.wrap(dek, binding);
    await writeFile(path, randomBytes(32));
    expect((await failure(wrap.unwrap(wrapped, binding))).code).toBe(
      'KEK_MISMATCH',
    );
  });

  it('reports unavailable for a missing file, a directory, an oversized file and an all-zero key', async () => {
    const dir = join(directory, 'a-directory');
    await mkdir(dir);
    const big = join(directory, 'big');
    await writeFile(big, Buffer.alloc(5000, 1));
    const zero = join(directory, 'zero');
    await writeFile(zero, Buffer.alloc(32));
    for (const path of [join(directory, 'nope'), dir, big, zero]) {
      const wrap = createFileKekWrap({ path });
      expect(await wrap.status()).toEqual({
        state: 'unavailable',
        reason: 'kek-invalid',
      });
      expect((await failure(wrap.wrap(dekOf(), binding))).code).toBe(
        'KEK_INVALID',
      );
    }
  });

  it('does not put the path in the error', async () => {
    const wrap = createFileKekWrap({
      path: join(directory, 'secret-location'),
    });
    const error = await failure(wrap.wrap(dekOf(), binding));
    expect(error.cause).toBeUndefined();
    expect(error.message).toBe('the KEK file cannot be read (ENOENT)');
    expect(`${error.message}${String(error.stack)}`).not.toContain(
      'secret-location',
    );
  });

  it('a wrapped key does not open under another binding', async () => {
    const path = join(directory, 'kek-2');
    await writeFile(path, raw);
    const wrap = createFileKekWrap({ path });
    const wrapped = await wrap.wrap(dekOf(), binding);
    for (const other of [
      { ...binding, dekId: 'b'.repeat(32) },
      { ...binding, purpose: 'captures' },
    ]) {
      expect((await failure(wrap.unwrap(wrapped, other))).code).toBe(
        'UNWRAP_FAILED',
      );
    }
  });

  it('does not keep the DEK in what it returns', async () => {
    const path = join(directory, 'kek-3');
    await writeFile(path, raw);
    const { dek, wrapped } = await roundTrip(createFileKekWrap({ path }));
    expect(Buffer.from(wrapped.bytes).includes(Buffer.from(dek))).toBe(false);
    expect(JSON.stringify(wrapped.params)).not.toContain(
      Buffer.from(dek).toString('hex'),
    );
  });
});

describe('passphrase wrap', () => {
  const wrap = createPassphraseWrap({ cost: COST });
  const passphrase = 'correct horse battery staple';

  it('round-trips, with a fresh salt each time', async () => {
    const one = await roundTrip(wrap, { passphrase });
    const two = await roundTrip(wrap, { passphrase });
    expect(Buffer.from(one.back)).toEqual(Buffer.from(one.dek));
    expect(one.wrapped.params.salt).not.toBe(two.wrapped.params.salt);
    expect(one.wrapped.params).toMatchObject({ kdf: 'scrypt', ...COST });
  });

  it('reports needs-input until a passphrase is given', async () => {
    expect(await wrap.status()).toEqual({
      state: 'needs-input',
      input: 'passphrase',
    });
    expect(await wrap.status({ passphrase })).toEqual({ state: 'ready' });
    expect((await failure(wrap.wrap(dekOf(), binding))).code).toBe(
      'VAULT_LOCKED',
    );
  });

  it('refuses a short passphrase when creating, and counts characters, not bytes', async () => {
    const short = 'a'.repeat(MIN_PASSPHRASE_CHARS - 1);
    const error = await failure(
      wrap.wrap(dekOf(), binding, { passphrase: short }),
    );
    expect(error.code).toBe('WEAK_PASSPHRASE');
    expect(error.retryable).toBe(true);
    // Twelve emoji are twelve characters although they are 48 bytes.
    const emoji = '\u{1F510}'.repeat(MIN_PASSPHRASE_CHARS);
    expect((await roundTrip(wrap, { passphrase: emoji })).back.byteLength).toBe(
      32,
    );
    expect(
      (
        await failure(
          wrap.wrap(dekOf(), binding, { passphrase: '\u{1F510}'.repeat(5) }),
        )
      ).code,
    ).toBe('WEAK_PASSPHRASE');
  });

  it('refuses a passphrase that is too long before deriving anything', async () => {
    const error = await failure(
      wrap.wrap(dekOf(), binding, { passphrase: 'x'.repeat(1025) }),
    );
    expect(error.code).toBe('INVALID_INPUT');
  });

  it('treats canonically equivalent spellings as one passphrase (NFKC)', async () => {
    const composed = 'café au lait, s’il vous plaît';
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);
    const dek = dekOf();
    const wrapped = await wrap.wrap(dek, binding, { passphrase: composed });
    const back = await wrap.unwrap(wrapped, binding, {
      passphrase: decomposed,
    });
    expect(Buffer.from(back)).toEqual(Buffer.from(dek));
  });

  it('a wrong passphrase is retryable and says nothing more', async () => {
    const wrapped = await wrap.wrap(dekOf(), binding, { passphrase });
    const error = await failure(
      wrap.unwrap(wrapped, binding, { passphrase: 'another passphrase!' }),
    );
    expect(error.code).toBe('UNWRAP_FAILED');
    expect(error.retryable).toBe(true);
  });

  it('is case sensitive and sensitive to a trailing space', async () => {
    const wrapped = await wrap.wrap(dekOf(), binding, { passphrase });
    for (const other of [
      passphrase.toUpperCase(),
      `${passphrase} `,
      ` ${passphrase}`,
    ]) {
      expect(
        (await failure(wrap.unwrap(wrapped, binding, { passphrase: other })))
          .code,
      ).toBe('UNWRAP_FAILED');
    }
  });

  it('many attempts at once all finish, one derivation at a time', async () => {
    const wrapped = await wrap.wrap(dekOf(), binding, { passphrase });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        wrap.unwrap(wrapped, binding, {
          passphrase:
            index === 3 ? passphrase : `wrong passphrase ${String(index)}`,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(5);
  });

  it('refuses a cost it would not read back', () => {
    for (const cost of [
      { N: 2 ** 10, r: 8, p: 1 },
      { N: 2 ** 14 + 1, r: 8, p: 1 },
      { N: 2 ** 21, r: 8, p: 1 },
      // Small enough in memory (256 MiB) to pass that bound: only the cap on N stops it.
      { N: 2 ** 21, r: 1, p: 1 },
      { N: 2 ** 20, r: 16, p: 1 },
      { N: 2 ** 14, r: 0, p: 1 },
      { N: 2 ** 14, r: 8, p: 0 },
    ]) {
      expect(() => createPassphraseWrap({ cost })).toThrow(SecretsError);
    }
  });

  it('the default cost is scrypt N=2^17, r=8, p=1 and works', async () => {
    expect(DEFAULT_SCRYPT_COST).toEqual({ N: 131072, r: 8, p: 1 });
    const standard = createPassphraseWrap();
    const { dek, back, wrapped } = await roundTrip(standard, { passphrase });
    expect(Buffer.from(back)).toEqual(Buffer.from(dek));
    expect(wrapped.params.N).toBe(131072);
  }, 30_000);
});

describe('keyring wrap', () => {
  it('which backends count as protected', () => {
    expect(
      (
        [
          'macos-keychain',
          'windows-credential',
          'secret-service',
          'kwallet',
        ] as const
      ).map(isProtectedKeyring),
    ).toEqual([true, true, true, true]);
    expect(
      (['basic_text', 'none', 'unknown'] as const).map(isProtectedKeyring),
    ).toEqual([false, false, false]);
  });

  it('stores a KEK in the keyring and the DEK sealed under it, and reads both back', async () => {
    const backend = createMemoryKeyring();
    const wrap = createKeyringWrap({ backend });
    const { dek, wrapped, back } = await roundTrip(wrap);
    expect(Buffer.from(back)).toEqual(Buffer.from(dek));
    expect(backend.dump()).toHaveLength(1);
    expect(
      Buffer.from(backend.dump()[0] ?? []).includes(Buffer.from(dek)),
    ).toBe(false);
    expect(Buffer.from(wrapped.bytes).includes(Buffer.from(dek))).toBe(false);
  });

  it('refuses to wrap or unwrap on a backend that does not protect secrets, and writes nothing', async () => {
    for (const kind of ['basic_text', 'none', 'unknown'] as const) {
      const backend = createMemoryKeyring(kind);
      const wrap = createKeyringWrap({ backend });
      expect(await wrap.status()).toEqual({
        state: 'unavailable',
        reason: `keyring-${kind}`,
      });
      expect((await failure(wrap.wrap(dekOf(), binding))).code).toBe(
        'WRAP_UNAVAILABLE',
      );
      expect(backend.dump()).toHaveLength(0);
    }
    const secure = createKeyringWrap({ backend: createMemoryKeyring() });
    const wrapped = await secure.wrap(dekOf(), binding);
    const insecure = createKeyringWrap({
      backend: createMemoryKeyring('basic_text'),
    });
    expect((await failure(insecure.unwrap(wrapped, binding))).code).toBe(
      'WRAP_UNAVAILABLE',
    );
  });

  it('an edited row cannot redirect which keyring entry is read', async () => {
    const wrap = createKeyringWrap({ backend: createMemoryKeyring() });
    const other: WrapBinding = { ...binding, dekId: 'b'.repeat(32) };
    const dek = dekOf();
    const wrapped = await wrap.wrap(dek, binding);
    await wrap.wrap(dekOf(), other);

    // The row now names the other key's keyring account. The lookup is derived from the binding,
    // so it still reads (and needs) the right entry.
    const redirected = {
      ...wrapped,
      params: {
        ...wrapped.params,
        account: `kek:${other.purpose}:${other.dekId}`,
      },
    };
    expect(Buffer.from(await wrap.unwrap(redirected, binding))).toEqual(
      Buffer.from(dek),
    );
    // And the same bytes presented under the other binding do not open.
    expect((await failure(wrap.unwrap(redirected, other))).code).toBe(
      'UNWRAP_FAILED',
    );
  });

  it('refuses a record that names no service or one that holds nothing', async () => {
    const wrap = createKeyringWrap({ backend: createMemoryKeyring() });
    const wrapped = await wrap.wrap(dekOf(), binding);
    const noParams = await failure(
      wrap.unwrap({ ...wrapped, params: {} }, binding),
    );
    expect(noParams.code).toBe('UNWRAP_FAILED');
    const elsewhere = await failure(
      wrap.unwrap(
        { ...wrapped, params: { ...wrapped.params, service: 'elsewhere' } },
        binding,
      ),
    );
    expect(elsewhere.code).toBe('UNWRAP_FAILED');
  });

  it('a keyring that lost the entry refuses', async () => {
    const wrap = createKeyringWrap({ backend: createMemoryKeyring() });
    const wrapped = await wrap.wrap(dekOf(), binding);
    const other = createKeyringWrap({ backend: createMemoryKeyring() });
    expect((await failure(other.unwrap(wrapped, binding))).code).toBe(
      'UNWRAP_FAILED',
    );
  });

  it('does not let the backend share memory with the wrap (zeroing one must not change the other)', async () => {
    const backend = createMemoryKeyring();
    const wrap = createKeyringWrap({ backend });
    const wrapped = await wrap.wrap(dekOf(), binding);
    await wrap.unwrap(wrapped, binding);
    await wrap.unwrap(wrapped, binding);
    expect(backend.dump()[0]?.some((byte) => byte !== 0)).toBe(true);
  });
});

describe('desktop-delivered wrap', () => {
  const wrap = createCtlDeliveredWrap();

  it('needs the key from main, then checks it', async () => {
    expect(await wrap.status()).toEqual({ state: 'needs-input', input: 'dek' });
    const dek = dekOf();
    expect(await wrap.status({ dek })).toEqual({ state: 'ready' });
    const wrapped = await wrap.wrap(dek, binding);
    expect(wrapped.bytes.byteLength).toBe(32);
    expect(Buffer.from(wrapped.bytes).includes(Buffer.from(dek))).toBe(false);
    expect(Buffer.from(await wrap.unwrap(wrapped, binding, { dek }))).toEqual(
      Buffer.from(dek),
    );
  });

  it('returns a copy, so zeroing the result leaves the delivered key alone', async () => {
    const dek = dekOf();
    const copy = Uint8Array.from(dek);
    const wrapped = await wrap.wrap(dek, binding);
    const opened = await wrap.unwrap(wrapped, binding, { dek });
    opened.fill(0);
    expect(Buffer.from(dek)).toEqual(Buffer.from(copy));
  });

  it('refuses another key, no key, a short key, and another binding', async () => {
    const dek = dekOf();
    const wrapped = await wrap.wrap(dek, binding);
    expect(
      (await failure(wrap.unwrap(wrapped, binding, { dek: dekOf() }))).code,
    ).toBe('UNWRAP_FAILED');
    expect((await failure(wrap.unwrap(wrapped, binding))).code).toBe(
      'VAULT_LOCKED',
    );
    expect(
      (
        await failure(
          wrap.unwrap(wrapped, binding, { dek: new Uint8Array(31) }),
        )
      ).code,
    ).toBe('INVALID_INPUT');
    expect(
      (
        await failure(
          wrap.unwrap(wrapped, { ...binding, dekId: 'b'.repeat(32) }, { dek }),
        )
      ).code,
    ).toBe('UNWRAP_FAILED');
    expect(
      (
        await failure(
          wrap.unwrap(
            { ...wrapped, bytes: wrapped.bytes.subarray(1) },
            binding,
            { dek },
          ),
        )
      ).code,
    ).toBe('UNWRAP_FAILED');
  });
});
