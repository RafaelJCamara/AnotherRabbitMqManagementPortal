import { MessageChannel } from 'node:worker_threads';

import {
  CaptureSearchUnavailableError,
  type CaptureRepository,
} from '@app/ports';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import type { PersistenceHandle } from '../database';
import { captureContract, newCapture } from '../testing/capture-contract';
import { openMigratedSqlite } from '../testing/sqlite-fixtures';
import {
  CaptureWorkerError,
  createCaptureRepositoryClient,
  serveCaptureRepository,
  type CaptureRepositoryClient,
} from './capture-rpc';
import { createRepositories } from '.';

const channels: MessageChannel[] = [];
const handles: PersistenceHandle[] = [];

afterEach(async () => {
  for (const channel of channels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

/** A repository over a database, served on one end of a channel and used through the other. */
function over(
  repo: CaptureRepository,
  options: Parameters<typeof createCaptureRepositoryClient>[1] = {},
): { client: CaptureRepositoryClient; channel: MessageChannel } {
  const channel = new MessageChannel();
  channels.push(channel);
  serveCaptureRepository(repo, channel.port1);
  return {
    client: createCaptureRepositoryClient(channel.port2, options),
    channel,
  };
}

// The whole contract, through the port: same answers as the repository itself. Its channel lives
// as long as the contract's database, so it is closed after the last test, not after each one.
const contractChannels: MessageChannel[] = [];
afterAll(() => {
  for (const channel of contractChannels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
});
captureContract({
  name: 'sqlite (in memory) over a message port',
  open: () => openMigratedSqlite(),
  repository: (handle) => {
    const channel = new MessageChannel();
    contractChannels.push(channel);
    serveCaptureRepository(createRepositories(handle).captures, channel.port1);
    return createCaptureRepositoryClient(channel.port2);
  },
});

const never = (): Promise<never> => new Promise(() => undefined);
const stub = (over: Partial<CaptureRepository>): CaptureRepository =>
  new Proxy(over, {
    get: (target, name): unknown => Reflect.get(target, name) ?? never,
  }) as CaptureRepository;

describe('capture worker port', () => {
  it('M1-09 AC-12 rejects a request the worker does not answer in time, frees its slot, and ignores a late answer', async () => {
    const { client, channel } = over(stub({ usage: never }), {
      timeoutMs: 30,
      maxInFlight: 1,
    });

    const first = await client.usage('user-1').catch((e: unknown) => e);
    const second = await client.usage('user-1').catch((e: unknown) => e);

    expect(first).toBeInstanceOf(CaptureWorkerError);
    expect((first as CaptureWorkerError).code).toBe('CAPTURE_WORKER_TIMEOUT');
    expect((second as CaptureWorkerError).code).toBe('CAPTURE_WORKER_TIMEOUT');
    expect(client.stats()).toMatchObject({
      inFlight: 0,
      timeouts: 2,
      refused: 0,
    });
    // An answer that arrives after the deadline finds nobody waiting and changes nothing.
    channel.port1.postMessage({
      id: 1,
      ok: true,
      value: { captures: 9, storedBytes: 9 },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.stats().inFlight).toBe(0);
  });

  it('M1-09 AC-12 refuses requests over the in-flight bound at once, and counts them', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client } = over(
      stub({
        usage: async () => {
          await gate;
          return { captures: 1, storedBytes: 2 };
        },
      }),
      { maxInFlight: 2 },
    );

    const open = [client.usage('a'), client.usage('b')];
    const refused = await client.usage('c').catch((e: unknown) => e);
    expect(client.stats()).toMatchObject({ inFlight: 2, refused: 1 });
    release();

    expect((refused as CaptureWorkerError).code).toBe('CAPTURE_WORKER_BUSY');
    expect(await Promise.all(open)).toEqual([
      { captures: 1, storedBytes: 2 },
      { captures: 1, storedBytes: 2 },
    ]);
    expect(await client.usage('d')).toEqual({ captures: 1, storedBytes: 2 });
    expect(client.stats()).toMatchObject({ inFlight: 0, refused: 1 });
  });

  it('M1-09 AC-12 rejects every open request when the worker goes away, and every later one at once', async () => {
    const { client, channel } = over(stub({ usage: never }));

    const open = client.usage('a').catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 5));
    channel.port1.close();
    const rejected = await open;
    const later = await client.usage('b').catch((e: unknown) => e);

    expect((rejected as CaptureWorkerError).code).toBe('CAPTURE_WORKER_GONE');
    expect((later as CaptureWorkerError).code).toBe('CAPTURE_WORKER_GONE');
    expect(client.stats()).toMatchObject({ closed: true, inFlight: 0 });
    client.close();
  });

  it('M1-09 AC-5 sends an error back as a code and a fixed sentence, never the text of the failure', async () => {
    const canary = 'CANARY-SQL-3f9a: constraint failed on column body_sealed';
    const { client } = over(
      stub({
        getCapture: () => Promise.reject(new Error(canary)),
        usage: () => Promise.reject(new RangeError(canary)),
        queryMessages: () =>
          Promise.reject(new CaptureSearchUnavailableError()),
      }),
    );

    const plain = await client.getCapture('a', 'b').catch((e: unknown) => e);
    const range = await client.usage('a').catch((e: unknown) => e);
    const search = await client
      .queryMessages('a', { captureId: 'c', order: 'asc', limit: 1 })
      .catch((e: unknown) => e);

    expect(plain).toBeInstanceOf(CaptureWorkerError);
    expect((plain as CaptureWorkerError).code).toBe('CAPTURE_STORE_ERROR');
    expect(
      JSON.stringify([plain, range]) + (plain as Error).message,
    ).not.toContain('CANARY');
    expect(range).toBeInstanceOf(RangeError);
    expect(search).toBeInstanceOf(CaptureSearchUnavailableError);
  });

  it('M1-09 AC-12 answers only the repository methods, and ignores anything else', async () => {
    const calls: string[] = [];
    const channel = new MessageChannel();
    channels.push(channel);
    serveCaptureRepository(
      stub({
        usage: () => {
          calls.push('usage');
          return Promise.resolve({ captures: 0, storedBytes: 0 });
        },
      }),
      channel.port1,
    );
    const replies: unknown[] = [];
    channel.port2.on('message', (m: unknown) => replies.push(m));

    for (const method of [
      'constructor',
      '__proto__',
      'toString',
      'close',
      'hasOwnProperty',
    ]) {
      channel.port2.postMessage({ id: 1, method, args: [] });
    }
    channel.port2.postMessage('usage');
    channel.port2.postMessage({ id: 'x', method: 'usage', args: [] });
    channel.port2.postMessage({ id: 2, method: 'usage', args: 'nope' });
    channel.port2.postMessage({ id: 3, method: 'usage', args: ['u'] });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls).toEqual(['usage']);
    expect(replies).toEqual([
      { id: 3, ok: true, value: { captures: 0, storedBytes: 0 } },
    ]);
  });

  it('M1-09 AC-12 sends a capture and its sealed bytes across the port unchanged', async () => {
    const handle = await openMigratedSqlite();
    handles.push(handle);
    const { client } = over(createRepositories(handle).captures);
    await client.createCapture(newCapture('cap-1'));

    expect(await client.getCapture('user-1', 'cap-1')).toMatchObject({
      id: 'cap-1',
      envClass: 'dev',
      messages: 0,
    });
    expect(await client.searchAvailable()).toBe(true);
    client.close();
    await expect(client.usage('user-1')).rejects.toMatchObject({
      code: 'CAPTURE_WORKER_GONE',
    });
  });
});
