import { jobStoreContract } from '@app/ports/testing';
import { describe, expect, it } from 'vitest';

import { createMemoryJobStore } from './memory-store.ts';

// The in-memory store meets the same contract as the SQLite and Postgres stores
// (`libs/engine/persistence`), so the runner's specs over it say something true about those.
jobStoreContract({
  name: 'memory',
  open: () => Promise.resolve(createMemoryJobStore()),
});

describe('memory job store', () => {
  it('hands out copies, so a caller cannot edit a stored row through one', async () => {
    const store = createMemoryJobStore();
    const { job } = await store.create(
      {
        id: '01JOBSTOREMEMORY0000000000' as never,
        type: 'test.job',
        version: 1,
        principalId: 'user-1',
        onBehalfOfId: null,
        planHash: null,
        idempotencyKey: 'key-memory-1',
        concurrencyKey: null,
        resumable: false,
        input: new Uint8Array([1, 2, 3]),
      },
      1,
    );

    job.input[0] = 99;

    expect((await store.get(job.id))?.input[0]).toBe(1);
  });

  it('can be told to fail a method, as a dead database would', async () => {
    const store = createMemoryJobStore();
    store.failNext('get', 2);

    await expect(store.get('x' as never)).rejects.toThrow(
      'job store get failed',
    );
    await expect(store.get('x' as never)).rejects.toThrow(
      'job store get failed',
    );
    expect(await store.get('x' as never)).toBeUndefined();
  });
});
