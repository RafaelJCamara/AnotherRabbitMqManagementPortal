import type { ActionId } from '@app/contracts';
import type { AuditRow } from '@app/ports';
import { describe, expect, it } from 'vitest';

import type { AuditEntry, AuditOutcome } from '../actions/hooks.ts';
import {
  createMemoryAuditRepository,
  createTestPrincipal,
  type MemoryAuditRepository,
} from '../actions/testing.ts';
import { createAuditChain, type AuditChain } from './chain.ts';
import { AUDIT_GENESIS_HASH, hashAuditRow } from './row.ts';

function entry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    at: 1_700_000_000_000,
    correlationId: 'corr-1',
    actionId: 'queues.purge' as ActionId,
    kind: 'command',
    principal: createTestPrincipal(),
    target: { kind: 'queue', name: 'orders' },
    env: 'prod',
    risk: 'critical',
    ...over,
  };
}

function outcome(over: Partial<AuditOutcome> = {}): AuditOutcome {
  return { ...entry(), result: 'ok', ...over };
}

/** n pairs of attempt and outcome rows: 2n rows, seq 1..2n. */
async function fill(chain: AuditChain, pairs: number): Promise<void> {
  for (let i = 0; i < pairs; i += 1) {
    const seq = await chain.attempt(
      entry({ correlationId: `corr-${String(i)}` }),
    );
    await chain.outcome(
      outcome({ correlationId: `corr-${String(i)}`, attemptSeq: seq }),
    );
  }
}

function setup(maxPending?: number): {
  repo: MemoryAuditRepository;
  chain: AuditChain;
  errors: unknown[];
} {
  const repo = createMemoryAuditRepository();
  const errors: unknown[] = [];
  const logger = {
    error: (fields: unknown) => errors.push(fields),
    warn: () => undefined,
  } as never;
  return {
    repo,
    errors,
    chain: createAuditChain({
      repository: repo,
      logger,
      ...(maxPending === undefined ? {} : { maxPending }),
    }),
  };
}

/** The stored row at an index; a spec that asks for one that is not there is wrong. */
function row(repo: MemoryAuditRepository, index: number): AuditRow {
  const found = repo.rows[index];
  if (found === undefined)
    throw new Error(`no audit row at index ${String(index)}`);
  return found;
}

/** Re-seals a row the way an attacker with write access and the algorithm would. */
function reseal(source: AuditRow, edit: Partial<AuditRow>): AuditRow {
  const open: Record<string, unknown> = { ...source, ...edit };
  delete open.hash;
  return { ...(open as Omit<AuditRow, 'hash'>), hash: hashAuditRow(open) };
}

