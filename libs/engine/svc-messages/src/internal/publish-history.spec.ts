// M1-19 slice C: the publish history over the repository in memory. AC-11 to AC-16 of
// docs/specs/M1-19.md are the tests named `M1-19 AC-n`; the rest hold the rules the ACs lean on
// (the document layout, fail-closed reads, filters). AC-13 and AC-14 run a real publish: the action
// of slice A with this store as its recorder, over a scripted lease, so "the outcome is unchanged" is
// shown against the action and not against the store alone.
//
// The scripted lease is in this file for the reason it is in the action's spec: a `confirmed`
// outcome needs `mintConfirmedCopyProof`, and a lease type may be named only by specs and actions.
import { createHash } from 'node:crypto';

import {
  AppError,
  createCanaryScanner,
  createLogger,
  createManualClock,
  createTestContext,
  createWiredExecutor,
  REDACTED,
  type ExecutorWrite,
} from '@app/kernel';
import {
  mintConfirmedCopyProof,
  PUBLISH_HISTORY_MAX_SEALED_BYTES,
  type ConnectionManager,
  type PublishLease,
} from '@app/ports';
import { describe, expect, it } from 'vitest';

import type { PublishRecord } from '../deps';
import { createMessagesPublishAction } from '../actions/messages-publish';
import {
  createFakeSealer,
  createMemoryPublishHistory,
  type MemoryPublishHistory,
} from '../testing';
import { sampleInput } from '../actions/messages-publish.fixture';
import {
  createPublishHistory,
  PUBLISH_HISTORY_DEFAULT_WINDOW,
  PUBLISH_HISTORY_PURGE_BATCH,
  PUBLISH_HISTORY_RETENTION_MS,
  type PublishHistory,
} from './publish-history';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const OWNER = 'user-1';
const OTHER = 'user-2';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

const ZERO = {
  confirmed: 0,
  nacked: 0,
  returned: 0,
  blocked: 0,
  timeout: 0,
  failed: 0,
  'not-sent': 0,
} as const;

function setup(
  options: {
    clock?: ReturnType<typeof createManualClock>;
    history?: MemoryPublishHistory;
  } = {},
) {
  const history = options.history ?? createMemoryPublishHistory();
  const sealer = createFakeSealer();
  const clock = options.clock ?? createManualClock(NOW);
  const lines: string[] = [];
  const logger = createLogger({
    level: 'trace',
    sink: { write: (line) => lines.push(line) },
  });
  let next = 0;
  const store = createPublishHistory({
    history,
    sealer,
    newId: () => `P${String((next += 1)).padStart(6, '0')}`,
    clock,
    logger,
  });
  return { history, sealer, clock, lines, store };
}

function entry(over: Partial<PublishRecord> = {}): PublishRecord {
  return {
    ownerId: OWNER,
    connectionId: 'c1',
    vhost: '/',
    at: NOW,
    exchange: 'orders',
    routingKey: 'orders.created',
    copies: 1,
    summary: { ...ZERO, confirmed: 1 },
    props: { contentType: 'text/plain' },
    body: text('hello'),
    ...over,
  };
}

