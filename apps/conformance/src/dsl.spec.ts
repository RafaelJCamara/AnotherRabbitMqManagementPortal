import { describe, expect, it } from 'vitest';

import {
  closeChannel,
  consume,
  declareQueue,
  defineScenario,
  get,
  mgmtGet,
  observe,
  openChannel,
  publish,
  recover,
  runScenario,
  settle,
  type LabStep,
} from './dsl.ts';
import { MemoryHost } from './testing/lab.ts';

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
  it('AC-1 CF-SMOKE-01 on a classic queue: nack with requeue returns the message first, redelivered', async () => {
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