describe('audit chain: writing', () => {
  it('AC-1 audit rows are numbered from 1 and each carries the hash of the row before', async () => {
    const { repo, chain } = setup();

    await fill(chain, 3);

    expect(repo.rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(repo.rows[0]?.prevHash).toBe(AUDIT_GENESIS_HASH);
    for (let i = 1; i < repo.rows.length; i += 1) {
      expect(repo.rows[i]?.prevHash).toBe(repo.rows[i - 1]?.hash);
    }
    expect(repo.rows.map((row) => row.phase)).toEqual([
      'attempt',
      'outcome',
      'attempt',
      'outcome',
      'attempt',
      'outcome',
    ]);
    expect(repo.rows[1]).toMatchObject({ attemptSeq: 1, result: 'ok' });
    expect(await chain.verify()).toEqual({
      ok: true,
      rows: 6,
      head: { seq: 6, hash: repo.rows[5]?.hash },
    });
  });

  it('AC-1 an audit row records who acted for whom, on what, at which risk and under which plan', async () => {
    const { repo, chain } = setup();
    const agent = createTestPrincipal({
      kind: 'mcp-client',
      id: 'agent-1',
      surface: 'mcp',
      unattended: true,
      onBehalfOf: createTestPrincipal({ id: 'boss', display: 'The Boss' }),
    });

    await chain.attempt(
      entry({
        principal: agent,
        planId: 'plan-1' as never,
        planDigest: 'd'.repeat(64),
        approvedBy: ['approver-1'],
      }),
    );

    expect(repo.rows[0]).toMatchObject({
      actorId: 'agent-1',
      surface: 'mcp',
      onBehalfOfId: 'boss',
      env: 'prod',
      risk: 'critical',
      planId: 'plan-1',
      planDigest: 'd'.repeat(64),
      approvedByJson: '["approver-1"]',
      actionId: 'queues.purge',
    });
    expect(JSON.parse(repo.rows[0]?.actorJson ?? '{}')).toMatchObject({
      id: 'agent-1',
      onBehalfOf: { id: 'boss', display: 'The Boss' },
    });
    expect(JSON.parse(repo.rows[0]?.targetJson ?? '{}')).toEqual({
      kind: 'queue',
      name: 'orders',
    });
  });

  it('AC-1 a denied audit attempt write rejects, so the executor does not run the action', async () => {
    const { repo, chain } = setup();
    repo.failAppends(true);

    await expect(chain.attempt(entry())).rejects.toThrow('audit store is down');

    expect(repo.rows).toHaveLength(0);
  });

  it('AC-1 two audit writers on one store never fork the chain (lost races retry)', async () => {
    const repo = createMemoryAuditRepository();
    // Every append yields first, so both writers read the same head: one of them loses the race.
    repo.beforeAppend = () => new Promise((resolve) => setTimeout(resolve, 1));
    const a = createAuditChain({ repository: repo });
    const b = createAuditChain({ repository: repo });

    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        (i % 2 === 0 ? a : b).attempt(
          entry({ correlationId: `c-${String(i)}` }),
        ),
      ),
    );

    expect(repo.rows.map((row) => row.seq)).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 1),
    );
    expect(await a.verify()).toMatchObject({ ok: true, rows: 30 });
  });

  it('AC-1 one chain serialises concurrent audit writes into consecutive rows', async () => {
    const { repo, chain } = setup();

    const seqs = await Promise.all(
      Array.from({ length: 40 }, () => chain.attempt(entry())),
    );

    expect([...seqs].sort((x, y) => x - y)).toEqual(
      Array.from({ length: 40 }, (_, i) => i + 1),
    );
    expect(await chain.verify()).toMatchObject({ ok: true, rows: 40 });
    expect(repo.rows).toHaveLength(40);
  });

  it('AC-1 an audit append that keeps losing the race gives up instead of looping, and denies', async () => {
    const repo = createMemoryAuditRepository();
    repo.append = () => Promise.resolve(false);
    const chain = createAuditChain({ repository: repo, maxAppendTries: 3 });

    await expect(chain.attempt(entry())).rejects.toThrow(/lost races/);
  });

  it('AC-1 the store refuses a replayed row: the same seq or the same prevHash is not stored twice', async () => {
    const { repo, chain } = setup();
    await fill(chain, 1);
    const first = row(repo, 0);
    const second = row(repo, 1);

    expect(await repo.append(first)).toBe(false);
    expect(await repo.append({ ...second, seq: 9 })).toBe(false);
    expect(repo.rows).toHaveLength(2);
  });

  it('AC-1 audit strings are redacted and clipped: a secret in a name never reaches the chain (I-10)', async () => {
    const { repo, chain } = setup();
    const canary = 'S3cr3t-canary';

    await chain.attempt(
      entry({
        principal: createTestPrincipal({
          display: `amqp://admin:${canary}@broker.example`,
          roles: [`Bearer ${canary}aaaaaaaa`],
        }),
        target: {
          kind: 'queue',
          name: `orders?password=${canary}&x=1`,
          vhost: 'v'.repeat(5_000),
        },
        correlationId: 'c'.repeat(300),
      }),
    );
    await chain.outcome(
      outcome({
        target: { name: `orders?token=${canary}` },
        jobId: `https://u:${canary}@h/${'j'.repeat(300)}` as never,
      }),
    );

    const stored = JSON.stringify(repo.rows);
    expect(stored).not.toContain(canary);
    expect(stored).not.toContain('v'.repeat(300));
    expect(stored).not.toContain('c'.repeat(300));
    expect(stored).not.toContain('j'.repeat(300));
  });

  it('AC-1 audit: a value that cannot be stored makes the attempt reject, so the action is denied', async () => {
    const { repo, chain } = setup();

    await expect(
      chain.attempt(entry({ target: { messageCount: Number.NaN } })),
    ).rejects.toThrow(TypeError);

    expect(repo.rows).toHaveLength(0);
  });

  it('AC-1 audit: a __proto__ key in a target is kept as data, not as a change of prototype', async () => {
    const { repo, chain } = setup();
    const hostile = JSON.parse(
      '{"name":"q","__proto__":{"admin":true}}',
    ) as never;

    await chain.attempt(entry({ target: hostile }));

    expect(JSON.parse(repo.rows[0]?.targetJson ?? '{}')).toEqual({
      name: 'q',
      ['__proto__']: { admin: true },
    });
    expect(({} as { admin?: boolean }).admin).toBeUndefined();
  });

  it('AC-1 an audit row never holds an input, a payload or a body (it has no place for one)', async () => {
    const { repo, chain } = setup();

    await chain.attempt({
      ...entry(),
      input: { name: 'orders', password: 'hunter2' },
      sensitivePayload: { body: 'a very secret body' },
    } as AuditEntry);

    const stored = JSON.stringify(repo.rows);
    expect(stored).not.toContain('hunter2');
    expect(stored).not.toContain('secret body');
  });
});

