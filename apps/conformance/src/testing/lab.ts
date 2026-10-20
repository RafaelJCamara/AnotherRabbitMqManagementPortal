// Test doubles for the recorder specs: a Docker that describes a broker-lab container, an endpoint
// minted through the real verification, and an in-memory broker host that behaves like a classic
// queue (requeue goes back to the head and is flagged redelivered; an unknown tag closes the
// channel with 406). Nothing here is used by the recorder itself.
import type {
  Attempt,
  RawDelivery,
  SettleAction,
  SettleOutcome,
} from '../driver/amqp091-raw.ts';
import type { Amqp10Host } from '../dsl.ts';
import {
  verifyLabEndpoint,
  type Docker,
  type LabBrokerData,
  type LabEndpoint,
} from '../driver/lab-endpoint.ts';
import { sealArtefact, type EvidenceBody } from '../record/evidence.ts';
import type { RecordHost } from '../record/record.ts';

export const VERSION = '4.3.6';
export const DIGEST =
  'sha256:ca5d088daf64c9de02c923c1c57c724bf4884c5c69bfa8172c68b214c0057cea';
export const CONTAINER = 'broker-lab-4.3.6-0a1b2c3d';

export const brokerData = (
  overrides: Partial<LabBrokerData> = {},
): LabBrokerData => ({
  version: VERSION,
  digest: DIGEST,
  amqp: 'amqp://127.0.0.1:49100',
  http: 'http://127.0.0.1:49101',
  container: CONTAINER,
  credentials: { username: 'guest', password: 'guest' },
  ...overrides,
});

export interface DockerShape {
  Name: string;
  Config: { Image: string; Labels: Record<string, string> | null };
  State: { Running: boolean };
  NetworkSettings: {
    Ports: Record<string, { HostIp: string; HostPort: string }[] | null>;
  };
}

const portOf = (address: string): string => {
  try {
    return new URL(address).port;
  } catch {
    return '';
  }
};

export const containerShape = (
  change: (shape: DockerShape) => void = () => undefined,
  data: LabBrokerData = brokerData(),
): DockerShape => {
  const shape: DockerShape = {
    Name: `/${data.container}`,
    Config: {
      Image: `broker-lab/rabbitmq:${data.version}`,
      Labels: {
        'io.broker-lab.run': '0a1b2c3d',
        'io.broker-lab.rabbitmq-version': data.version,
      },
    },
    State: { Running: true },
    NetworkSettings: {
      Ports: {
        '5672/tcp': [{ HostIp: '127.0.0.1', HostPort: portOf(data.amqp) }],
        '15672/tcp': [{ HostIp: '127.0.0.1', HostPort: portOf(data.http) }],
      },
    },
  };
  change(shape);
  return shape;
};

/** A Docker whose `inspect` answers with the given container description. */
export const fakeDocker =
  (shape: DockerShape | null = containerShape()): Docker =>
  (args) =>
    shape === null || args[0] !== 'inspect'
      ? Promise.reject(new Error('docker failed'))
      : Promise.resolve(JSON.stringify([shape]));

const PINNED = new Map([[VERSION, DIGEST]]);

/** An endpoint minted by the real verification against a fake Docker. */
export const mintEndpoint = (
  data: LabBrokerData = brokerData(),
  docker: Docker = fakeDocker(containerShape(() => undefined, data)),
): Promise<LabEndpoint> =>
  verifyLabEndpoint(data, { docker, pinnedDigests: PINNED });

export const pinned = PINNED;

interface Message {
  id: string;
  redelivered: boolean;
  /** AMQP 1.0 header `delivery-count`; only a modify with delivery-failed raises it. */
  deliveryCount?: number;
}

/** A classic-queue broker in memory. `served` is what it reports as its version. */
export class MemoryHost implements RecordHost {
  readonly queues = new Map<string, Message[]>();
  readonly calls: string[] = [];
  readonly managementCalls: unknown[] = [];
  /** Connection name to whether it is open; `main` is always there. */
  readonly connections = new Map<string, boolean>([['main', true]]);
  /** Every consume the host was asked for, and whether the consumer was cancelled afterwards. */
  readonly consumers: { channel: string; queue: string; cancelled: boolean }[] =
    [];
  readonly #channelOn = new Map<string, string>([['main', 'main']]);
  readonly #unacked = new Map<
    string,
    Map<number, { queue: string; message: Message }>
  >();
  readonly #closed = new Map<string, { code: number; text: string }>();
  #tag = 0;
  closedCount = 0;
  failOn: string | undefined;
  /** What the AMQP 1.0 half was asked, in order (`credit r 1`, `settle accept`, ...). */
  readonly amqp10Calls: string[] = [];
  readonly #receivers = new Map<string, { queue: string; credit: number }>();
  readonly #held10: { queue: string; message: Message }[] = [];

