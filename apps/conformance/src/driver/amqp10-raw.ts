// Raw AMQP 1.0 for the lab (rhea; confined to this project and the AMQP 1.0 adapter, I-11). Like the
// 0-9-1 driver it does what a product must never do, and reports what the broker answers: it grants
// any amount of credit (the adapter never grants more than one, blueprint 5.2), settles with each
// of the four outcomes (accepted, released, rejected, modified), and settles a delivery twice.
//
// It reaches only a `LabEndpoint` (the check is in `lab-endpoint.ts`) and records no credential.
import type { Connection, EventContext, Receiver, Sender } from 'rhea';

import { assertLabEndpoint, type LabEndpoint } from './lab-endpoint.ts';

export type Amqp10Outcome =
  | { readonly kind: 'accept' }
  | { readonly kind: 'release' }
  | { readonly kind: 'reject' }
  | {
      readonly kind: 'modify';
      readonly deliveryFailed: boolean;
      readonly undeliverableHere: boolean;
    };

export interface Amqp10Delivery {
  /** Position in the order the driver received them (0, 1, ...); the handle `settle` takes. */
  readonly ref: number;
  readonly messageId: string | null;
  readonly bytes: number;
  /** The `delivery-count` of the message header, when the broker sends one. */
  readonly deliveryCount: number | null;
}

/** The part of rhea the driver uses; tests pass a scripted stand-in. */
export interface RheaApi {
  connect(options: Record<string, unknown>): Connection;
}

export interface Amqp10Deps {
  readonly rhea?: RheaApi;
  readonly timeoutMs?: number;
}

type Sendable = Sender & {
  send(message: Record<string, unknown>): { id: number };
};

const counter = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;

async function loadRhea(): Promise<RheaApi> {
  // rhea is CommonJS (`module.exports = new Container()`): Node exposes it as the default export.
  const loaded = (await import('rhea')) as unknown as {
    default?: RheaApi;
  } & RheaApi;
  return loaded.default ?? loaded;
}