describe('audit chain: verify finds the first broken seq', () => {
  const columns: readonly [string, Partial<AuditRow>][] = [
    ['at', { at: 1 }],
    ['phase', { phase: 'outcome' }],
    ['correlationId', { correlationId: 'forged' }],
    ['actionId', { actionId: 'queues.delete' }],
    ['kind', { kind: 'query' }],
    ['actorId', { actorId: 'someone-else' }],
    ['surface', { surface: 'cli' }],
    ['onBehalfOfId', { onBehalfOfId: 'boss' }],
    ['actorJson', { actorJson: '{"id":"someone-else"}' }],
    ['targetJson', { targetJson: '{"name":"other"}' }],
    ['env', { env: 'dev' }],
    ['risk', { risk: 'low' }],
    ['planId', { planId: 'plan-x' }],
    ['planDigest', { planDigest: 'e'.repeat(64) }],
    ['approvedByJson', { approvedByJson: '["me"]' }],
    ['attemptSeq', { attemptSeq: 99 }],
    ['result', { result: 'error' }],
    ['code', { code: 'INTERNAL' }],
    ['jobId', { jobId: 'job-x' }],
    ['receiptId', { receiptId: 'rcpt-x' }],
    ['detailJson', { detailJson: '{"receiptFailed":true}' }],
    ['prevHash', { prevHash: 'a'.repeat(64) }],
  ];

  it.each(columns)(
    'AC-1 a tampered audit row (%s) is reported at its own seq',
    async (_name, edit) => {
      const { repo, chain } = setup();
      await fill(chain, 5);
      const index = 4;
      repo.rows[index] = { ...row(repo, index), ...edit };

      const result = await chain.verify();

      expect(result).toMatchObject({ ok: false, brokenSeq: 5 });
    },
  );

  it('AC-1 a tampered audit row is reported with its reason, and rows before it are fine', async () => {
    const { repo, chain } = setup();
    await fill(chain, 5);
    repo.rows[6] = { ...row(repo, 6), result: 'error' };

    expect(await chain.verify()).toEqual({
      ok: false,
      brokenSeq: 7,
      reason: 'hash-mismatch',
      rows: 6,
    });
  });

  it('AC-1 the first of several tampered audit rows is the one reported', async () => {
    const { repo, chain } = setup();
    await fill(chain, 5);
    repo.rows[8] = { ...row(repo, 8), risk: 'none' };
    repo.rows[3] = { ...row(repo, 3), risk: 'none' };

    expect(await chain.verify()).toMatchObject({ ok: false, brokenSeq: 4 });
  });

  it('AC-1 an audit row re-hashed by the attacker still breaks the link in the next row', async () => {
    const { repo, chain } = setup();
    await fill(chain, 5);
    repo.rows[3] = reseal(row(repo, 3), { risk: 'none' });

    expect(await chain.verify()).toMatchObject({
      ok: false,
      brokenSeq: 5,
      reason: 'prev-mismatch',
    });
  });

  it('AC-1 a deleted audit row in the middle is reported at the seq that is missing', async () => {
    const { repo, chain } = setup();
    await fill(chain, 5);
    repo.rows.splice(4, 1);

    expect(await chain.verify()).toMatchObject({
      ok: false,
      brokenSeq: 5,
      reason: 'seq-gap',
    });
  });

  it('AC-1 a deleted first audit row is reported at seq 1', async () => {
    const { repo, chain } = setup();
    await fill(chain, 3);
    repo.rows.shift();

    expect(await chain.verify()).toMatchObject({
      ok: false,
      brokenSeq: 1,
      reason: 'seq-gap',
    });
  });

  it('AC-1 reordered audit rows (two seqs swapped) are reported', async () => {
    const { repo, chain } = setup();
    await fill(chain, 5);
    const a = row(repo, 3);
    const b = row(repo, 4);
    repo.rows[3] = { ...b, seq: a.seq };
    repo.rows[4] = { ...a, seq: b.seq };

    expect(await chain.verify()).toMatchObject({ ok: false, brokenSeq: 4 });
  });

  it('AC-1 an audit row inserted in the middle with a valid hash is reported', async () => {
    const { repo, chain } = setup();
    await fill(chain, 3);
    const before = row(repo, 2);
    const forged = reseal(before, {
      seq: 4,
      prevHash: before.hash,
      correlationId: 'forged',
    });
    repo.rows.splice(3, 0, forged);
    // The rows after it still point at the row it replaced.
    expect(await chain.verify()).toMatchObject({ ok: false, brokenSeq: 5 });
  });

  it('AC-1 an audit row with an extra member or a column of the wrong type is reported', async () => {
    const extra = setup();
    await fill(extra.chain, 3);
    extra.repo.rows[1] = {
      ...row(extra.repo, 1),
      admin: true,
    } as AuditRow;
    const wrong = setup();
    await fill(wrong.chain, 3);
    wrong.repo.rows[1] = {
      ...row(wrong.repo, 1),
      at: '1' as never,
    };
    const weird = setup();
    await fill(weird.chain, 3);
    weird.repo.rows[1] = {
      ...row(weird.repo, 1),
      at: Number.NaN,
    };

    expect(await extra.chain.verify()).toMatchObject({ brokenSeq: 2 });
    expect(await wrong.chain.verify()).toMatchObject({ brokenSeq: 2 });
    expect(await weird.chain.verify()).toMatchObject({
      brokenSeq: 2,
      reason: 'malformed',
    });
  });

  it('AC-1 a chain with no rows verifies', async () => {
    const { chain } = setup();

    expect(await chain.verify()).toEqual({
      ok: true,
      rows: 0,
      head: undefined,
    });
  });

  it('AC-1 verify pages through the chain: a break after the first page is still found', async () => {
    const { repo, chain } = setup();
    await fill(chain, 10);
    repo.rows[17] = { ...row(repo, 17), code: 'INTERNAL' };

    expect(await chain.verify({ pageSize: 3 })).toMatchObject({
      ok: false,
      brokenSeq: 18,
    });
    expect(
      await createAuditChain({ repository: setup().repo }).verify({
        pageSize: 0,
      }),
    ).toMatchObject({ ok: true });
  });
});