async function refusal(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

/** Puts another sealed document in a row, as damage or an older version of the mask would. */
async function replaceSealed(
  history: MemoryPublishHistory,
  id: string,
  dataSealed: Uint8Array,
): Promise<void> {
  const row = await history.get(OWNER, 'c1', id);
  if (row === undefined) throw new Error('no such row');
  history.seed({ ...row, dataSealed });
}

/** What the history holds about a publish, to prove a secret is nowhere in it. */
async function everythingStored(
  history: MemoryPublishHistory,
  sealer: ReturnType<typeof createFakeSealer>,
  ids: readonly string[],
): Promise<string> {
  const parts = [history.dump()];
  for (const id of ids) {
    const sealed = history.sealedOf(id);
    if (sealed !== undefined) {
      parts.push(Buffer.from(sealed).toString('latin1'));
      parts.push(
        Buffer.from(
          await sealer.open('publish_history', 'data_sealed', id, sealed),
        ).toString('utf8'),
      );
    }
  }
  return parts.join('\n');
}

// --- The scripted lease, for the tests that run the action --------------------------------------

function confirmedLease() {
  const calls: { body: Uint8Array }[] = [];
  const count = { releases: 0 };
  const lease: PublishLease = {
    publish(_exchange, _routingKey, body) {
      calls.push({ body });
      return Promise.resolve({
        outcome: 'confirmed' as const,
        proof: mintConfirmedCopyProof({
          destination: 'orders',
          confirmedAt: 1,
        }),
      });
    },
    blocked: () => false,
    release() {
      count.releases += 1;
      return Promise.resolve();
    },
  };
  const unused = (): never => {
    throw new Error('this spec takes a publish lease only');
  };
  const connections: ConnectionManager = {
    peek: unused,
    source: unused,
    observe: unused,
    budget: unused,
    usage: unused,
    publish: () => Promise.resolve(lease),
  };
  const writes: ExecutorWrite = {
    mgmt: {} as ExecutorWrite['mgmt'],
    connections,
  };
  return { calls, count, writes };
}

/** The wired executor, the publish action over `store`, and a way to run it. */
function publisher(
  store: PublishHistory,
  lines: string[],
  lease = confirmedLease(),
) {
  const logger = createLogger({
    level: 'trace',
    sink: { write: (line) => lines.push(line) },
  });
  const engine = createWiredExecutor({
    executor: { writes: lease.writes, logger },
  });
  const action = createMessagesPublishAction({ recorder: store, logger });
  engine.executor.register(action);
  let keys = 0;
  const publish = async (input: unknown) => {
    keys += 1;
    const outcome = await engine.executor.run(
      action.def,
      input,
      createTestContext({ idempotencyKey: `history-spec-${String(keys)}` }),
    );
    if (outcome.kind !== 'output') throw new Error(`got ${outcome.kind}`);
    return outcome.output;
  };
  return { engine, lease, publish };
}

// --- AC-11 ---------------------------------------------------------------------------------------

describe('publish history: re-send data', () => {
  it('M1-19 AC-11 history returns a prior publish for re-sending with secrets masked and stores no secret', async () => {
    const secret = {
      bearer: 'CANARY-bearer-Lq7x2VnB',
      apiKey: 'CANARY-apikey-Rt5w8KcD',
      password: 'CANARY-password-Yh3m6ZpF',
      url: 'CANARY-urlpass-Gd9s1JaE',
    };
    const scanner = createCanaryScanner(Object.values(secret));
    const { store, history, sealer } = setup();
    const body = JSON.stringify({
      user: 'ann',
      password: secret.password,
      callback: `https://svc:${secret.url}@hooks.example.com/in`,
      city: 'London',
    });
    const id = await store.record(
      entry({
        copies: 3,
        summary: { ...ZERO, confirmed: 2, returned: 1 },
        props: { contentType: 'application/json', messageId: 'm-1' },
        headers: {
          Authorization: { t: 'string', v: `Bearer ${secret.bearer}` },
          'x-api-key': { t: 'string', v: secret.apiKey },
          'x-trace': { t: 'string', v: 'trace-1' },
          'x-attempt': { t: 'long', v: 2 },
        },
        body: text(body),
      }),
    );

    const { entry: summary, resend } = await store.get(OWNER, 'c1', id);

    // The same message, as far as it is not a secret.
    expect(resend.exchange).toBe('orders');
    expect(resend.routingKey).toBe('orders.created');
    expect(resend.copies).toBe(3);
    expect(resend.props).toEqual({
      contentType: 'application/json',
      messageId: 'm-1',
    });
    expect(resend.headers?.['x-trace']).toEqual({ t: 'string', v: 'trace-1' });
    expect(resend.headers?.['x-attempt']).toEqual({ t: 'long', v: 2 });
    // The secrets are the mask, and the places are named.
    expect(resend.headers?.Authorization).toEqual({ t: 'string', v: REDACTED });
    expect(resend.headers?.['x-api-key']).toEqual({ t: 'string', v: REDACTED });
    expect(resend.masked).toEqual([
      'header:Authorization',
      'header:x-api-key',
      'body',
    ]);
    expect(JSON.parse(resend.body?.data ?? '')).toEqual({
      user: 'ann',
      password: REDACTED,
      callback: `https://${REDACTED}@hooks.example.com/in`,
      city: 'London',
    });
    expect(resend.bodyOmitted).toBeUndefined();
    // The summary is what the publish was.
    expect(summary).toEqual({
      id,
      at: NOW,
      expiresAt: NOW + PUBLISH_HISTORY_RETENTION_MS,
      vhost: '/',
      exchange: 'orders',
      routingKey: 'orders.created',
      copies: 3,
      summary: { ...ZERO, confirmed: 2, returned: 1 },
      bodyBytes: text(body).byteLength,
      bodySha256: sha256(text(body)),
    });

    // No secret is in anything returned, in any plain column, or in the sealed document opened.
    expect(scanner.scan(JSON.stringify({ summary, resend }))).toEqual([]);
    const stored = await everythingStored(history, sealer, [id]);
    expect(scanner.scan(stored)).toEqual([]);
    expect(stored).toContain('hooks.example.com');
    // The raw row: plain columns, and bytes that are not the document.
    const row = await history.get(OWNER, 'c1', id);
    expect(row?.exchange).toBe('orders');
    expect(Buffer.from(row?.dataSealed ?? []).toString('utf8')).not.toContain(
      'hooks.example.com',
    );
  });

  it('M1-19 history: a secret in a property is masked before sealing, not only on read', async () => {
    const secret = 'CANARY-prop-Hk9y2TsD';
    const { store, history, sealer } = setup();
    const id = await store.record(
      entry({
        props: { replyTo: `https://svc:${secret}@reply.example.com/q` },
      }),
    );
    const stored = await everythingStored(history, sealer, [id]);
    expect(createCanaryScanner([secret]).scan(stored)).toEqual([]);
    expect(stored).toContain('reply.example.com');
    const { resend } = await store.get(OWNER, 'c1', id);
    expect(resend.props).toEqual({
      replyTo: `https://${REDACTED}@reply.example.com/q`,
    });
    expect(resend.masked).toEqual(['prop:replyTo']);
  });

  it('M1-19 history: the sealed document is bound to its row and its place, and a damaged one fails closed', async () => {
    const { store, history, sealer } = setup();
    const a = await store.record(entry());
    const b = await store.record(entry({ routingKey: 'orders.other' }));
    const sealedA = history.sealedOf(a);
    expect(sealedA).toBeDefined();
    // Copy A's document into B's row: the row id is in the AAD, so it does not open.
    await replaceSealed(history, b, sealedA ?? new Uint8Array());
    const copied = await refusal(store.get(OWNER, 'c1', b));
    expect(copied.code).toBe('INTERNAL');
    // A document that opens but is not a history document is refused too.
    const forged = await sealer.seal(
      'publish_history',
      'data_sealed',
      b,
      text('{"v":2,"props":{}}'),
    );
    await replaceSealed(history, b, forged);
    expect((await refusal(store.get(OWNER, 'c1', b))).code).toBe('INTERNAL');
    // And nothing it says is repeated.
    expect(copied.detail ?? '').not.toContain('orders');
    // A locked vault cannot read an entry either.
    sealer.lock();
    expect((await refusal(store.get(OWNER, 'c1', a))).code).toBe('INTERNAL');
  });

  it('M1-19 history: the mask runs again on read, so an entry written under older rules hands back no secret', async () => {
    const secret = 'CANARY-oldrule-Wm4x9QeN';
    const { store, history, sealer } = setup();
    const id = await store.record(entry());
    // An entry sealed by an earlier version of the mask: the secret is in the document.
    const old = await sealer.seal(
      'publish_history',
      'data_sealed',
      id,
      text(
        JSON.stringify({
          v: 1,
          props: { replyTo: `https://u:${secret}@h/` },
          headers: { 'x-token': { t: 'string', v: secret } },
          body: { encoding: 'utf8', data: `{"password":"${secret}"}` },
          masked: ['body'],
        }),
      ),
    );
    await replaceSealed(history, id, old);

    const { resend } = await store.get(OWNER, 'c1', id);

    expect(createCanaryScanner([secret]).scan(JSON.stringify(resend))).toEqual(
      [],
    );
    // What the old mask had reported stays; what the new one found is added once.
    expect(resend.masked).toEqual(['body', 'prop:replyTo', 'header:x-token']);
  });
});

// --- AC-12 ---------------------------------------------------------------------------------------

describe('publish history: retention', () => {
  it('M1-19 AC-12 history purges entries past the 30-day retention and never returns an expired one', async () => {
    expect(PUBLISH_HISTORY_RETENTION_MS).toBe(30 * DAY);
    // Recorded 31 days ago, exactly 30 days ago, and 29 days 23 hours ago, then the clock moves on.
    const clock = createManualClock(NOW - 31 * DAY);
    const { store, history } = setup({ clock });
    const day31 = await store.record(entry({ at: NOW - 31 * DAY }));
    const day30 = await store.record(entry({ at: NOW - 30 * DAY }));
    const day29 = await store.record(entry({ at: NOW - 30 * DAY + HOUR }));
    clock.advance(31 * DAY);
    expect(clock.now()).toBe(NOW);
    expect(history.size()).toBe(3);

    // Before any purge: the list and the read already leave the expired ones out.
    const before = await store.window(OWNER, { connectionId: 'c1' });
    expect(before.entries.map((e) => e.id)).toEqual([day29]);
    expect((await refusal(store.get(OWNER, 'c1', day31))).code).toBe(
      'NOT_FOUND',
    );
    expect((await refusal(store.get(OWNER, 'c1', day30))).code).toBe(
      'NOT_FOUND',
    );
    expect((await store.get(OWNER, 'c1', day29)).entry.id).toBe(day29);
    expect(history.size()).toBe(3);

    // A new publish is recorded, and the write purges the two expired entries.
    const fresh = await store.record(entry({ at: NOW }));
    expect(history.size()).toBe(2);
    expect(
      (await store.window(OWNER, { connectionId: 'c1' })).entries.map(
        (e) => e.id,
      ),
    ).toEqual([fresh, day29]);
    expect(await store.purge()).toBe(0);

    // One more hour and the 29-day entry is the first to go, to the millisecond.
    clock.advance(HOUR - 1);
    expect((await store.get(OWNER, 'c1', day29)).entry.id).toBe(day29);
    clock.advance(1);
    expect((await refusal(store.get(OWNER, 'c1', day29))).code).toBe(
      'NOT_FOUND',
    );
    expect(await store.purge()).toBe(1);
  });

  it('M1-19 history: a purge removes at most 200 rows, whatever it is asked for, and a write purges too', async () => {
    expect(PUBLISH_HISTORY_PURGE_BATCH).toBe(200);
    const { store, history } = setup();
    const seedExpired = (count: number, from: number) => {
      for (let n = 0; n < count; n += 1) {
        history.seed({
          id: `E${String(from + n).padStart(6, '0')}`,
          ownerId: OWNER,
          connectionId: 'c1',
          vhost: '/',
          at: NOW - 40 * DAY,
          expiresAt: NOW - 10 * DAY,
          exchange: 'x',
          routingKey: 'k',
          copies: 1,
          summary: JSON.stringify(ZERO),
          bodyBytes: 0,
          bodySha256: 'b'.repeat(64),
          dataSealed: new Uint8Array([1]),
        });
      }
    };
    seedExpired(450, 0);
    expect(await store.purge(10_000)).toBe(200);
    expect(history.size()).toBe(250);
    expect(await store.purge(5)).toBe(5);
    expect(history.size()).toBe(245);
    // A write purges a batch beside the row it adds.
    await store.record(entry());
    expect(history.size()).toBe(245 - 200 + 1);
    expect(await store.purge()).toBe(45);
    expect(history.size()).toBe(1);
  });

  it('M1-19 history: a purge that fails does not fail the write and is logged without a value', async () => {
    const { store, history, lines } = setup();
    history.purgeExpired = () =>
      Promise.reject(new Error('purge failed: CANARY-purge-Zq1nVb7K'));
    const id = await store.record(entry());
    expect((await store.get(OWNER, 'c1', id)).entry.id).toBe(id);
    expect(lines.join('\n')).toContain('purge-failed');
    expect(
      createCanaryScanner(['CANARY-purge-Zq1nVb7K']).scan(lines.join('\n')),
    ).toEqual([]);
    await expect(store.purge()).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});

// --- AC-13, AC-14 --------------------------------------------------------------------------------

describe('publish history: a failure never changes a publish', () => {
  it('M1-19 AC-13 a failed history write never changes the publish outcome and is flagged', async () => {
    const canary = {
      body: 'CANARY-body-Tn6v3HsM',
      error: 'CANARY-error-Bk2d8WjR',
    };
    const scanner = createCanaryScanner(Object.values(canary));
    const input = {
      ...sampleInput,
      body: {
        encoding: 'utf8' as const,
        data: `{"password":"${canary.body}"}`,
      },
    };

    // The same publish against a healthy store, for what the outcome should be.
    const healthy = setup();
    const baseline = await publisher(healthy.store, []).publish(input);
    expect(baseline.historyRecorded).toBe(true);

    const { store, history, sealer, lines } = setup();
    const run = publisher(store, lines);
    history.failInserts(
      1,
      new Error(`insert failed for ${canary.error} ${canary.body}`),
    );
    const failed = await run.publish(input);

    // Everything but the two history fields is what a healthy publish said.
    expect({
      ...failed,
      historyRecorded: baseline.historyRecorded,
      historyId: baseline.historyId,
    }).toEqual(baseline);
    expect(failed.historyRecorded).toBe(false);
    expect(failed.historyId).toBeUndefined();
    expect(failed.allConfirmed).toBe(true);
    expect(history.size()).toBe(0);
    expect(run.lease.calls).toHaveLength(1);
    expect(run.lease.count.releases).toBe(1);
    // A fixed text in the log, no value from the error or the message.
    expect(lines.join('\n')).toContain('messages.publish.history-failed');
    expect(scanner.scan(lines.join('\n'))).toEqual([]);

    // The next publish records normally.
    const next = await run.publish(input);
    expect(next.historyRecorded).toBe(true);
    expect(history.size()).toBe(1);
    const read = await store.get(OWNER, 'c1', next.historyId ?? '');
    expect(read.entry.copies).toBe(1);
    expect(
      scanner.scan(
        await everythingStored(history, sealer, [next.historyId ?? '']),
      ),
    ).toEqual([]);

    // The store itself says nothing it was told.
    history.failInserts(1, new Error(`boom ${canary.error}`));
    const direct = await refusal(store.record(entry()));
    expect(direct.code).toBe('INTERNAL');
    expect(scanner.scan(`${direct.message} ${direct.detail ?? ''}`)).toEqual(
      [],
    );
    expect(direct.cause).toBeUndefined();
  });

  it('M1-19 AC-14 history stores nothing while the vault is locked', async () => {
    const canary = 'CANARY-locked-Pf5c1XyA';
    const input = {
      ...sampleInput,
      body: { encoding: 'utf8' as const, data: `{"password":"${canary}"}` },
    };
    const { store, history, sealer, lines } = setup();
    const run = publisher(store, lines);

    sealer.lock();
    const published = await run.publish(input);

    // The message went out; the history holds nothing, in any form.
    expect(run.lease.calls).toHaveLength(1);
    expect(published.copies.map((c) => c.outcome)).toEqual(['confirmed']);
    expect(published.allConfirmed).toBe(true);
    expect(published.historyRecorded).toBe(false);
    expect(published.historyId).toBeUndefined();
    expect(history.size()).toBe(0);
    expect(history.dump()).not.toContain(canary);
    expect(sealer.sealedCount()).toBe(0);
    expect(createCanaryScanner([canary]).scan(lines.join('\n'))).toEqual([]);

    // The store says why, in words that name no value.
    const direct = await refusal(store.record(entry()));
    expect(direct.code).toBe('GATE_BLOCKED');
    expect(direct.cause).toBeUndefined();
    expect(history.size()).toBe(0);

    // Unlocked, the next publish is recorded.
    sealer.unlock();
    const again = await run.publish(input);
    expect(again.historyRecorded).toBe(true);
    expect(history.size()).toBe(1);
  });

  it('M1-19 history: a document over the sealed limit is refused with a fixed text before anything is stored', async () => {
    const { store, history, sealer } = setup();
    // 64 headers of 65,535 characters each: a legal publish whose masked document is over 1 MiB.
    const headers = Object.fromEntries(
      Array.from({ length: 64 }, (_, n) => [
        `h${String(n)}`,
        { t: 'string' as const, v: 'ab '.repeat(20_000) },
      ]),
    );
    const error = await refusal(store.record(entry({ headers })));
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(history.size()).toBe(0);
    expect(sealer.sealedCount()).toBe(0);
    expect(PUBLISH_HISTORY_MAX_SEALED_BYTES).toBe(1_048_576);
  });
});

// --- AC-15 ---------------------------------------------------------------------------------------

describe('publish history: scope and windows', () => {
  it('M1-19 AC-15 history is scoped to its owner and connection and lists in bounded keyset windows', async () => {
    const { store } = setup();
    const mine: string[] = [];
    // 120 entries on c1; every third shares its time with the one before, so the order needs the id.
    for (let n = 0; n < 120; n += 1) {
      mine.push(
        await store.record(
          entry({
            at: NOW - Math.floor(n / 3) * 1000,
            routingKey: `k.${String(n)}`,
          }),
        ),
      );
    }
    const onC2 = await store.record(entry({ connectionId: 'c2' }));
    const theirs: string[] = [];
    for (let n = 0; n < 5; n += 1) {
      theirs.push(await store.record(entry({ ownerId: OTHER })));
    }

    // The window: newest first, (at, id) descending, and exactly the owner's rows on that connection.
    const expectedOrder = [...mine].sort((a, b) => {
      const at = (id: string) => NOW - Math.floor(mine.indexOf(id) / 3) * 1000;
      return at(b) - at(a) || (a < b ? 1 : -1);
    });
    const first = await store.window(OWNER, { connectionId: 'c1' });
    expect(PUBLISH_HISTORY_DEFAULT_WINDOW).toBe(50);
    expect(first.entries).toHaveLength(50);
    expect(first.nextCursor).toBeDefined();

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await store.window(OWNER, {
        connectionId: 'c1',
        limit: 37,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(page.entries.length).toBeLessThanOrEqual(37);
      seen.push(...page.entries.map((e) => e.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined && pages < 10);
    // No gap and no repeat: the pages concatenate to the whole list, in order.
    expect(pages).toBe(4);
    expect(seen).toEqual(expectedOrder);
    expect(new Set(seen).size).toBe(120);

    // The largest window is 200, and it returns everything there is without a cursor.
    const all = await store.window(OWNER, { connectionId: 'c1', limit: 200 });
    expect(all.entries).toHaveLength(120);
    expect(all.nextCursor).toBeUndefined();
    // A window of exactly the size of the list has no next page either.
    const exact = await store.window(OWNER, { connectionId: 'c1', limit: 120 });
    expect(exact.nextCursor).toBeUndefined();
    const short = await store.window(OWNER, { connectionId: 'c1', limit: 119 });
    expect(short.nextCursor).toBeDefined();

    // Another owner and another connection see only their own.
    expect(
      (await store.window(OTHER, { connectionId: 'c1' })).entries
        .map((e) => e.id)
        .sort(),
    ).toEqual([...theirs].sort());
    expect(
      (await store.window(OWNER, { connectionId: 'c2' })).entries.map(
        (e) => e.id,
      ),
    ).toEqual([onC2]);
    expect(
      (await store.window('user-3', { connectionId: 'c1' })).entries,
    ).toEqual([]);

    // get: another owner's id, another connection's id and an unknown id all answer alike.
    const id = mine[0] ?? '';
    const answers = [
      await refusal(store.get(OTHER, 'c1', id)),
      await refusal(store.get(OWNER, 'c2', id)),
      await refusal(store.get(OWNER, 'c1', 'P999999')),
      await refusal(store.get(OWNER, 'c1', theirs[0] ?? '')),
    ];
    for (const answer of answers) {
      expect(answer.code).toBe('NOT_FOUND');
      expect(answer.detail).toBe(answers[0]?.detail);
      expect(answer.detail).not.toContain(id);
    }
    expect((await store.get(OWNER, 'c1', id)).entry.id).toBe(id);

    // A limit that is not 1 to 200, and a cursor that is not one, are refused.
    for (const limit of [0, 201, 1_000_000, 1.5, -1, Number.NaN]) {
      const refused = await refusal(
        store.window(OWNER, { connectionId: 'c1', limit }),
      );
      expect(refused.code).toBe('VALIDATION_FAILED');
      // The store says what is wrong with the limit; the repository's own refusal is only a backstop.
      expect(refused.detail).toContain('limit');
    }
    expect(
      (await store.window(OWNER, { connectionId: 'c1', limit: 1 })).entries,
    ).toHaveLength(1);
    expect(
      (
        await refusal(
          store.window(OWNER, { connectionId: 'c1', cursor: 'not-a-cursor' }),
        )
      ).code,
    ).toBe('VALIDATION_FAILED');
  });

  it('M1-19 history: a window filters by vhost, exchange, a case-sensitive routing-key prefix and a time range', async () => {
    const { store } = setup();
    const a = await store.record(
      entry({
        vhost: '/',
        exchange: 'orders',
        routingKey: 'orders.created',
        at: NOW - 3000,
      }),
    );
    const b = await store.record(
      entry({
        vhost: 'eu',
        exchange: 'orders',
        routingKey: 'Orders.shipped',
        at: NOW - 2000,
      }),
    );
    const c = await store.record(
      entry({
        vhost: 'eu',
        exchange: 'billing',
        routingKey: 'orders.paid',
        at: NOW - 1000,
      }),
    );
    const ids = async (query: Parameters<typeof store.window>[1]) =>
      (await store.window(OWNER, query)).entries.map((e) => e.id);
    expect(await ids({ connectionId: 'c1' })).toEqual([c, b, a]);
    expect(await ids({ connectionId: 'c1', vhost: 'eu' })).toEqual([c, b]);
    expect(await ids({ connectionId: 'c1', exchange: 'orders' })).toEqual([
      b,
      a,
    ]);
    expect(
      await ids({ connectionId: 'c1', routingKeyPrefix: 'orders.' }),
    ).toEqual([c, a]);
    expect(
      await ids({ connectionId: 'c1', routingKeyPrefix: 'Orders' }),
    ).toEqual([b]);
    expect(
      await ids({ connectionId: 'c1', from: NOW - 2000, to: NOW - 2000 }),
    ).toEqual([b]);
    expect(await ids({ connectionId: 'c1', from: NOW - 2000 })).toEqual([c, b]);
    expect(await ids({ connectionId: 'c1', to: NOW - 2000 })).toEqual([b, a]);
    expect(
      await ids({
        connectionId: 'c1',
        vhost: 'eu',
        exchange: 'orders',
        routingKeyPrefix: 'O',
      }),
    ).toEqual([b]);
  });

  it('M1-19 history: a window holds no property, header or body, only the plain facts', async () => {
    const { store } = setup();
    await store.record(
      entry({
        props: { correlationId: 'corr-secret-value' },
        headers: { 'x-trace': { t: 'string', v: 'hdr-secret-value' } },
        body: text('body-secret-value'),
      }),
    );
    const page = await store.window(OWNER, { connectionId: 'c1' });
    const written = JSON.stringify(page);
    expect(written).not.toContain('corr-secret-value');
    expect(written).not.toContain('hdr-secret-value');
    expect(written).not.toContain('body-secret-value');
    expect(Object.keys(page.entries[0] ?? {}).sort()).toEqual(
      [
        'at',
        'bodyBytes',
        'bodySha256',
        'copies',
        'exchange',
        'expiresAt',
        'id',
        'routingKey',
        'summary',
        'vhost',
      ].sort(),
    );
  });
});

// --- AC-16 ---------------------------------------------------------------------------------------

describe('publish history: bodies', () => {
  it('M1-19 AC-16 history omits binary and oversized bodies and says so', async () => {
    const { store, history, sealer } = setup();
    const binary = Uint8Array.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x41]);
    const nul = text('looks\0like text');
    const huge = text('word '.repeat(13_108)); // 65,540 bytes
    const atLimit = text('a'.repeat(64 * 1024));
    const plain = text('{"city":"London"}');

    const ids = {
      binary: await store.record(entry({ body: binary })),
      nul: await store.record(entry({ body: nul })),
      huge: await store.record(entry({ body: huge })),
      atLimit: await store.record(entry({ body: atLimit })),
      plain: await store.record(entry({ body: plain })),
    };

    const read = async (id: string) => store.get(OWNER, 'c1', id);
    const b = await read(ids.binary);
    expect(b.resend.bodyOmitted).toBe('binary');
    expect(b.resend).not.toHaveProperty('body');
    expect(b.entry.bodyBytes).toBe(binary.byteLength);
    expect(b.entry.bodySha256).toBe(sha256(binary));

    const n = await read(ids.nul);
    expect(n.resend.bodyOmitted).toBe('binary');
    expect(n.resend).not.toHaveProperty('body');

    const h = await read(ids.huge);
    expect(h.resend.bodyOmitted).toBe('too-large');
    expect(h.resend).not.toHaveProperty('body');
    expect(h.entry.bodyBytes).toBe(huge.byteLength);
    expect(h.entry.bodySha256).toBe(sha256(huge));
    expect(h.resend.masked).not.toContain('body');

    // The limit is inclusive; a long run of one letter is shown as the marker, not dropped.
    const l = await read(ids.atLimit);
    expect(l.resend.bodyOmitted).toBeUndefined();
    expect(l.resend.body?.encoding).toBe('utf8');
    expect(l.entry.bodyBytes).toBe(64 * 1024);

    const p = await read(ids.plain);
    expect(p.resend.body).toEqual({
      encoding: 'utf8',
      data: '{"city":"London"}',
    });
    expect(p.resend.bodyOmitted).toBeUndefined();
    expect(p.resend.masked).toEqual([]);
    expect(p.entry.bodySha256).toBe(sha256(plain));

    // An omitted body is nowhere in the sealed document either: nothing to read back, nothing to leak.
    const opened = Buffer.from(
      await sealer.open(
        'publish_history',
        'data_sealed',
        ids.binary,
        history.sealedOf(ids.binary) ?? new Uint8Array(),
      ),
    ).toString('utf8');
    expect(JSON.parse(opened)).toEqual({
      v: 1,
      props: { contentType: 'text/plain' },
      bodyOmitted: 'binary',
      masked: [],
    });
  });
});
