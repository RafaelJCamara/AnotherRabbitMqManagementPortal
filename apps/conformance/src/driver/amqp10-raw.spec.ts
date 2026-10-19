// The raw AMQP 1.0 driver against a scripted stand-in for rhea. What a real broker answers is
// recorded by the lab (conformance.it.ts runs the driver against a lab broker).
import { EventEmitter } from 'node:events';
import type { Connection } from 'rhea';
import { describe, expect, it } from 'vitest';

import { mintEndpoint } from '../testing/lab.ts';
import { Amqp10Raw, type RheaApi } from './amqp10-raw.ts';
import { ForeignEndpointError, type LabEndpoint } from './lab-endpoint.ts';

class FakeDelivery {
  readonly calls: unknown[][] = [];
  constructor(readonly id: number) {}
  accept(): void {
    this.calls.push(['accept']);
  }
  release(): void {
    this.calls.push(['release']);
  }
  reject(): void {
    this.calls.push(['reject']);
  }
  modified(params: unknown): void {
    this.calls.push(['modified', params]);
  }
}

class FakeReceiver extends EventEmitter {
  readonly credits: number[] = [];
  add_credit(credit: number): void {
    this.credits.push(credit);
  }
}

class FakeSender extends EventEmitter {
  sent: Record<string, unknown>[] = [];
  closed = false;
  send(message: Record<string, unknown>): { id: number } {
    this.sent.push(message);
    return { id: 40 + this.sent.length };
  }
  close(): void {
    this.closed = true;
  }
}

class FakeConnection extends EventEmitter {
  receiverOptions: unknown;
  senderOptions: unknown;
  readonly receiver = new FakeReceiver();
  readonly sender = new FakeSender();
  closes = 0;
  open_receiver(options: unknown): FakeReceiver {
    this.receiverOptions = options;
    return this.receiver;
  }
  open_sender(options: unknown): FakeSender {
    this.senderOptions = options;
    return this.sender;
  }
  close(): void {
    this.closes += 1;
    this.emit('connection_close');
  }
}

const open = async (
  options: {
    onConnect?: (connection: FakeConnection) => void;
    timeoutMs?: number;
    endpoint?: LabEndpoint;
  } = {},
) => {
  const connection = new FakeConnection();
  const connects: Record<string, unknown>[] = [];
  const rhea: RheaApi = {
    connect: (connectOptions) => {
      connects.push(connectOptions);
      setImmediate(() => {
        if (options.onConnect) options.onConnect(connection);
        else connection.emit('connection_open', {});
      });
      return connection as unknown as Connection;
    },
  };
  const raw = await Amqp10Raw.open(options.endpoint ?? (await mintEndpoint()), {
    rhea,
    timeoutMs: options.timeoutMs ?? 2_000,
  });
  return { raw, connection, connects };
};

const at = <T>(list: readonly T[], index: number): T => {
  const item = list[index];
  if (item === undefined) throw new Error(`no item ${String(index)}`);
  return item;
};

const deliver = (
  connection: FakeConnection,
  id: number,
  message: Record<string, unknown>,
): FakeDelivery => {
  const delivery = new FakeDelivery(id);
  connection.receiver.emit('message', { message, delivery });
  return delivery;
};

describe('AC-2 the raw AMQP 1.0 driver connects only to what broker-lab created', () => {
  it('refuses a forged endpoint before it connects', async () => {
    let connects = 0;
    const forged = { ...(await mintEndpoint()) } as LabEndpoint;

    await expect(
      Amqp10Raw.open(forged, {
        rhea: {
          connect: () => {
            connects += 1;
            throw new Error('unreachable');
          },
        },
      }),
    ).rejects.toThrow(ForeignEndpointError);
    expect(connects).toBe(0);
  });

  it('connects to the endpoint host and port with its login, without reconnecting', async () => {
    const { connects } = await open();

    expect(connects).toEqual([
      {
        host: '127.0.0.1',
        port: 49100,
        username: 'guest',
        password: 'guest',
        transport: 'tcp',
        reconnect: false,
        container_id: 'conformance-lab-driver',
      },
    ]);
  });

  it('fails when the connection closes before it opens, with the error the broker gave', async () => {
    await expect(
      open({
        onConnect: (connection) => {
          connection.emit('connection_error', {
            error: {
              condition: 'amqp:unauthorized-access',
              description: 'bad login',
            },
          });
          connection.emit('disconnected', {});
        },
      }),
    ).rejects.toThrow(
      /closed: connection_error: amqp:unauthorized-access bad login/,
    );
  });

  it('fails when the connection never opens', async () => {
    await expect(
      open({ onConnect: () => undefined, timeoutMs: 20 }),
    ).rejects.toThrow(/did not open in time/);
  });
});