describe('audit chain: truncation and rewrites need an anchor', () => {
  it('AC-1 a truncated tail is invisible to a plain verify (the limit that anchors exist for)', async () => {
    const { repo, chain } = setup();
    await fill(chain, 5);

    repo.rows.length = 6;

    expect(await chain.verify()).toMatchObject({ ok: true, rows: 6 });
  });

  it('AC-1 a truncated tail is reported against the head an anchor recorded', async () => {
    const { repo, chain } = setup();
    await fill(chain, 5);
    const anchor = await chain.head();
    repo.rows.length = 6;

    expect(await chain.verify({ expect: anchor })).toEqual({
      ok: false,
      brokenSeq: 7,
      reason: 'truncated',
      rows: 6,
    });
  });

  it('AC-1 a chain rewritten from some row to the end is reported against an anchor', async () => {
    const { repo, chain } = setup();
    await fill(chain, 5);
    const anchor = await chain.head();
    // The attacker edits row 4 and recomputes every hash after it: the chain is consistent.
    let prev = row(repo, 2);
    for (let i = 3; i < repo.rows.length; i += 1) {
      const edit =
        i === 3
          ? { risk: 'none', prevHash: prev.hash }
          : { prevHash: prev.hash };
      repo.rows[i] = reseal(row(repo, i), edit);
      prev = row(repo, i);
    }

    expect(await chain.verify()).toMatchObject({ ok: true });
    expect(await chain.verify({ expect: anchor })).toMatchObject({
      ok: false,
      brokenSeq: 10,
      reason: 'anchor-mismatch',
    });
  });

  it('AC-1 the anchor must be an exact match: a head that matches passes', async () => {
    const { chain } = setup();
    await fill(chain, 3);

    expect(await chain.verify({ expect: await chain.head() })).toMatchObject({
      ok: true,
    });
  });

  it('AC-1 verification can restart from an anchor after retention removed the older rows', async () => {
    const { repo, chain } = setup();
    await fill(chain, 5);
    const anchor = { seq: 4, hash: row(repo, 3).hash };
    repo.rows.splice(0, 4);

    expect(await chain.verify({ from: anchor })).toMatchObject({
      ok: true,
      rows: 6,
    });
    // ...but not from a different hash.
    expect(
      await chain.verify({ from: { seq: 4, hash: 'b'.repeat(64) } }),
    ).toMatchObject({ ok: false, brokenSeq: 5, reason: 'prev-mismatch' });
  });
});

