// The in-memory repository must behave like the SQL one, or the vault tests prove nothing about
// production. These are the assertions of the persistence contract ("data keys"), run on the fake.
import type { DataKeyRecord } from '@app/ports';
import { describe, expect, it } from 'vitest';

import {
  createMemoryDataKeyRepository,
  createMemoryKeyring,
} from './testing.ts';

const key = (id: string, over: Partial<DataKeyRecord> = {}): DataKeyRecord => ({
  id: id.padEnd(32, '0'),
  purpose: 'main',
  wrapKind: 'passphrase',
  wrapParamsJson: '{"N":131072}',
  wrapped: Uint8Array.from({ length: 60 }, (_, index) => (index * 7) % 256),
  state: 'active',
  createdAt: 1_000,
  retiredAt: null,
  ...over,
});

describe('memory data-key repository behaves like the SQL one', () => {
  it('stores and reads back, refusing a repeated id', async () => {
    const repository = createMemoryDataKeyRepository();
    expect(await repository.insert(key('a'))).toBe(true);
    expect(await repository.get(key('a').id)).toEqual(key('a'));
    expect(await repository.get('f'.repeat(32))).toBeUndefined();
    expect(await repository.insert(key('a', { purpose: 'other' }))).toBe(false);
    expect(await repository.get(key('a').id)).toEqual(key('a'));
  });

  it('allows one active key per purpose, more beside retired ones and under other purposes', async () => {
    const repository = createMemoryDataKeyRepository();
    expect(await repository.insert(key('a'))).toBe(true);
    expect(await repository.insert(key('b'))).toBe(false);
    expect(await repository.insert(key('c', { purpose: 'captures' }))).toBe(
      true,
    );
    expect(
      await repository.insert(key('d', { state: 'retired', retiredAt: 5 })),
    ).toBe(true);
  });

  it('retires once and frees the purpose', async () => {
    const repository = createMemoryDataKeyRepository();
    await repository.insert(key('a'));
    expect(await repository.retire(key('a').id, 2_000)).toBe(true);
    expect(await repository.retire(key('a').id, 3_000)).toBe(false);
    expect(await repository.retire('f'.repeat(32), 3_000)).toBe(false);
    expect(await repository.get(key('a').id)).toEqual(
      key('a', { state: 'retired', retiredAt: 2_000 }),
    );
    expect(await repository.insert(key('b', { createdAt: 2_000 }))).toBe(true);
  });

  it('lists one purpose, newest first', async () => {
    const repository = createMemoryDataKeyRepository();
    await repository.insert(
      key('a', { state: 'retired', retiredAt: 1, createdAt: 100 }),
    );
    await repository.insert(key('b', { createdAt: 300 }));
    await repository.insert(
      key('c', { state: 'retired', retiredAt: 2, createdAt: 200 }),
    );
    await repository.insert(key('d', { purpose: 'captures' }));
    expect((await repository.list('main')).map((row) => row.id)).toEqual([
      key('b').id,
      key('c').id,
      key('a').id,
    ]);
    expect(await repository.list('nobody')).toEqual([]);
  });

  it('keeps its own copy of the bytes', async () => {
    const repository = createMemoryDataKeyRepository();
    const record = key('a');
    await repository.insert(record);
    record.wrapped.fill(0);
    expect((await repository.get(key('a').id))?.wrapped).toEqual(
      key('a').wrapped,
    );
  });
});

describe('memory keyring', () => {
  it('keeps copies, so a caller zeroing its array does not change the stored secret', async () => {
    const keyring = createMemoryKeyring();
    const secret = Uint8Array.of(1, 2, 3);
    await keyring.set('service', 'account', secret);
    secret.fill(0);
    const read = await keyring.get('service', 'account');
    expect(read).toEqual(Uint8Array.of(1, 2, 3));
    read?.fill(0);
    expect(await keyring.get('service', 'account')).toEqual(
      Uint8Array.of(1, 2, 3),
    );
    expect(await keyring.get('service', 'other')).toBeNull();
  });
});