describe('the raw AMQP 1.0 driver controls credit and settlement by hand', () => {
  it('attaches a receiver with no credit and no automatic acceptance, and grants any credit, even above one', async () => {
    const { raw, connection } = await open();

    raw.openReceiver('r', '/queues/q');
    raw.addCredit('r', 1);
    raw.addCredit('r', 50);

    expect(connection.receiverOptions).toEqual({
      source: { address: '/queues/q' },
      autoaccept: false,
      credit_window: 0,
    });
    expect(connection.receiver.credits).toEqual([1, 50]);
  });

  it('collects deliveries in order with their id, size and delivery count', async () => {
    const { raw, connection } = await open();
    raw.openReceiver('r', '/queues/q');
    deliver(connection, 1, {
      message_id: 'm1',
      body: 'héllo',
      delivery_count: 2,
    });
    deliver(connection, 2, { body: Buffer.from('abc') });
    deliver(connection, 3, {
      message_id: 7,
      body: { odd: true },
      delivery_count: -1,
    });
    connection.receiver.emit('message', {
      message: undefined,
      delivery: undefined,
    });

    const received = await raw.receive('r', 3);

    expect(received).toEqual([
      { ref: 0, messageId: 'm1', bytes: 6, deliveryCount: 2 },
      { ref: 1, messageId: null, bytes: 3, deliveryCount: null },
      { ref: 2, messageId: null, bytes: 0, deliveryCount: null },
    ]);
  });

  it('receive gives up at the timeout and returns what arrived', async () => {
    const { raw, connection } = await open({ timeoutMs: 40 });
    raw.openReceiver('r', '/queues/q');
    deliver(connection, 1, { message_id: 'm1', body: 'x' });

    expect(await raw.receive('r', 2)).toHaveLength(1);
  });

  it('settles with each outcome by its own method (release is not reject, modify carries its flags)', async () => {
    const { raw, connection } = await open();
    raw.openReceiver('r', '/queues/q');
    const deliveries = [1, 2, 3, 4, 5].map((id) =>
      deliver(connection, id, { message_id: `m${String(id)}`, body: 'x' }),
    );
    const received = await raw.receive('r', 5);

    await raw.settle(at(received, 0), { kind: 'accept' });
    await raw.settle(at(received, 1), { kind: 'release' });
    await raw.settle(at(received, 2), { kind: 'reject' });
    await raw.settle(at(received, 3), {
      kind: 'modify',
      deliveryFailed: true,
      undeliverableHere: false,
    });
    await raw.settle(at(received, 4), {
      kind: 'modify',
      deliveryFailed: false,
      undeliverableHere: true,
    });

    expect(deliveries.map((delivery) => delivery.calls)).toEqual([
      [['accept']],
      [['release']],
      [['reject']],
      [['modified', { delivery_failed: true, undeliverable_here: false }]],
      [['modified', { delivery_failed: false, undeliverable_here: true }]],
    ]);
  });

  it('forbidden: a second settle of the same delivery is sent and reported as again', async () => {
    const { raw, connection } = await open();
    raw.openReceiver('r', '/queues/q');
    const delivery = deliver(connection, 1, { message_id: 'm1', body: 'x' });
    const [received] = await raw.receive('r', 1);
    if (received === undefined) throw new Error('nothing received');

    expect(await raw.settle(received, { kind: 'accept' })).toEqual({
      again: false,
    });
    expect(await raw.settle(received, { kind: 'reject' })).toEqual({
      again: true,
    });
    expect(delivery.calls).toEqual([['accept'], ['reject']]);
  });

  it('refuses a delivery it never received, a receiver it never opened and a receiver opened twice', async () => {
    const { raw } = await open();

    await expect(
      raw.settle(
        { ref: 9, messageId: null, bytes: 0, deliveryCount: null },
        { kind: 'accept' },
      ),
    ).rejects.toThrow(/never received/);
    expect(() => {
      raw.addCredit('nope', 1);
    }).toThrow(/never opened/);
    raw.openReceiver('r', '/queues/q');
    expect(() => {
      raw.openReceiver('r', '/queues/q');
    }).toThrow(/already open/);
  });

  it('records the errors the broker reports on the connection and on links', async () => {
    const { raw, connection } = await open();

    connection.emit('receiver_error', {
      error: { condition: 'amqp:not-found', description: 'no queue' },
    });
    connection.emit('sender_error', {});

    expect(raw.errors).toEqual([
      'receiver_error: amqp:not-found no queue',
      'sender_error:',
    ]);
  });
});

describe('sending and closing', () => {
  it('sends one message when the link is sendable and returns the broker disposition for that delivery', async () => {
    const { raw, connection } = await open();

    const pending = raw.send('/queues/q', 'm1', 'payload');
    await new Promise((resolve) => setImmediate(resolve));
    connection.sender.emit('sendable', {});
    // Another delivery's disposition is not ours.
    connection.sender.emit('rejected', { delivery: { id: 99 } });
    connection.sender.emit('accepted', { delivery: { id: 41 } });

    expect(await pending).toBe('accepted');
    expect(connection.senderOptions).toEqual({
      target: { address: '/queues/q' },
    });
    expect(connection.sender.sent).toEqual([
      { message_id: 'm1', body: 'payload' },
    ]);
    expect(connection.sender.closed).toBe(true);
  });

  it.each(['rejected', 'released', 'modified'])(
    'returns %s when the broker settles with it',
    async (outcome) => {
      const { raw, connection } = await open();

      const pending = raw.send('/queues/q', 'm1', 'payload');
      await new Promise((resolve) => setImmediate(resolve));
      connection.sender.emit('sendable', {});
      connection.sender.emit(outcome, { delivery: { id: 41 } });

      expect(await pending).toBe(outcome);
    },
  );

  it('fails when the broker never settles the transfer', async () => {
    const { raw } = await open({ timeoutMs: 30 });

    await expect(raw.send('/queues/q', 'm1', 'payload')).rejects.toThrow(
      /did not settle/,
    );
  });

  it('closes the connection and resolves when the broker confirms', async () => {
    const { raw, connection } = await open();

    await raw.close();

    expect(connection.closes).toBe(1);
  });
});