describe('audit chain: a failed outcome write is never silently lost', () => {
  it('AC-1 a failed audit outcome write rejects, is kept, and is written before the next audit row', async () => {
    const { repo, chain } = setup();
    const seq = await chain.attempt(entry());
    repo.failAppends(true);

    await expect(chain.outcome(outcome({ attemptSeq: seq }))).rejects.toThrow(
      'audit store is down',
    );
    expect(chain.stats()).toEqual({ pending: 1, pendingDropped: 0 });
    repo.failAppends(false);
    const next = await chain.attempt(entry({ correlationId: 'corr-2' }));

    expect(next).toBe(3);
    expect(repo.rows.map((row) => row.phase)).toEqual([
      'attempt',
      'outcome',
      'attempt',
    ]);
    expect(chain.stats().pending).toBe(0);
    expect(await chain.verify()).toMatchObject({ ok: true, rows: 3 });
  });

  it('AC-1 while queued audit outcomes cannot be written, a new attempt is denied (fail closed)', async () => {
    const { repo, chain } = setup();
    await chain.attempt(entry());
    repo.failAppends(true);
    await expect(chain.outcome(outcome())).rejects.toThrow();

    await expect(chain.attempt(entry())).rejects.toThrow('audit store is down');

    expect(chain.stats().pending).toBe(1);
  });

  it('AC-1 flushPending writes what is queued and says what is left', async () => {
    const { repo, chain } = setup();
    await chain.attempt(entry());
    repo.failAppends(true);
    await expect(chain.outcome(outcome())).rejects.toThrow();
    await expect(chain.outcome(outcome())).rejects.toThrow();

    expect(await chain.flushPending()).toEqual({ written: 0, pending: 2 });
    repo.failAppends(false);
    expect(await chain.flushPending()).toEqual({ written: 2, pending: 0 });

    expect(repo.rows).toHaveLength(3);
    expect(await chain.verify()).toMatchObject({ ok: true });
  });

  it('AC-1 an audit outcome that does not fit the retry queue is counted and logged, not hidden', async () => {
    const { repo, chain, errors } = setup(2);
    await chain.attempt(entry());
    repo.failAppends(true);

    for (let i = 0; i < 3; i += 1) {
      await expect(chain.outcome(outcome())).rejects.toThrow();
    }

    expect(chain.stats()).toEqual({ pending: 2, pendingDropped: 1 });
    expect(errors).toEqual([
      expect.objectContaining({ event: 'audit.outcome.dropped' }),
    ]);
  });

  it('AC-1 an audit outcome keeps the order: queued rows go first, then the new one', async () => {
    const { repo, chain } = setup();
    await chain.attempt(entry());
    repo.failAppends(true);
    await expect(
      chain.outcome(outcome({ correlationId: 'first' })),
    ).rejects.toThrow();
    repo.failAppends(false);

    await chain.outcome(outcome({ correlationId: 'second' }));

    expect(repo.rows.map((row) => row.correlationId)).toEqual([
      'corr-1',
      'first',
      'second',
    ]);
  });
});
