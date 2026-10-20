import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

import type { ChannelModel } from 'amqplib';
import type { Connection } from 'rhea';
import { describe, expect, it } from 'vitest';

import type { RawDelivery } from './driver/amqp091-raw.ts';
import {
  type Attempt,
  awaitReady,
  bindQueue,
  closeChannel,
  closeConnection,
  consume,
  declareExchange,
  declareQueue,
  defineScenario,
  get,
  grantCredit,
  mgmtGet,
  mgmtQueue,
  observe,
  openChannel,
  openConnection,
  openReceiver,
  publish,
  receive,
  recover,
  ref,
  runScenario,
  settle,
  settleAmqp10,
  tryGet,
  wait,
  type Amqp10Host,
  type LabStep,
  type RunClock,
} from './dsl.ts';
import { sealArtefact } from './record/evidence.ts';
import { openLabHost } from './record/record.ts';
import { findSecrets } from './record/secrets.ts';
import { SCENARIOS } from './scenarios/index.ts';
import { recordOnEra, type Era } from './testing/era-broker.ts';
import {
  DIGEST,
  localProvenance,
  MemoryHost,
  mintEndpoint,
  VERSION,
} from './testing/lab.ts';

const scenario = (...steps: LabStep[]) =>
  defineScenario({
    cfId: 'CF-TEST-01',
    title: 'a test scenario',
    protocol: 'amqp091',
    steps,
  });

const run = (host: MemoryHost, ...steps: LabStep[]) =>
  runScenario(host, scenario(...steps), 'abcd1234');

describe('defineScenario catches a mistake before any broker is involved', () => {
  it.each([
    [
      'an id that is not a conformance id',
      () =>
        defineScenario({
          cfId: 'smoke',
          title: 't',
          protocol: 'amqp091',
          steps: [openChannel('a')],
        }),
      /not a conformance id/,
    ],
    ['no steps', () => scenario(), /no steps/],
    [
      'a publish to an undeclared queue',
      () => scenario(publish('q', 'm1')),
      /not declared yet/,
    ],
    [
      'a get from an undeclared queue',
      () => scenario(get('d', 'q')),
      /not declared yet/,
    ],
    [
      'a duplicate message id',
      () => scenario(declareQueue('q'), publish('q', 'm1'), publish('q', 'm1')),
      /used twice/,
    ],
    [
      'a duplicate alias',
      () =>
        scenario(
          declareQueue('q'),
          publish('q', 'm1'),
          get('d', 'q'),
          get('d', 'q'),
        ),
      /alias "d" is used twice/,
    ],
    [
      'a settle of something never delivered',
      () => scenario(declareQueue('q'), settle('nope', { kind: 'ack' })),
      /was not delivered/,
    ],
    [
      'a settle on a channel that is not open',
      () =>
        scenario(
          declareQueue('q'),
          publish('q', 'm1'),
          get('d', 'q'),
          settle('d', { kind: 'ack' }, { channel: 'side' }),
        ),
      /not open/,
    ],
    [
      'a get on a channel that is not open',
      () => scenario(declareQueue('q'), get('d', 'q', { channel: 'side' })),
      /not open/,
    ],
    [
      'opening a channel twice',
      () => scenario(openChannel('side'), openChannel('side')),
      /invalid or already open/,
    ],
    [
      'opening the main channel again',
      () => scenario(openChannel('main')),
      /invalid or already open/,
    ],
    [
      'a bad channel alias',
      () => scenario(openChannel('Side Channel')),
      /invalid or already open/,
    ],
    [
      'a bad queue alias',
      () => scenario(declareQueue('My Queue')),
      /not lower-case words/,
    ],
    [
      'a bad delivery alias',
      () => scenario(declareQueue('q'), get('D1', 'q')),
      /not lower-case words/,
    ],
    [
      'a consume of zero',
      () => scenario(declareQueue('q'), consume('c', 'q', 0)),
      /count of at least 1/,
    ],
    [
      'a consume alias used twice',
      () =>
        scenario(declareQueue('q'), consume('c', 'q', 1), consume('c', 'q', 2)),
      /used twice/,
    ],
    [
      'a mgmtGet of zero',
      () => scenario(declareQueue('q'), mgmtGet('g', 'q', { count: 0 })),
      /count of at least 1/,
    ],
    [
      'an observe of an undeclared queue',
      () => scenario(observe('o', 'q')),
      /not declared yet/,
    ],
    [
      'a recover on a channel that is not open',
      () => scenario(recover('side')),
      /not open/,
    ],
    [
      'closing a channel that is not open',
      () => scenario(closeChannel('side')),
      /not open/,
    ],
  ])('refuses %s', (_name, build, reason) => {
    expect(build).toThrow(reason);
  });

  it('says which step is wrong', () => {
    expect(() => scenario(declareQueue('q'), publish('x', 'm1'))).toThrow(
      'CF-TEST-01 step 1',
    );
  });

  it('accepts a settle by a consume reference, by a raw tag and from another open channel', () => {
    expect(() =>
      scenario(
        declareQueue('q'),
        openChannel('side'),
        publish('q', 'm1'),
        consume('c', 'q', 1),
        settle('c.0', { kind: 'ack' }),
        settle(999, { kind: 'ack' }, { channel: 'side' }),
        mgmtGet('g', 'q'),
        observe('o', 'q', { channel: 'side' }),
      ),
    ).not.toThrow();
  });

  it('declares a durable classic queue unless asked otherwise', () => {
    expect(declareQueue('q')).toMatchObject({
      type: 'classic',
      durable: true,
      arguments: {},
    });
    expect(declareQueue('q', { type: 'quorum', durable: false })).toMatchObject(
      { type: 'quorum', durable: false },
    );
  });
});