  /** The AMQP 1.0 half of the host: a quorum-like queue, one credit per receive, the four outcomes. */
  readonly amqp10: Amqp10Host = {
    openReceiver: (receiver, queue) => {
      this.amqp10Calls.push(`open ${receiver} ${queue}`);
      this.#receivers.set(receiver, { queue, credit: 0 });
      return Promise.resolve();
    },
    grantCredit: (receiver) => {
      this.amqp10Calls.push(`credit ${receiver} 1`);
      const state = this.#receivers.get(receiver);
      if (state !== undefined) state.credit += 1;
      return Promise.resolve();
    },
    receive: (receiver) => {
      const state = this.#receivers.get(receiver);
      const message =
        state === undefined || state.credit < 1
          ? undefined
          : this.queues.get(state.queue)?.shift();
      if (state === undefined || message === undefined)
        return Promise.resolve(null);
      state.credit -= 1;
      this.#held10.push({ queue: state.queue, message });
      return Promise.resolve({
        ref: this.#held10.length - 1,
        messageId: message.id,
        bytes: message.id.length,
        deliveryCount: message.deliveryCount ?? 0,
      });
    },
    settleDelivery: (delivery, outcome) => {
      this.amqp10Calls.push(`settle ${outcome.kind}`);
      const held = this.#held10[delivery.ref];
      if (held === undefined)
        return Promise.reject(new Error('never received'));
      const { queue, message } = held;
      const failed = outcome.kind === 'modify' && outcome.deliveryFailed;
      const dropped =
        outcome.kind === 'accept' ||
        outcome.kind === 'reject' ||
        (outcome.kind === 'modify' && outcome.undeliverableHere);
      if (!dropped) {
        this.queues.get(queue)?.unshift({
          id: message.id,
          redelivered: true,
          deliveryCount: (message.deliveryCount ?? 0) + (failed ? 1 : 0),
        });
      }
      return Promise.resolve();
    },
  };

  constructor(
    public served: string | null = VERSION,
    private readonly extra: { managementJson?: unknown } = {},
  ) {
    this.#unacked.set('main', new Map());
  }