export class Amqp10Raw {
  readonly #connection: Connection;
  readonly #timeoutMs: number;
  readonly #receivers = new Map<
    string,
    { receiver: Receiver; messages: Amqp10Delivery[] }
  >();
  readonly #deliveries: {
    settle: (outcome: Amqp10Outcome) => void;
    settled: boolean;
  }[] = [];
  /** What the broker reported as an error on the connection or a link. */
  readonly errors: string[] = [];

  private constructor(connection: Connection, timeoutMs: number) {
    this.#connection = connection;
    this.#timeoutMs = timeoutMs;
    for (const event of [
      'connection_error',
      'session_error',
      'receiver_error',
      'sender_error',
    ]) {
      connection.on(event, (context: EventContext) => {
        const detail = (
          context as { error?: { condition?: string; description?: string } }
        ).error;
        this.errors.push(
          `${event}: ${detail?.condition ?? ''} ${detail?.description ?? ''}`.trim(),
        );
      });
    }
  }

  /** Connects (SASL PLAIN, no reconnect) to a broker that testing/broker-lab created. */
  static async open(
    endpoint: LabEndpoint,
    deps: Amqp10Deps = {},
  ): Promise<Amqp10Raw> {
    assertLabEndpoint(endpoint);
    const timeoutMs = deps.timeoutMs ?? 15_000;
    const rhea = deps.rhea ?? (await loadRhea());
    const connection = rhea.connect({
      host: endpoint.host,
      port: endpoint.amqpPort,
      username: endpoint.credentials.username,
      password: endpoint.credentials.password,
      transport: 'tcp',
      reconnect: false,
      container_id: 'conformance-lab-driver',
    });
    const raw = new Amqp10Raw(connection, timeoutMs);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('the AMQP 1.0 connection did not open in time'));
      }, timeoutMs);
      connection.once('connection_open', () => {
        clearTimeout(timer);
        resolve();
      });
      connection.once('disconnected', () => {
        clearTimeout(timer);
        reject(
          new Error(`the AMQP 1.0 connection closed: ${raw.errors.join('; ')}`),
        );
      });
    });
    return raw;
  }

  /** Attaches a receiver with no credit and no automatic acceptance: the scenario decides both. */
  openReceiver(name: string, address: string): void {
    if (this.#receivers.has(name))
      throw new Error(`receiver "${name}" is already open`);
    const receiver = this.#connection.open_receiver({
      source: { address },
      autoaccept: false,
      credit_window: 0,
    });
    const messages: Amqp10Delivery[] = [];
    receiver.on('message', (context: EventContext) => {
      const message = context.message as
        | { message_id?: unknown; delivery_count?: unknown; body?: unknown }
        | undefined;
      const delivery = context.delivery;
      if (message === undefined || delivery === undefined) return;
      const body = message.body;
      const entry: Amqp10Delivery = {
        ref: this.#deliveries.length,
        messageId:
          typeof message.message_id === 'string' ? message.message_id : null,
        bytes:
          typeof body === 'string'
            ? Buffer.byteLength(body)
            : Buffer.isBuffer(body)
              ? body.length
              : 0,
        deliveryCount: counter(message.delivery_count),
      };
      const slot = {
        settled: false,
        settle: (outcome: Amqp10Outcome): void => {
          switch (outcome.kind) {
            case 'accept':
              delivery.accept();
              break;
            case 'release':
              delivery.release();
              break;
            case 'reject':
              delivery.reject();
              break;
            case 'modify':
              delivery.modified({
                delivery_failed: outcome.deliveryFailed,
                undeliverable_here: outcome.undeliverableHere,
              });
              break;
          }
        },
      };
      this.#deliveries.push(slot);
      messages.push(entry);
    });
    this.#receivers.set(name, { receiver, messages });
  }

  /** Grants `credit` more messages. Any number is allowed here, including what the adapter never grants. */
  addCredit(name: string, credit: number): void {
    this.#receiver(name).receiver.add_credit(credit);
  }

  /** Waits until `count` deliveries are in, or the timeout; returns everything received so far. */
  async receive(name: string, count: number): Promise<Amqp10Delivery[]> {
    const { messages } = this.#receiver(name);
    const deadline = Date.now() + this.#timeoutMs;
    while (messages.length < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return [...messages];
  }

  /**
   * Settles a delivery and waits until rhea has written the disposition. A second settle of the
   * same delivery is sent as asked and reported as `again: true`, which is how a scenario sees the
   * forbidden path. Waiting matters: rhea writes the state a delivery has when its turn comes, so
   * two settles in one tick would put the second outcome on the wire twice and never the first.
   */
  async settle(
    delivery: Amqp10Delivery,
    outcome: Amqp10Outcome,
  ): Promise<{ again: boolean }> {
    const slot = this.#deliveries[delivery.ref];
    if (slot === undefined)
      throw new Error(`delivery ${String(delivery.ref)} was never received`);
    const again = slot.settled;
    slot.settle(outcome);
    slot.settled = true;
    // rhea flushes on process.nextTick; setImmediate runs after it.
    await new Promise((resolve) => setImmediate(resolve));
    return { again };
  }
  /** Sends one message and waits for the broker's disposition: `accepted`, `rejected`, `released` or `modified`. */
  async send(
    address: string,
    messageId: string,
    body: string,
  ): Promise<string> {
    const sender = this.#connection.open_sender({
      target: { address },
    }) as Sendable;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error('the broker did not settle the AMQP 1.0 transfer in time'),
        );
      }, this.#timeoutMs);
      let sent: { id: number } | undefined;
      const done =
        (outcome: string) =>
        (context: EventContext): void => {
          if (sent !== undefined && context.delivery?.id !== sent.id) return;
          clearTimeout(timer);
          sender.close();
          resolve(outcome);
        };
      for (const outcome of ['accepted', 'rejected', 'released', 'modified']) {
        sender.on(outcome, done(outcome));
      }
      sender.once('sendable', () => {
        sent = sender.send({ message_id: messageId, body });
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.#connection.once('connection_close', () => {
        resolve();
      });
      this.#connection.once('disconnected', () => {
        resolve();
      });
      this.#connection.close();
    });
  }

  #receiver(name: string): { receiver: Receiver; messages: Amqp10Delivery[] } {
    const found = this.#receivers.get(name);
    if (found === undefined)
      throw new Error(`receiver "${name}" was never opened`);
    return found;
  }
}
