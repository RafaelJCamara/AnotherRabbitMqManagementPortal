import {
  messagesPublish,
  messagesPublishHistoryGet,
  messagesPublishHistoryList,
} from '@app/contracts';
import {
  createLogger,
  createManualClock,
  createTestContext,
  createTestExecutor,
  type ActionImpl,
  type ExecutorWrite,
} from '@app/kernel';
import {
  mintConfirmedCopyProof,
  type ConnectionManager,
  type PublishLease,
} from '@app/ports';
import { describe, expect, it } from 'vitest';

import { createMessagesModule } from './module';
import {
  createMemoryPublishHistory,
  createMessagesFakeModuleDeps,
} from './testing';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe('createMessagesModule', () => {
  it('registers the module under the project name', () => {
    expect(createMessagesModule(createMessagesFakeModuleDeps()).id).toBe(
      'svc-messages',
    );
  });

  // The topic and job generators register into these lists, so the module's own spec does not pin
  // their contents: each registered item has its own spec.
  it('lists its actions, topics and jobs', () => {
    const module = createMessagesModule(createMessagesFakeModuleDeps());

    expect(Array.isArray(module.actions)).toBe(true);
    expect(Array.isArray(module.topics)).toBe(true);
    expect(Array.isArray(module.jobs)).toBe(true);
  });
});

/** A manager that hands out one lease, which confirms every copy. */
function confirmingWrites(): ExecutorWrite {
  const lease: PublishLease = {
    publish: () =>
      Promise.resolve({
        outcome: 'confirmed',
        proof: mintConfirmedCopyProof({
          destination: 'orders',
          confirmedAt: 1,
        }),
      }),
    blocked: () => false,
    release: () => Promise.resolve(),
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
  return { mgmt: {} as ExecutorWrite['mgmt'], connections };
}

const publishInput = {
  cid: 'c1',
  vhost: '/',
  exchange: '',
  routingKey: 'orders',
  props: {},
  body: { encoding: 'utf8', data: 'hello' },
};

describe('createMessagesModule (M1-19 slice D)', () => {
  it('M1-19 slice D: the module serves the publish action and the two history reads', () => {
    const module = createMessagesModule(createMessagesFakeModuleDeps());

    expect(
      (module.actions as readonly ActionImpl[])
        .map((action) => action.def.id as string)
        .sort(),
    ).toEqual([
      messagesPublish.id,
      messagesPublishHistoryGet.id,
      messagesPublishHistoryList.id,
    ]);
  });

  it('M1-19 slice D: a publish through the module is recorded, and the history reads it back', async () => {
    const module = createMessagesModule(createMessagesFakeModuleDeps());
    const engine = createTestExecutor({
      executor: { writes: confirmingWrites() },
    });
    engine.executor.register(...(module.actions as readonly ActionImpl[]));
    let keys = 0;
    const context = () => {
      keys += 1;
      return createTestContext({
        idempotencyKey: `module-spec-${String(keys)}`,
      });
    };

    const published = await engine.executor.run(
      messagesPublish,
      publishInput,
      context(),
    );
    if (published.kind !== 'output') throw new Error(published.kind);
    const listed = await engine.executor.run(
      messagesPublishHistoryList,
      { cid: 'c1' },
      context(),
    );
    if (listed.kind !== 'output') throw new Error(listed.kind);

    expect(published.output).toMatchObject({
      allConfirmed: true,
      historyRecorded: true,
      historyId: 'entry-1',
    });
    expect(listed.output.entries.map((entry) => entry.id)).toEqual(['entry-1']);
    expect(listed.output.entries[0]).toMatchObject({
      routingKey: 'orders',
      summary: { confirmed: 1 },
    });
  });

  it('M1-19 slice D: a history that cannot be written does not change the publish and is flagged', async () => {
    const history = createMemoryPublishHistory();
    history.failInserts(1, new Error('SECRET-store-text'));
    const lines: string[] = [];
    const module = createMessagesModule(
      createMessagesFakeModuleDeps({
        history,
        logger: createLogger({
          level: 'trace',
          sink: { write: (line) => lines.push(line) },
        }),
      }),
    );
    const engine = createTestExecutor({
      executor: { writes: confirmingWrites() },
    });
    engine.executor.register(...(module.actions as readonly ActionImpl[]));

    const outcome = await engine.executor.run(
      messagesPublish,
      publishInput,
      createTestContext({ idempotencyKey: 'module-spec-failing' }),
    );

    if (outcome.kind !== 'output') throw new Error(outcome.kind);
    expect(outcome.output).toMatchObject({
      allConfirmed: true,
      historyRecorded: false,
    });
    expect(outcome.output.historyId).toBeUndefined();
    expect(history.size()).toBe(0);
    expect(lines.join('\n')).not.toContain('SECRET-store-text');
  });

  it('M1-19 slice D: the module purges expired entries when it starts, and a purge that fails does not stop it', async () => {
    const clock = createManualClock(NOW);
    const history = createMemoryPublishHistory();
    const row = (id: string, expiresAt: number) => ({
      id,
      ownerId: 'user-1',
      connectionId: 'c1',
      vhost: '/',
      at: expiresAt - 30 * DAY,
      expiresAt,
      exchange: '',
      routingKey: 'orders',
      copies: 1,
      summary: '{}',
      bodyBytes: 0,
      bodySha256: '0'.repeat(64),
      dataSealed: new Uint8Array(),
    });
    history.seed(row('expired', NOW - 1));
    history.seed(row('due', NOW));
    history.seed(row('kept', NOW + 1));

    createMessagesModule(createMessagesFakeModuleDeps({ history, clock }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(history.size()).toBe(1);
    expect(history.dump()).toContain('kept');

    // A store that cannot purge is logged with a fixed text and leaves the module standing.
    const lines: string[] = [];
    const broken = createMemoryPublishHistory();
    broken.purgeExpired = () => Promise.reject(new Error('SECRET-purge-text'));
    const module = createMessagesModule(
      createMessagesFakeModuleDeps({
        history: broken,
        logger: createLogger({
          level: 'trace',
          sink: { write: (line) => lines.push(line) },
        }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(module.id).toBe('svc-messages');
    expect(lines.join('\n')).toContain('purge-failed');
    expect(lines.join('\n')).not.toContain('SECRET-purge-text');
  });
});