describe('runScenario records what happened', () => {
  it('AC-1 (M0-15) CF-SMOKE-01 on a classic queue: nack with requeue returns the message first, redelivered', async () => {
    const host = new MemoryHost();

    const result = await run(
      host,
      declareQueue('q'),
      publish('q', 'm1'),
      publish('q', 'm2'),
      get('first', 'q'),
      settle('first', { kind: 'nack', requeue: true }),
      observe('after', 'q'),
    );

    expect(result.observations).toEqual([
      {
        name: 'after',
        messageId: 'm1',
        survived: true,
        position: 0,
        redelivered: true,
        'x-delivery-count': null,
        'x-acquired-count': null,
      },
      {
        name: 'after',
        messageId: 'm2',
        survived: true,
        position: 1,
        redelivered: false,
        'x-delivery-count': null,
        'x-acquired-count': null,
      },
    ]);
    expect(result.steps.map((step) => [step.index, step.op])).toEqual([
      [0, 'declareQueue'],
      [1, 'publish'],
      [2, 'publish'],
      [3, 'get'],
      [4, 'settle'],
      [5, 'observe'],
    ]);
    expect(result.steps[3]?.result).toMatchObject({
      empty: false,
      messageId: 'm1',
      redelivered: false,
      deliveryTag: 1,
    });
    expect(result.steps[4]).toMatchObject({
      args: {
        target: 'first',
        deliveryTag: 1,
        channel: 'main',
        action: 'nack',
        requeue: true,
        multiple: null,
      },
      result: { channelOpen: true, closed: null },
    });
  });

  it('an ack removes the message: it did not survive, and has no position', async () => {
    const result = await run(
      new MemoryHost(),
      declareQueue('q'),
      publish('q', 'm1'),
      get('d', 'q'),
      settle('d', { kind: 'ack' }),
      observe('after', 'q'),
    );

    expect(result.observations).toEqual([
      {
        name: 'after',
        messageId: 'm1',
        survived: false,
        position: null,
        redelivered: null,
        'x-delivery-count': null,
        'x-acquired-count': null,
      },
    ]);
  });

  it('a requeue false (nack and reject) loses the message in a queue without a dead-letter exchange', async () => {
    for (const action of [
      { kind: 'nack', requeue: false },
      { kind: 'reject', requeue: false },
    ] as const) {
      const result = await run(
        new MemoryHost(),
        declareQueue('q'),
        publish('q', 'm1'),
        get('d', 'q'),
        settle('d', action),
        observe('after', 'q'),
      );

      expect(result.observations[0]).toMatchObject({ survived: false });
      expect(result.steps[3]?.args).toMatchObject({
        action: action.kind,
        requeue: false,
      });
    }
  });

  it('forbidden: settling a tag that was never delivered closes the channel, and the closure is recorded', async () => {
    const result = await run(
      new MemoryHost(),
      declareQueue('q'),
      settle(999, { kind: 'ack' }),
    );

    expect(result.steps[1]).toMatchObject({
      args: { target: null, deliveryTag: 999, channel: 'main', action: 'ack' },
      result: {
        channelOpen: false,
        closed: {
          code: 406,
          text: 'PRECONDITION_FAILED - unknown delivery tag 999',
        },
      },
    });
  });

  it('forbidden: acknowledging twice, and acknowledging from another channel than the delivery came on', async () => {
    const twice = await run(
      new MemoryHost(),
      declareQueue('q'),
      publish('q', 'm1'),
      get('d', 'q'),
      settle('d', { kind: 'ack' }),
      settle('d', { kind: 'ack' }),
    );
    expect(twice.steps[3]?.result).toMatchObject({ channelOpen: true });
    expect(twice.steps[4]?.result).toMatchObject({
      channelOpen: false,
      closed: { code: 406 },
    });

    const wrong = await run(
      new MemoryHost(),
      declareQueue('q'),
      openChannel('other'),
      publish('q', 'm1'),
      get('d', 'q'),
      settle('d', { kind: 'ack' }, { channel: 'other' }),
    );
    expect(wrong.steps[4]).toMatchObject({
      args: { channel: 'other', deliveryTag: 1 },
      result: { channelOpen: false },
    });
  });

  it('a settle defaults to the channel the delivery came on', async () => {
    const result = await run(
      new MemoryHost(),
      declareQueue('q'),
      openChannel('side'),
      publish('q', 'm1'),
      get('d', 'q', { channel: 'side' }),
      settle('d', { kind: 'ack' }),
    );

    expect(result.steps[4]).toMatchObject({
      args: { channel: 'side' },
      result: { channelOpen: true },
    });
  });

  it('a settle after the channel is closed is recorded as a closed channel', async () => {
    const result = await run(
      new MemoryHost(),
      declareQueue('q'),
      publish('q', 'm1'),
      get('d', 'q'),
      closeChannel('main'),
      settle('d', { kind: 'ack' }),
    );

    expect(result.steps[4]?.result).toMatchObject({
      channelOpen: false,
      closed: { text: 'closed by the client' },
    });
  });

  it('consume records each delivery under its reference, and each can be settled', async () => {
    const result = await run(
      new MemoryHost(),
      declareQueue('q'),
      publish('q', 'm1'),
      publish('q', 'm2'),
      consume('c', 'q', 2),
      settle('c.1', { kind: 'nack', requeue: true, multiple: true }),
      recover(),
    );

    expect(result.steps[3]?.result).toMatchObject({
      deliveries: [
        { ref: 'c.0', messageId: 'm1', deliveryTag: 1 },
        { ref: 'c.1', messageId: 'm2', deliveryTag: 2 },
      ],
    });
    expect(result.steps[4]?.args).toMatchObject({
      target: 'c.1',
      deliveryTag: 2,
      multiple: true,
    });
    expect(result.steps[5]).toMatchObject({
      op: 'recover',
      args: { channel: 'main' },
    });
  });

  it('a get on an empty queue is recorded as empty, and its alias cannot be settled', async () => {
    const empty = await run(new MemoryHost(), declareQueue('q'), get('d', 'q'));
    expect(empty.steps[1]?.result).toEqual({ empty: true });

    await expect(
      run(
        new MemoryHost(),
        declareQueue('q'),
        get('d', 'q'),
        settle('d', { kind: 'ack' }),
      ),
    ).rejects.toThrow(/was not delivered/);
  });

  it('mgmtGet posts to the queue of this run and records the messages, not their payloads', async () => {
    const host = new MemoryHost('4.3.6', {
      managementJson: [
        {
          redelivered: true,
          payload_bytes: 2,
          message_count: 0,
          payload: 'SECRET-BODY',
          properties: { message_id: 'm1', headers: { token: 'x' } },
        },
        { redelivered: false },
      ],
    });

    const result = await run(
      host,
      declareQueue('q'),
      publish('q', 'm1'),
      mgmtGet('g', 'q', { count: 2, ackmode: 'ack_requeue_false' }),
    );

    expect(host.managementCalls).toEqual([
      {
        method: 'POST',
        path: '/api/queues/%2F/lab-cf-test-01-abcd1234-q/get',
        body: { count: 2, ackmode: 'ack_requeue_false', encoding: 'auto' },
      },
    ]);
    expect(result.steps[2]).toMatchObject({
      args: { as: 'g', queue: 'q', count: 2, ackmode: 'ack_requeue_false' },
      result: {
        status: 200,
        messages: [
          {
            messageId: 'm1',
            redelivered: true,
            payloadBytes: 2,
            messageCount: 0,
          },
          {
            messageId: null,
            redelivered: false,
            payloadBytes: null,
            messageCount: null,
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain('SECRET-BODY');
    expect(JSON.stringify(result)).not.toContain('token');
  });

  it('mgmtGet records no messages when the answer is not a list', async () => {
    const host = new MemoryHost('4.3.6', {
      managementJson: { error: 'not_found' },
    });

    const result = await run(host, declareQueue('q'), mgmtGet('g', 'q'));

    expect(result.steps[1]?.result).toEqual({ status: 200, messages: [] });
  });

  it('I-10 a step records sizes, ids and tags, never a body', async () => {
    const result = await run(
      new MemoryHost(),
      declareQueue('q'),
      publish('q', 'm1', 'the-secret-payload'),
      get('d', 'q'),
    );

    expect(JSON.stringify(result)).not.toContain('the-secret-payload');
    expect(result.steps[1]?.args).toEqual({
      queue: 'q',
      messageId: 'm1',
      bytes: 18,
    });
  });

  it('queues carry the run id on the broker and the alias in the record; they are deleted afterwards', async () => {
    const host = new MemoryHost();

    const result = await run(host, declareQueue('q'), publish('q', 'm1'));

    expect(host.calls).toEqual([
      'declare lab-cf-test-01-abcd1234-q',
      'delete lab-cf-test-01-abcd1234-q',
    ]);
    expect(JSON.stringify(result)).not.toContain('abcd1234');
  });

  it('deletes its queues even when a step fails, and says what failed', async () => {
    const host = new MemoryHost();
    host.failOn = 'publish';

    await expect(
      run(host, declareQueue('q'), publish('q', 'm1')),
    ).rejects.toThrow('nack from the broker');
    expect(host.calls).toContain('delete lab-cf-test-01-abcd1234-q');
  });

  it('a failed cleanup does not hide the result', async () => {
    const host = new MemoryHost();
    host.deleteQueue = () => Promise.reject(new Error('channel closed'));

    await expect(
      run(host, declareQueue('q'), publish('q', 'm1')),
    ).resolves.toHaveProperty('steps.length', 2);
  });

  it('observe refuses a queue that holds a message the scenario did not publish', async () => {
    const host = new MemoryHost();
    const publishStray = host.declareQueue.bind(host);
    host.declareQueue = async (queue) => {
      await publishStray(queue);
      host.queues.get(queue)?.push({ id: 'stranger', redelivered: false });
    };

    await expect(
      run(host, declareQueue('q'), publish('q', 'm1'), observe('o', 'q')),
    ).rejects.toThrow(/did not publish/);
  });

  it('observe refuses a message without an id', async () => {
    const host = new MemoryHost();
    host.get = () =>
      Promise.resolve({
        tag: 1,
        redelivered: false,
        messageId: null,
        bytes: 1,
        messageCount: 0,
        xDeliveryCount: null,
        xAcquiredCount: null,
      });

    await expect(
      run(host, declareQueue('q'), publish('q', 'm1'), observe('o', 'q')),
    ).rejects.toThrow(/did not publish/);
  });

  it('observe refuses a queue that returns the same message twice', async () => {
    const host = new MemoryHost();
    host.get = () =>
      Promise.resolve({
        tag: 1,
        redelivered: false,
        messageId: 'm1',
        bytes: 1,
        messageCount: 0,
        xDeliveryCount: null,
        xAcquiredCount: null,
      });

    await expect(
      run(host, declareQueue('q'), publish('q', 'm1'), observe('o', 'q')),
    ).rejects.toThrow(/did not publish/);
  });

  it('observe records the delivery counters the broker reports', async () => {
    const host = new MemoryHost();
    const original = host.get.bind(host);
    host.get = async (channel, queue, noAck) => {
      const delivery = await original(channel, queue, noAck);
      return delivery && { ...delivery, xDeliveryCount: 3, xAcquiredCount: 4 };
    };

    const result = await run(
      host,
      declareQueue('q'),
      publish('q', 'm1'),
      observe('o', 'q'),
    );

    expect(result.observations[0]).toMatchObject({
      'x-delivery-count': 3,
      'x-acquired-count': 4,
    });
  });

  it('observe fails, rather than record a partial drain, when the queue holds more than the limit', async () => {
    const steps = [
      declareQueue('q'),
      publish('q', 'm1'),
      publish('q', 'm2'),
      publish('q', 'm3'),
      observe('o', 'q'),
    ];

    await expect(
      runScenario(new MemoryHost(), scenario(...steps), 'abcd1234', 2),
    ).rejects.toThrow('holds more than 2 messages');
    // Exactly the limit is fine: the drain ends on an empty answer.
    const exact = await runScenario(
      new MemoryHost(),
      scenario(...steps),
      'abcd1234',
      3,
    );
    expect(exact.observations.map((item) => item.survived)).toEqual([
      true,
      true,
      true,
    ]);
  });
});

describe('DOWN-event steps: a second connection, a consumer left active, a bounded wait', () => {
  it('AC-3 connection steps are checked when the scenario is defined', () => {
    // A step on a connection that was never opened.
    expect(() => scenario(openChannel('h', { connection: 'holder' }))).toThrow(
      'CF-TEST-01 step 0: connection "holder" is not open',
    );
    expect(() => scenario(closeConnection('holder'))).toThrow(
      /connection "holder" is not open/,
    );
    // A duplicate connection name, and the default one cannot be opened again.
    expect(() =>
      scenario(openConnection('holder'), openConnection('holder')),
    ).toThrow('step 1: connection "holder" is invalid or already used');
    expect(() => scenario(openConnection('main'))).toThrow(/already used/);
    // The default connection is never closed.
    expect(() => scenario(closeConnection('main'))).toThrow(
      /main connection is never closed/,
    );
    // A channel on a closed connection, and a second close.
    const opened = [openConnection('holder'), closeConnection('holder')];
    expect(() =>
      scenario(...opened, openChannel('h', { connection: 'holder' })),
    ).toThrow(/connection "holder" is not open/);
    expect(() => scenario(...opened, closeConnection('holder'))).toThrow(
      /not open/,
    );
    // A channel that went with its connection cannot be used, but a settle may name it: the broker's
    // answer (a closed channel) is the record.
    const held = [
      openConnection('holder'),
      openChannel('h', { connection: 'holder' }),
      declareQueue('q'),
      publish('q', 'm1'),
      get('d', 'q', { channel: 'h' }),
      closeConnection('holder'),
    ];
    expect(() => scenario(...held, get('e', 'q', { channel: 'h' }))).toThrow(
      /on connection "holder", which is closed/,
    );
    expect(() =>
      scenario(...held, settle('d', { kind: 'ack' }, { channel: 'h' })),
    ).not.toThrow();
  });

  it('AC-5 consume keeps its recorded shape by default and can leave the consumer active', async () => {
    const steps = (...consumeStep: LabStep[]) => [
      declareQueue('q'),
      publish('q', 'm1'),
      ...consumeStep,
    ];
    const byDefault = new MemoryHost();
    const left = new MemoryHost();

    const plain = await run(byDefault, ...steps(consume('c', 'q', 1)));
    const active = await run(
      left,
      ...steps(consume('c', 'q', 1, { cancel: false })),
    );

    // Today's shape, byte for byte: no new key in the record, and the consumer is cancelled.
    expect(JSON.stringify(plain.steps[2]?.args)).toBe(
      '{"as":"c","queue":"q","count":1,"channel":"main"}',
    );
    expect(byDefault.consumers).toEqual([
      { channel: 'main', queue: 'lab-cf-test-01-abcd1234-q', cancelled: true },
    ]);
    // Left active: the host is told, and the record says so.
    expect(left.consumers[0]?.cancelled).toBe(false);
    expect(JSON.stringify(active.steps[2]?.args)).toBe(
      '{"as":"c","queue":"q","count":1,"channel":"main","cancel":false}',
    );
    expect(active.steps[2]?.result).toEqual(plain.steps[2]?.result);
    // A scenario with no second connection records no connection or cancel key anywhere.
    const smoke = await run(
      new MemoryHost(),
      openChannel('side'),
      declareQueue('q'),
      publish('q', 'm1'),
      get('d', 'q', { channel: 'side' }),
    );
    expect(JSON.stringify(smoke.steps)).not.toMatch(/connection|cancel/);
  });

  it('AC-6 awaitReady is bounded, records the count and never a duration', async () => {
    const counts = [3, 2, 2, 2, 2];
    const host = new MemoryHost();
    let polls = 0;
    host.readyCount = () => Promise.resolve(counts[polls++] ?? 2);

    const settled = await run(
      host,
      declareQueue('q'),
      awaitReady('q', { stableFor: 3, timeoutMs: 5_000 }),
    );

    // Three equal polls in a row, not two: the first 2 follows a 3.
    expect(polls).toBe(4);
    expect(settled.steps[1]).toEqual({
      index: 1,
      op: 'awaitReady',
      args: { queue: 'q', stableFor: 3 },
      result: { ready: 2 },
    });
    expect(JSON.stringify(settled)).not.toMatch(/timeout|ms|duration|polls/i);

    // A count that never settles fails the run, names the queue, and still deletes the queue.
    const moving = new MemoryHost();
    let n = 0;
    moving.readyCount = () => Promise.resolve((n += 1));
    await expect(
      run(
        moving,
        declareQueue('q'),
        awaitReady('q', { stableFor: 3, timeoutMs: 120 }),
      ),
    ).rejects.toThrow(
      /queue "q" did not hold a steady ready count within the time allowed \(last count \d+\)/,
    );
    expect(moving.calls).toContain('delete lab-cf-test-01-abcd1234-q');
    // A step that cannot be satisfied is refused before any broker is involved.
    expect(() =>
      scenario(declareQueue('q'), awaitReady('q', { stableFor: 0 })),
    ).toThrow(/stableFor of at least 1/);
    expect(() =>
      scenario(declareQueue('q'), awaitReady('q', { timeoutMs: 0 })),
    ).toThrow(/timeout of at least 1 ms/);
    expect(() => scenario(awaitReady('q'))).toThrow(/not declared yet/);
  });
});

/** Records what the DSL hands the host, so a test can see the names a ref was resolved to. */
class TopologyHost extends MemoryHost {
  readonly declared: { queue: string; arguments: Record<string, unknown> }[] =
    [];
  readonly bound: string[][] = [];
  override declareQueue(
    queue: string,
    options?: { arguments?: Record<string, unknown> },
  ): Promise<void> {
    this.declared.push({ queue, arguments: { ...options?.arguments } });
    return super.declareQueue(queue);
  }
  override bindQueue(
    queue: string,
    exchange: string,
    key: string,
  ): Promise<void> {
    this.bound.push([queue, exchange, key]);
    return super.bindQueue(queue, exchange, key);
  }
}

const dlxSteps = (): LabStep[] => [
  declareExchange('dlx'),
  declareQueue('dlq', { type: 'quorum' }),
  bindQueue('dlq', 'dlx', ref('dlq')),
  declareQueue('src', {
    type: 'quorum',
    arguments: {
      'x-dead-letter-exchange': ref('dlx'),
      'x-dead-letter-routing-key': ref('dlq'),
    },
  }),
  publish('src', 'm1'),
  wait(10),
  mgmtQueue('stats', 'dlq'),
  observe('drain', 'dlq', { from: ['src'] }),
];

describe('the dead-letter foundation of the DSL (M0-40)', () => {
  it('AC-1 (M0-40) a dead-letter topology, waits and queue stats can be declared, and a mistake is an error when the scenario is defined', async () => {
    expect(() => scenario(...dlxSteps())).not.toThrow();

    const mistakes: [string, LabStep[], RegExp][] = [
      [
        'a ref to something never declared',
        [
          declareQueue('src', {
            arguments: { 'x-dead-letter-exchange': ref('dlx') },
          }),
        ],
        /"dlx" is not a queue or exchange declared yet/,
      ],
      [
        'a bind to an undeclared exchange',
        [declareQueue('q'), bindQueue('q', 'dlx', 'k')],
        /exchange "dlx" is not declared yet/,
      ],
      [
        'a bind of an undeclared queue',
        [declareExchange('dlx'), bindQueue('q', 'dlx', 'k')],
        /queue "q" is not declared yet/,
      ],
      [
        'a bind key that is a ref to nothing',
        [
          declareExchange('dlx'),
          declareQueue('q'),
          bindQueue('q', 'dlx', ref('nope')),
        ],
        /"nope" is not a queue or exchange/,
      ],
      [
        'an exchange declared twice',
        [declareExchange('dlx'), declareExchange('dlx')],
        /invalid or already declared/,
      ],
      ['a negative wait', [wait(-1)], /whole number of ms/],
      ['an oversized wait', [wait(60_001)], /whole number of ms/],
      ['a fractional wait', [wait(1.5)], /whole number of ms/],
      [
        'queue stats of an undeclared queue',
        [mgmtQueue('s', 'q')],
        /queue "q" is not declared yet/,
      ],
      [
        'a drain from an unknown alias',
        [declareQueue('q'), observe('o', 'q', { from: ['nope'] })],
        /"nope", which is not a declared queue/,
      ],
    ];
    for (const [, steps, message] of mistakes) {
      expect(() => scenario(...steps)).toThrow(message);
    }

    // A ref is resolved to the run-unique name only when the step runs; the record keeps the alias.
    const host = new TopologyHost();
    const result = await run(host, ...dlxSteps());
    const source = host.declared.find((item) => item.queue.endsWith('-src'));
    expect(source?.arguments).toEqual({
      'x-dead-letter-exchange': 'lab-cf-test-01-abcd1234-dlx',
      'x-dead-letter-routing-key': 'lab-cf-test-01-abcd1234-dlq',
    });
    expect(host.bound).toEqual([
      [
        'lab-cf-test-01-abcd1234-dlq',
        'lab-cf-test-01-abcd1234-dlx',
        'lab-cf-test-01-abcd1234-dlq',
      ],
    ]);
    expect(result.steps[3]?.args).toMatchObject({
      arguments: {
        'x-dead-letter-exchange': { $ref: 'dlx' },
        'x-dead-letter-routing-key': { $ref: 'dlq' },
      },
    });
    expect(host.calls).toContain('delete exchange lab-cf-test-01-abcd1234-dlx');
  });

  it('AC-2 (M0-40) a run records only allow-listed fields and no clock value, so a live replay can equal the evidence', async () => {
    const steps = [
      declareQueue('q', { type: 'quorum' }),
      publish('q', 'm1', 'payload', { headers: { 'x-delivery-count': 99 } }),
      wait(2500),
      mgmtQueue('stats', 'q'),
    ];
    const stats = {
      name: 'a-queue-name',
      messages_ready: 1,
      messages_delayed: 1,
      next_delayed_at: '2026-10-20T12:00:05.000Z',
      node: 'rabbit@somewhere',
    };
    const slept: number[] = [];
    const clock: RunClock = {
      now: () => Date.parse('2026-10-20T12:00:00.000Z'),
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    };
    const once = () =>
      runScenario(
        new MemoryHost(VERSION, { managementJson: stats }),
        scenario(...steps),
        'abcd1234',
        200,
        clock,
      );

    const first = await once();

    expect(first.steps[1]?.args).toEqual({
      queue: 'q',
      messageId: 'm1',
      bytes: 7,
      headers: { 'x-delivery-count': 99 },
    });
    expect(first.steps[3]?.result).toEqual({ status: 200 });
    expect(slept).toEqual([2500]);
    const text = JSON.stringify(first);
    for (const leaked of ['12:00:05', 'a-queue-name', 'rabbit@', 'payload']) {
      expect(text).not.toContain(leaked);
    }
    // Two runs of the same scenario against the same host give byte-identical records.
    expect(JSON.stringify(await once())).toBe(text);
    const artefact = sealArtefact({
      schemaVersion: 1,
      cfId: 'CF-TEST-01',
      title: 'a test scenario',
      protocol: 'amqp091',
      brokerVersion: VERSION,
      imageDigest: DIGEST,
      steps: first.steps,
      observations: first.observations,
      provenance: localProvenance,
    });
    expect(findSecrets(artefact, ['guest'])).toEqual([]);
    // Only a copied x-delivery-count, as a whole number, can be set on a message.
    const other = { op: 'publish', queue: 'q', messageId: 'm9', body: 'x' };
    for (const headers of [{ 'x-other': 1 }, { 'x-delivery-count': 1.5 }]) {
      expect(() =>
        scenario(declareQueue('q'), {
          ...other,
          headers,
        } as unknown as LabStep),
      ).toThrow(/only header a publish may set/);
    }
  });

  it('AC-1 (M0-FIX-1) a queue-stats step records the status of the read and nothing from the statistics', async () => {
    const steps = [declareQueue('q', { type: 'quorum' }), mgmtQueue('s', 'q')];
    const clock: RunClock = {
      now: () => Date.parse('2026-10-20T12:00:00.000Z'),
      sleep: () => Promise.resolve(),
    };
    class Unknown extends MemoryHost {
      override management(): Promise<{ status: number; json: unknown }> {
        return Promise.resolve({ status: 404, json: {} });
      }
    }
    const recorded = async (managementJson: unknown, unknown = false) => {
      const result = await runScenario(
        unknown
          ? new Unknown(VERSION)
          : new MemoryHost(VERSION, { managementJson }),
        scenario(...steps),
        'abcd1234',
        200,
        clock,
      );
      return result.steps[1];
    };

    const once = await recorded({
      messages_ready: 1,
      messages_unacknowledged: 0,
      messages_delayed: 1,
      next_delayed_at: '2026-10-20T12:00:05.000Z',
    });
    expect(once).toMatchObject({
      op: 'mgmtQueue',
      args: { as: 's', queue: 'q' },
      result: { status: 200 },
    });
    expect(Object.keys(once?.result ?? {})).toEqual(['status']);
    // Whatever the statistics said at that moment, the record is the same, byte for byte: another
    // value, another class, a refresh that had not happened yet (no fields), or no object at all.
    const text = JSON.stringify(once);
    for (const body of [
      { messages_ready: 7, messages_unacknowledged: 3, messages_delayed: 3 },
      { messages_ready: 0, messages_unacknowledged: 0, messages_delayed: 0 },
      { messages_ready: 'many', next_delayed_at: 1 },
      {},
      [],
      null,
      'text',
    ]) {
      expect(JSON.stringify(await recorded(body)), JSON.stringify(body)).toBe(
        text,
      );
    }
    // The status of the answer is what is recorded: a queue the broker does not know is a 404.
    expect((await recorded({}, true))?.result).toEqual({ status: 404 });
  });
  it('AC-7 an optional settle skips a delivery that never came and says so, while a plain settle still refuses', async () => {
    const empty = [declareQueue('q'), get('d', 'q')];
    const skipped = await run(
      new MemoryHost(),
      ...empty,
      settle('d', { kind: 'ack' }, { optional: true }),
    );
    expect(skipped.steps[2]).toMatchObject({
      args: { target: 'd', optional: true },
      result: { skipped: true },
    });
    await expect(
      run(new MemoryHost(), ...empty, settle('d', { kind: 'ack' })),
    ).rejects.toThrow(/was not delivered/);
    // A delivery that did come is settled as usual, with the usual record.
    const settled = await run(
      new MemoryHost(),
      declareQueue('q'),
      publish('q', 'm1'),
      get('d', 'q'),
      settle('d', { kind: 'ack' }, { optional: true }),
    );
    expect(settled.steps[3]?.result).toMatchObject({ channelOpen: true });
    expect(settled.steps[3]?.args).not.toHaveProperty('optional');
  });
});

/** Answers a tryGet from a hand-written script and keeps what the DSL asked the host to declare. */
class RefusalHost extends MemoryHost {
  readonly answers: (() => Promise<Attempt<RawDelivery | null>>)[] = [];
  readonly declaredWith: (boolean | undefined)[] = [];
  override tryGet(): Promise<Attempt<RawDelivery | null>> {
    const next = this.answers.shift();
    if (next === undefined) throw new Error('no scripted answer');
    return next();
  }
  override declareQueue(
    queue: string,
    options?: { exclusive?: boolean },
  ): Promise<void> {
    this.declaredWith.push(options?.exclusive);
    return super.declareQueue(queue);
  }
}

/** A broker reply that also carries the text the real driver never passes on (it names this run's queue). */
const refusal = (
  level: 'channel' | 'connection',
  code: number,
  reply: string,
  queue: string,
): (() => Promise<Attempt<RawDelivery | null>>) => {
  const withText = { level, code, reply, text: `locked: queue '${queue}'` };
  return () => Promise.resolve({ refused: true, refusal: withText });
};

describe('refusals recorded by the DSL (M0-41 slice A)', () => {
  it('AC-1 a refusal-tolerant get and an exclusive queue can be declared, and a mistake is an error when the scenario is defined', async () => {
    const valid = [
      declareQueue('q', { durable: false, exclusive: true }),
      openConnection('other'),
      openChannel('o', { connection: 'other' }),
      publish('q', 'm1'),
      tryGet('own', 'q'),
      tryGet('theirs', 'q', { channel: 'o', noAck: true }),
    ];
    expect(() => scenario(...valid)).not.toThrow();

    const mistakes: [string, LabStep[], RegExp][] = [
      [
        'a tryGet of an undeclared queue',
        [tryGet('t', 'q')],
        /step 0: queue "q" is not declared yet/,
      ],
      [
        'a tryGet on a channel of a closed connection',
        [
          declareQueue('q'),
          openConnection('other'),
          openChannel('o', { connection: 'other' }),
          closeConnection('other'),
          tryGet('t', 'q', { channel: 'o' }),
        ],
        /step 4: channel "o" is on connection "other", which is closed/,
      ],
      [
        'an exclusive quorum queue',
        [
          declareQueue('q', {
            type: 'quorum',
            durable: false,
            exclusive: true,
          }),
        ],
        /step 0: an exclusive queue is classic and not durable/,
      ],
      [
        'an exclusive durable queue',
        [declareQueue('q', { exclusive: true })],
        /step 0: an exclusive queue is classic and not durable/,
      ],
    ];
    for (const [, steps, message] of mistakes) {
      expect(() => scenario(...steps)).toThrow(message);
    }

    // Only an exclusive queue says so: every other declare keeps the step it always had.
    expect(declareQueue('q')).not.toHaveProperty('exclusive');
    const host = new RefusalHost();
    const result = await run(
      host,
      declareQueue('x', { durable: false, exclusive: true }),
      declareQueue('y'),
    );
    expect(host.declaredWith).toEqual([true, undefined]);
    expect(result.steps[0]?.args).toMatchObject({ exclusive: true });
    expect(result.steps[1]?.args).not.toHaveProperty('exclusive');
  });

  it("AC-2 a refusal is recorded as level, code and reply name and never as the broker's text", async () => {
    const steps = [
      declareQueue('q', { type: 'quorum' }),
      tryGet('first', 'q'),
      tryGet('second', 'q'),
      tryGet('third', 'q'),
    ];
    const once = async (runId: string) => {
      const host = new RefusalHost();
      host.answers.push(
        refusal('channel', 405, 'RESOURCE_LOCKED', `lab-cf-test-01-${runId}-q`),
        refusal(
          'connection',
          540,
          'NOT_IMPLEMENTED',
          `lab-cf-test-01-${runId}-q`,
        ),
        // A reply that is not a name (it carries run text) is recorded as unparsed, whatever the host says.
        refusal('channel', 406, `PRECONDITION_FAILED - lab-${runId}`, 'q'),
      );
      return runScenario(host, scenario(...steps), runId);
    };

    const first = await once('abcd1234');
    const second = await once('ffff0000');

    expect(first.steps[1]?.result).toEqual({
      outcome: 'refused',
      level: 'channel',
      code: 405,
      reply: 'RESOURCE_LOCKED',
    });
    expect(first.steps[2]?.result).toEqual({
      outcome: 'refused',
      level: 'connection',
      code: 540,
      reply: 'NOT_IMPLEMENTED',
    });
    expect(first.steps[3]?.result).toMatchObject({
      code: 406,
      reply: 'unparsed',
    });
    expect(first.steps[1]?.args).toEqual({
      as: 'first',
      queue: 'q',
      noAck: false,
      channel: 'main',
    });
    const text = JSON.stringify(first);
    expect(text).not.toContain('locked:');
    expect(text).not.toContain('abcd1234');
    expect(JSON.stringify(second)).toBe(text);
    const artefact = sealArtefact({
      schemaVersion: 1,
      cfId: 'CF-TEST-01',
      title: 'a test scenario',
      protocol: 'amqp091',
      brokerVersion: VERSION,
      imageDigest: DIGEST,
      steps: first.steps,
      observations: first.observations,
      provenance: localProvenance,
    });
    expect(findSecrets(artefact, ['guest'])).toEqual([]);
  });

  it('AC-4 only a reply from the broker is a refusal; anything else aborts the run', async () => {
    const delivery: RawDelivery = {
      tag: 1,
      redelivered: false,
      messageId: 'm1',
      bytes: 2,
      messageCount: 0,
      xDeliveryCount: null,
      xAcquiredCount: 3,
    };
    const host = new RefusalHost();
    host.answers.push(
      () => Promise.resolve({ refused: false, value: delivery }),
      () => Promise.resolve({ refused: false, value: null }),
    );
    const normal = await runScenario(
      host,
      scenario(
        declareQueue('q'),
        tryGet('a', 'q'),
        tryGet('b', 'q'),
        settle('a', { kind: 'ack' }),
      ),
      'abcd1234',
    );
    expect(normal.steps[1]?.result).toEqual({
      outcome: 'delivery',
      messageId: 'm1',
      deliveryTag: 1,
      redelivered: false,
      messageCount: 0,
      'x-delivery-count': null,
      'x-acquired-count': 3,
    });
    expect(normal.steps[2]?.result).toEqual({ outcome: 'empty' });
    // The delivery is held under its alias: the settle targets its tag on the channel it came on
    // (the host never gave out tag 1, so it closes the channel, which is what the record shows).
    expect(normal.steps[3]?.args).toMatchObject({
      target: 'a',
      deliveryTag: 1,
      channel: 'main',
    });

    // A socket error or a timeout is no reply from the broker: the run fails and records nothing.
    for (const failure of [
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      new Error('timed out'),
    ]) {
      const broken = new RefusalHost();
      broken.answers.push(() => Promise.reject(failure));
      await expect(
        runScenario(
          broken,
          scenario(declareQueue('q'), tryGet('t', 'q')),
          'abcd1234',
        ),
      ).rejects.toBe(failure);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// AMQP 1.0 steps (M0-38 slice D). Every artefact below is written by hand or produced by the
// MemoryHost or a scripted stand-in; none comes from the era broker.

const MODIFY = {
  kind: 'modify',
  deliveryFailed: true,
  undeliverableHere: false,
} as const;

/** Two returns of one message: released-and-failed first (its count rises), accepted second. */
const twoRounds = () =>
  scenario(
    declareQueue('q', { type: 'quorum' }),
    publish('q', 'm1', 'secret-body-text'),
    openReceiver('r', 'q'),
    grantCredit('r'),
    receive('d1', 'r'),
    settleAmqp10('d1', MODIFY),
    grantCredit('r'),
    receive('d2', 'r'),
    settleAmqp10('d2', { kind: 'accept' }),
  );

describe('AMQP 1.0 steps', () => {
  it('AC-17 AMQP 1.0 steps are checked when the scenario is defined and credit is one', () => {
    const opened = [
      declareQueue('q', { type: 'quorum' }),
      openReceiver('r', 'q'),
    ];
    const taken = [...opened, grantCredit('r'), receive('d', 'r')];
    const accept = { kind: 'accept' } as const;
    const cases: [LabStep[], RegExp][] = [
      [[openReceiver('r', 'q')], /queue "q" is not declared yet/],
      [[...opened, openReceiver('r', 'q')], /invalid or already open/],
      [[declareQueue('q'), grantCredit('r')], /receiver "r" is not open/],
      [[...opened, receive('d', 'r')], /has no credit/],
      // Credit above one: a second grant before a receive used the first.
      [
        [...opened, grantCredit('r'), grantCredit('r')],
        /already holds a credit/,
      ],
      [[...taken, receive('e', 'r')], /has no credit/],
      [
        [...taken, settleAmqp10('d', { kind: 'nack' } as never)],
        /"nack" is not an AMQP 1.0 outcome/,
      ],
      [
        [...taken, settleAmqp10('d', { kind: 'modify' } as never)],
        /states both deliveryFailed and undeliverableHere/,
      ],
      [[...opened, settleAmqp10('x', accept)], /"x" was not received/],
      [
        [...taken, settleAmqp10('d', accept), settleAmqp10('d', accept)],
        /"d" is already settled/,
      ],
      [
        [
          ...opened,
          publish('q', 'm1'),
          get('d', 'q'),
          grantCredit('r'),
          receive('d', 'r'),
        ],
        /alias "d" is invalid or used twice/,
      ],
    ];
    for (const [steps, message] of cases) {
      expect(() => scenario(...steps)).toThrow(message);
    }
    // The error names the step, before any broker is involved.
    expect(() => scenario(...opened, receive('d', 'r'))).toThrow(/step 2:/);
    expect(() => scenario(...taken, settleAmqp10('d', MODIFY))).not.toThrow();
    // There is no credit count to give.
    expect(grantCredit.length).toBe(1);
    expect(grantCredit('r')).toEqual({ op: 'grantCredit', receiver: 'r' });
  });
  it('AC-18 an AMQP 1.0 settle is recorded by outcome and a receive by message id and delivery count', async () => {
    // The DSL on the MemoryHost: what is recorded, and the order the host was asked in.
    const host = new MemoryHost();
    const done = await runScenario(host, twoRounds(), 'abcd1234');
    expect(
      done.steps.slice(2).map(({ op, args, result }) => [op, args, result]),
    ).toEqual([
      ['openReceiver', { receiver: 'r', queue: 'q' }, { ok: true }],
      ['grantCredit', { receiver: 'r' }, { ok: true }],
      [
        'receive',
        { as: 'd1', receiver: 'r' },
        { empty: false, messageId: 'm1', 'delivery-count': 0 },
      ],
      [
        'settleAmqp10',
        {
          target: 'd1',
          outcome: 'modify',
          deliveryFailed: true,
          undeliverableHere: false,
        },
        { ok: true },
      ],
      ['grantCredit', { receiver: 'r' }, { ok: true }],
      [
        'receive',
        { as: 'd2', receiver: 'r' },
        { empty: false, messageId: 'm1', 'delivery-count': 1 },
      ],
      ['settleAmqp10', { target: 'd2', outcome: 'accept' }, { ok: true }],
    ]);
    expect(host.amqp10Calls).toEqual([
      'open r lab-cf-test-01-abcd1234-q',
      'credit r 1',
      'settle modify',
      'credit r 1',
      'settle accept',
    ]);
    // Never a body, and an empty receive is a record, not an error.
    expect(JSON.stringify(done.steps)).not.toContain('secret-body-text');
    // The recorded settle follows the written disposition: the host's settle resolves late and the
    // queue is deleted (the step after) only once it has.
    const late = new MemoryHost();
    const log: string[] = [];
    const inner = late.amqp10;
    Object.assign(late, {
      amqp10: {
        ...late.amqp10,
        settleDelivery: async (
          ...args: Parameters<Amqp10Host['settleDelivery']>
        ) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          await inner.settleDelivery(...args);
          log.push('disposition written');
        },
      },
    });
    const deleteQueue = late.deleteQueue.bind(late);
    late.deleteQueue = (queue) => {
      log.push('after the settle');
      return deleteQueue(queue);
    };
    await runScenario(late, twoRounds(), 'abcd1234');
    expect(log.slice(-3)).toEqual([
      'disposition written',
      'disposition written',
      'after the settle',
    ]);

    // The real host maps each step to the driver once: one receiver with no credit and no
    // auto-accept, a credit of one, the flags as asked, and the receiver goes with the connection.
    const disposed: unknown[][] = [];
    const attached: unknown[] = [];
    const credits: number[] = [];
    let closes = 0;
    let rheaCloses = 0;
    const receiverStub = Object.assign(new EventEmitter(), {
      add_credit: (credit: number) => {
        credits.push(credit);
        setImmediate(() => {
          receiverStub.emit('message', {
            message: { message_id: 'm1', body: 'x', delivery_count: 4 },
            delivery: {
              accept: () => disposed.push(['accept']),
              release: () => disposed.push(['release']),
              reject: () => disposed.push(['reject']),
              modified: (flags: unknown) => disposed.push(['modified', flags]),
            },
          });
        });
      },
    });
    const connection = Object.assign(new EventEmitter(), {
      open_receiver: (options: unknown) => {
        attached.push(options);
        return receiverStub;
      },
      close: () => {
        rheaCloses += 1;
        connection.emit('connection_close');
      },
    });
    const live = await openLabHost(
      await mintEndpoint(),
      {
        connect: () => {
          return Promise.resolve(
            Object.assign(new EventEmitter(), {
              connection: { serverProperties: {} },
              createChannel: () => Promise.resolve(new EventEmitter()),
              close: () => {
                closes += 1;
                return Promise.resolve();
              },
            }) as unknown as ChannelModel,
          );
        },
      },
      {
        rhea: {
          connect: () => {
            setImmediate(() => connection.emit('connection_open', {}));
            return connection as unknown as Connection;
          },
        },
        timeoutMs: 1_000,
      },
    );
    // Not opened until a receiver is asked for.
    expect(rheaCloses).toBe(0);
    await live.amqp10?.openReceiver('r', 'lab-q');
    await live.amqp10?.grantCredit('r');
    const delivery = await live.amqp10?.receive('r');
    expect(delivery).toMatchObject({ messageId: 'm1', deliveryCount: 4 });
    await live.amqp10?.settleDelivery(delivery ?? missing('delivery'), MODIFY);
    expect(attached).toEqual([
      {
        source: { address: '/queues/lab-q' },
        autoaccept: false,
        credit_window: 0,
      },
    ]);
    expect(credits).toEqual([1]);
    // rhea had written the disposition when the host's settle resolved.
    expect(disposed).toEqual([
      ['modified', { delivery_failed: true, undeliverable_here: false }],
    ]);
    await live.close();
    expect(rheaCloses).toBe(1);
    expect(closes).toBe(1);
  });
});

const missing = (what: string): never => {
  throw new Error(`${what} is missing`);
};

/** Per scenario: the sha256 (first 16 digits) of the three per-era hashes (3.13, 4.0-4.2, 4.3) of its recorded `steps`, taken on the base before the AMQP 1.0 steps. */
const BEFORE: Readonly<Record<string, string>> = {
  'CF-SMOKE-01': 'fea4a0d561452f7a',
  'CF-STAMP-01': '5c15951f974956a2',
  'CF-CARRY-01': '79fc50a6b6b3a554',
  'CF-CARRY-03': 'a4bad255f5c3b327',
  'CF-DOWN-01': '946ef12018167f41',
  'CF-DR-01': '677842f1dbfba064',
  'CF-DR-02': 'a00c84e422433514',
  'CF-SETTLE-01': 'c23deb0ffba07d41',
  'CF-SETTLE-02': '37a3458071d212a1',
  'CF-SETTLE-05': '540f023fd7e65557',
};

describe('the AMQP 1.0 steps leave every other scenario as it was', () => {
  it('AC-19 existing scenarios record exactly what they did before the AMQP 1.0 steps', async () => {
    const eras: Era[] = ['3.13', '4.0-4.2', '4.3'];
    const sha = (text: string) =>
      createHash('sha256').update(text).digest('hex').slice(0, 16);
    const now: Record<string, string> = {};
    for (const [cfId] of Object.entries(BEFORE)) {
      // A scenario another slice adds later has no baseline here; it cannot change by this slice.
      const scenario = SCENARIOS.find((item) => item.cfId === cfId);
      const hashes: string[] = [];
      for (const era of eras) {
        const artefact = await recordOnEra(era, scenario ?? missing(cfId));
        hashes.push(sha(JSON.stringify(artefact.steps)));
      }
      now[cfId] = sha(hashes.join(','));
    }
    expect(now).toEqual(BEFORE);
  }, 120_000);
});