  brokerVersion(): Promise<string | null> {
    return Promise.resolve(this.served);
  }
  close(): Promise<void> {
    this.closedCount += 1;
    return Promise.resolve();
  }
  openConnection(name: string): Promise<void> {
    if (this.connections.has(name)) {
      return Promise.reject(new Error(`connection "${name}" is already used`));
    }
    this.connections.set(name, true);
    return Promise.resolve();
  }
  /** Closes the connection; its channels report a closed channel to a settle, as the broker's would. */
  closeConnection(name: string): Promise<void> {
    if (this.connections.get(name) !== true) {
      return Promise.reject(new Error(`connection "${name}" is not open`));
    }
    this.connections.set(name, false);
    for (const [channel, on] of this.#channelOn) {
      if (on === name) {
        this.#closed.set(channel, {
          code: 0,
          text: 'closed with its connection',
        });
      }
    }
    return Promise.resolve();
  }
  openChannel(name: string, connection = 'main'): Promise<void> {
    if (this.connections.get(connection) !== true) {
      return Promise.reject(
        new Error(`connection "${connection}" is not open`),
      );
    }
    this.#channelOn.set(name, connection);
    this.#unacked.set(name, new Map());
    return Promise.resolve();
  }
  /** The ready count; a test replaces this to script a count that moves. */
  readyCount(queue: string): Promise<number> {
    return Promise.resolve(this.queues.get(queue)?.length ?? 0);
  }
  closeChannel(name: string): Promise<void> {
    this.#closed.set(name, { code: 0, text: 'closed by the client' });
    return Promise.resolve();
  }
  declareQueue(queue: string): Promise<void> {
    this.calls.push(`declare ${queue}`);
    this.queues.set(queue, []);
    return Promise.resolve();
  }
  deleteQueue(queue: string): Promise<void> {
    this.calls.push(`delete ${queue}`);
    this.queues.delete(queue);
    return Promise.resolve();
  }
  declareExchange(exchange: string): Promise<void> {
    this.calls.push(`declare exchange ${exchange}`);
    return Promise.resolve();
  }
  deleteExchange(exchange: string): Promise<void> {
    this.calls.push(`delete exchange ${exchange}`);
    return Promise.resolve();
  }
  bindQueue(queue: string, exchange: string, key: string): Promise<void> {
    this.calls.push(`bind ${queue} ${exchange} ${key}`);
    return Promise.resolve();
  }
  publish(
    queue: string,
    message: { messageId: string; body: Buffer },
  ): Promise<void> {
    if (this.failOn === 'publish')
      return Promise.reject(new Error('nack from the broker'));
    this.queues.get(queue)?.push({ id: message.messageId, redelivered: false });
    return Promise.resolve();
  }
  get(
    channel: string,
    queue: string,
    noAck: boolean,
  ): Promise<RawDelivery | null> {
    const ready = this.queues.get(queue) ?? [];
    const message = ready.shift();
    if (message === undefined) return Promise.resolve(null);
    this.#tag += 1;
    if (!noAck) this.#unacked.get(channel)?.set(this.#tag, { queue, message });
    return Promise.resolve({
      tag: this.#tag,
      redelivered: message.redelivered,
      messageId: message.id,
      bytes: message.id.length,
      messageCount: ready.length,
      xDeliveryCount: null,
      xAcquiredCount: null,
    });
  }
  /** Never refuses: a refusal is scripted by a test that overrides this (hand-written, not modelled here). */
  async tryGet(
    channel: string,
    queue: string,
    noAck: boolean,
  ): Promise<Attempt<RawDelivery | null>> {
    return { refused: false, value: await this.get(channel, queue, noAck) };
  }
  consume(
    channel: string,
    queue: string,
    count: number,
    cancel = true,
  ): Promise<RawDelivery[]> {
    this.consumers.push({ channel, queue, cancelled: cancel });
    const taken: Promise<RawDelivery | null>[] = [];
    for (let n = 0; n < count; n += 1)
      taken.push(this.get(channel, queue, false));
    return Promise.all(taken).then((all) =>
      all.filter((item) => item !== null),
    );
  }
  settle(
    channel: string,
    tag: number,
    action: SettleAction,
  ): Promise<SettleOutcome> {
    const closed = this.#closed.get(channel);
    if (closed)
      return Promise.resolve({
        channelOpen: false,
        closed: { code: null, text: closed.text },
      });
    const held = this.#unacked.get(channel)?.get(tag);
    if (held === undefined) {
      const info = {
        code: 406,
        text: `PRECONDITION_FAILED - unknown delivery tag ${String(tag)}`,
      };
      this.#closed.set(channel, info);
      return Promise.resolve({ channelOpen: false, closed: info });
    }
    this.#unacked.get(channel)?.delete(tag);
    const requeue = action.kind !== 'ack' && action.requeue;
    if (requeue) {
      this.queues
        .get(held.queue)
        ?.unshift({ id: held.message.id, redelivered: true });
    }
    return Promise.resolve({ channelOpen: true });
  }
  recover(): Promise<void> {
    return Promise.resolve();
  }
  management(call: unknown): Promise<{ status: number; json: unknown }> {
    this.managementCalls.push(call);
    return Promise.resolve({ status: 200, json: this.extra.managementJson });
  }
}

const SHA = 'a'.repeat(40);

/** A valid artefact body: the CF-SMOKE-01 result as the recorder would produce it. */
export const evidenceBody = (
  change: (body: EvidenceBody) => EvidenceBody = (body) => body,
): EvidenceBody =>
  change({
    schemaVersion: 1,
    cfId: 'CF-SMOKE-01',
    title: 'Classic queue: basic.get then basic.nack with requeue',
    protocol: 'amqp091',
    brokerVersion: VERSION,
    imageDigest: DIGEST,
    steps: [
      {
        index: 0,
        op: 'settle',
        args: { deliveryTag: 1, action: 'nack', requeue: true },
        result: { channelOpen: true, closed: null },
      },
    ],
    observations: [
      {
        name: 'after-nack-requeue',
        messageId: 'm1',
        survived: true,
        position: 0,
        redelivered: true,
        'x-delivery-count': null,
        'x-acquired-count': null,
      },
    ],
    provenance: {
      kind: 'ci',
      recorder: 'conformance:record',
      gitSha: SHA,
      runUrl: 'https://github.com/example/repo/actions/runs/123/attempts/1',
      workflow:
        'example/repo/.github/workflows/conformance-record.yml@refs/heads/main',
      recordedAt: '2026-10-19T12:00:00.000Z',
    },
  });

export const sealedEvidence = (
  change?: (body: EvidenceBody) => EvidenceBody,
): ReturnType<typeof sealArtefact> => sealArtefact(evidenceBody(change));

export const localProvenance = {
  kind: 'local',
  recorder: 'conformance:record',
  gitSha: null,
  recordedAt: '2026-10-19T12:00:00.000Z',
} as const;
