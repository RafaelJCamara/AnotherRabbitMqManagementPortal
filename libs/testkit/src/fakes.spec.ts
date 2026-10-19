import type { ConnectionId } from '@app/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createFakeMgmtRead, createFakeMgmtWrite } from './fakes.ts';

const connectionId = 'c1' as ConnectionId;
const signal = new AbortController().signal;
const queues = z.array(z.strictObject({ name: z.string() }));

describe('createFakeMgmtRead', () => {
  it('AC-1 answers a GET from the table, through the schema of the request, and records it', async () => {
    const fake = createFakeMgmtRead({ '/api/queues': [{ name: 'orders' }] });
    const request = {
      connectionId,
      path: '/api/queues',
      schema: queues,
      lane: 'interactive',
    } as const;

    expect(await fake.get(request, signal)).toEqual([{ name: 'orders' }]);
    expect(fake.requests).toEqual([request]);
  });

  it('AC-2 refuses a path nobody wrote down, and still records the request', async () => {
    const fake = createFakeMgmtRead({});

    await expect(
      fake.get(
        { connectionId, path: '/api/queues', schema: queues, lane: 'live' },
        signal,
      ),
    ).rejects.toThrow('no GET /api/queues');
    expect(fake.requests).toHaveLength(1);
  });

  it('AC-3 does not mistake an inherited property for an answer', async () => {
    const fake = createFakeMgmtRead({});

    await expect(
      fake.get(
        {
          connectionId,
          path: 'constructor',
          schema: z.unknown(),
          lane: 'live',
        },
        signal,
      ),
    ).rejects.toThrow('no GET constructor');
  });

  it('AC-4 fails when the canned answer does not fit the schema, as the adapter would', async () => {
    const fake = createFakeMgmtRead({ '/api/queues': [{ name: 7 }] });

    await expect(
      fake.get(
        { connectionId, path: '/api/queues', schema: queues, lane: 'live' },
        signal,
      ),
    ).rejects.toThrow();
  });

  it('AC-5 does not stream', async () => {
    const fake = createFakeMgmtRead({});

    await expect(
      fake.stream(
        { connectionId, path: '/api/definitions', lane: 'background' },
        signal,
      ),
    ).rejects.toThrow('does not stream');
  });
});

describe('createFakeMgmtWrite', () => {
  it('AC-6 answers by method and path, and records what was sent', async () => {
    const fake = createFakeMgmtWrite({
      'DELETE /api/queues/%2F/q/contents': {},
    });
    const request = {
      connectionId,
      method: 'DELETE',
      path: '/api/queues/%2F/q/contents',
      schema: z.strictObject({}),
    } as const;

    expect(await fake.send(request, signal)).toEqual({});
    expect(fake.requests).toEqual([request]);
  });

  it('AC-7 refuses a method the table does not list for that path', async () => {
    const fake = createFakeMgmtWrite({
      'DELETE /api/queues/%2F/q/contents': {},
    });

    await expect(
      fake.send(
        {
          connectionId,
          method: 'PUT',
          path: '/api/queues/%2F/q/contents',
          schema: z.unknown(),
        },
        signal,
      ),
    ).rejects.toThrow('no PUT /api/queues/%2F/q/contents');
  });
});
