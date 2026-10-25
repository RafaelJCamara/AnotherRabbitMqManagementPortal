import { afterEach, describe, expect, it } from 'vitest';

import type { PersistenceHandle } from '../database';
import { openMigratedSqlite } from '../testing/sqlite-fixtures';
import { createHoldJournal, MAX_INTERRUPTED_WINDOW } from './hold-journal';

const handles: PersistenceHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

async function journal() {
  const handle = await openMigratedSqlite();
  handles.push(handle);
  return { handle, repo: createHoldJournal(handle.db) };
}

const hold = (id: string, startedAt: number) => ({
  id,
  connectionId: 'conn-1',
  vhost: '/',
  queueSealed: new Uint8Array([1, 2, 3, 4]),
  startedAt,
});

describe('hold journal (M1-14) states', () => {
  it('stores the sealed queue bytes as given and lists the acquiring row', async () => {
    const { handle, repo } = await journal();
    await repo.open(hold('h-1', 10));

    const row = await handle.db
      .selectFrom('hold_journal')
      .select(['state', 'queue_sealed', 'returned'])
      .where('id', '=', 'h-1')
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('acquiring');
    expect(Array.from(row.queue_sealed)).toEqual([1, 2, 3, 4]);
    expect(row.returned).toBe(0);

    expect(await repo.listInterrupted(10)).toEqual([
      { id: 'h-1', connectionId: 'conn-1', vhost: '/' },
    ]);
  });

  it('settles an acquiring row once and removes it from the interrupted list', async () => {
    const { repo } = await journal();
    await repo.open(hold('h-1', 10));

    await repo.settle('h-1', 20, 50);

    expect(await repo.listInterrupted(10)).toEqual([]);
    await expect(repo.settle('h-1', 20, 60)).rejects.toThrow(/not acquiring/);
    await expect(repo.markIncident('h-1', 'late', 60)).rejects.toThrow(
      /not acquiring/,
    );
  });

  it('marks an acquiring row as an incident with its fixed reason', async () => {
    const { handle, repo } = await journal();
    await repo.open(hold('h-2', 10));

    await repo.markIncident('h-2', 'interrupted', 40);

    const row = await handle.db
      .selectFrom('hold_journal')
      .select(['state', 'reason', 'ended_at'])
      .where('id', '=', 'h-2')
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      state: 'incident',
      reason: 'interrupted',
      ended_at: 40,
    });
  });

  it('lists the oldest acquiring rows first and never more than the window', async () => {
    const { repo } = await journal();
    await repo.open(hold('h-late', 30));
    await repo.open(hold('h-early', 10));

    expect((await repo.listInterrupted(1)).map((row) => row.id)).toEqual([
      'h-early',
    ]);
    await expect(repo.listInterrupted(0)).rejects.toThrow(RangeError);
    await expect(
      repo.listInterrupted(MAX_INTERRUPTED_WINDOW + 1),
    ).rejects.toThrow(RangeError);
  });
});
