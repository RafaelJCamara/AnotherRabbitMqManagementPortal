// Contract: a server-initiated `basic.cancel` (U-17, M0-28). The broker cancels a consumer when its
// queue is deleted (and, on 4.3, when a quorum queue's consumer times out). Two things must hold
// for both client libraries:
//   - the adapter surfaces it as an event: `onDelivery(null)` and a `server-cancel` event that
//     names the consumer;
//   - what the broker does with a nack of a delivery that was held when the cancel came is
//     recorded as evidence (`dist/contract-evidence/<broker>/server-cancel.json`), and is the same
//     for both libraries, because the answer is the broker's, not the library's.
// The recorded outcome is deliberately not asserted to be "accepted" or "refused": that is the
// open question. It must be one of the two, it must leave the adapter in a consistent state, and
// it must not depend on the library.
import { describe, expect, it } from 'vitest';

import {
  mintDestructiveConsentProof,
  mintSafeReturnProof,
  type Delivery,
} from '@app/ports';

import { createDialer } from '@app/net-dialer';

import { connectSource, type ConnectionEvent } from '../src/index.ts';
import {
  contractBroker,
  declare,
  deleteQueue,
  fill,
  optionsFor,
  portOf,
  recordObservation,
  subjects,
  unique,
  waitFor,
  type QueueKind,
} from './harness.ts';

const broker = contractBroker();
const kinds: readonly QueueKind[] = ['classic', 'quorum'];

type Settle =
  | { readonly outcome: 'accepted' }
  | {
      readonly outcome: 'refused';
      readonly reason: string;
      readonly code: string;
    };

interface Observation {
  readonly library: string;
  readonly queueType: QueueKind;
  readonly heldAtCancel: number;
  readonly cancelEvent: { readonly consumerTag: string };
  readonly nackAfterCancel: Settle;
  readonly ackAfterNack: Settle | 'not-attempted (channel closed by the nack)';
}

const observed: Observation[] = [];

/** The part of an observation that must not depend on the library. */
const classify = (settle: Settle | string): string =>
  typeof settle === 'string' ? settle : settle.outcome;

async function attempt(
  settle: () => void,
  barrier: () => Promise<void>,
  channelErrors: () => number,
): Promise<Settle> {
  const before = channelErrors();
  try {
    settle();
    await barrier();
  } catch (error) {
    const { reason, code } = error as { reason?: string; code?: string };
    return {
      outcome: 'refused',
      reason: reason ?? 'unknown',
      code: code ?? 'unknown',
    };
  }
  // A settle of an unknown tag is a one-way frame: the broker answers with a channel error, and
  // the barrier either fails or the error arrives just after it.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return channelErrors() > before
    ? {
        outcome: 'refused',
        reason: 'channel-error',
        code: 'BROKER_PRECONDITION_FAILED',
      }
    : { outcome: 'accepted' };
}

describe('server-initiated consumer cancel', () => {
  // The instrument check. "Accepted" above means no channel error followed the settle, so the same
  // detection must see a refusal when there is one: a nack of a tag nobody delivered is a 406 that
  // closes the channel. Without this, a library that swallowed channel errors would read "accepted".
  it.each(subjects)(
    'AC-2 [$name] the instrument sees a refusal: a nack of a tag nobody delivered closes the channel with 406',
    async (subject) => {
      const forwarder = await createDialer().forwarder(
        { host: '127.0.0.1', port: portOf(broker.amqp), purpose: 'amqp' },
        { kind: 'direct' },
      );
      const model = await subject.driver.connect(
        {
          protocol: 'amqp',
          hostname: '192.0.2.1',
          port: 1,
          vhost: '%2F',
          heartbeat: 30,
        },
        {
          path: forwarder.path,
          timeout: 10_000,
          noDelay: true,
          clientProperties: { connection_name: 'product/contract/control/raw' },
          credentials: subject.driver.plain(
            broker.credentials.username,
            broker.credentials.password,
          ),
        },
      );
      try {
        const channel = await model.createChannel();
        const errors: Error[] = [];
        channel.on('error', (error) => errors.push(error));
        channel.nack({ fields: { deliveryTag: 4242 } }, false, true);
        await waitFor(() => errors.length > 0, 10_000, 'the channel error');
        expect(errors[0]).toMatchObject({ code: 406 });
      } finally {
        await model.close().catch(() => undefined);
        await forwarder.close();
      }
    },
  );
  for (const subject of subjects) {
    it.each(kinds)(
      `AC-2 [${subject.name}] the cancel is an event, and a nack of a held delivery afterwards is recorded (%s)`,
      async (type) => {
        const queue = unique(`cancel-${type}`);
        await declare(broker, queue, type);
        await fill(broker, subject, queue, ['c1', 'c2', 'c3']);

        const opened = await connectSource(
          optionsFor(broker, subject, unique('src')),
        );
        const events: ConnectionEvent[] = [];
        opened.subscribe((event) => events.push(event));
        const received: (Delivery | null)[] = [];
        const { consumerTag } = await opened.lease.consume(queue, 3, (d) =>
          received.push(d),
        );
        await waitFor(() => received.length === 3, 15_000, 'three deliveries');

        await deleteQueue(broker, queue);
        await waitFor(
          () => received.at(-1) === null,
          15_000,
          'the null delivery',
        );
        expect(received.filter((d) => d !== null)).toHaveLength(3);
        const cancel = events.find((event) => event.type === 'server-cancel');
        expect(cancel).toEqual({ type: 'server-cancel', consumerTag });

        const held = received.filter((d): d is Delivery => d !== null);
        const channelErrors = (): number =>
          events.filter((event) => event.type === 'channel-error').length;
        const nack = await attempt(
          () => {
            opened.lease.nackRequeue(
              held[0]?.tag ?? 0n,
              mintSafeReturnProof({ reason: 'classic' }),
            );
          },
          () => opened.lease.qosBarrier(1),
          channelErrors,
        );
        const ack =
          nack.outcome === 'accepted'
            ? await attempt(
                () => {
                  opened.lease.ackWithProof(
                    held[1]?.tag ?? 0n,
                    mintDestructiveConsentProof({ planHash: 'contract' }),
                  );
                },
                () => opened.lease.qosBarrier(1),
                channelErrors,
              )
            : ('not-attempted (channel closed by the nack)' as const);

        observed.push({
          library: subject.name,
          queueType: type,
          heldAtCancel: held.length,
          cancelEvent: { consumerTag },
          nackAfterCancel: nack,
          ackAfterNack: ack,
        });
        await opened.lease.release('poisoned');
      },
    );

    it(`AC-2 [${subject.name}] a cancel the client asked for is not a server cancel`, async () => {
      const queue = unique('client-cancel');
      await declare(broker, queue, 'classic');
      const opened = await connectSource(
        optionsFor(broker, subject, unique('src')),
      );
      const events: ConnectionEvent[] = [];
      opened.subscribe((event) => events.push(event));
      const received: (Delivery | null)[] = [];
      const { consumerTag } = await opened.lease.consume(queue, 1, (d) =>
        received.push(d),
      );
      await opened.lease.cancel(consumerTag);
      await deleteQueue(broker, queue);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(events.some((event) => event.type === 'server-cancel')).toBe(
        false,
      );
      expect(received).toEqual([]);
      await opened.lease.release('healthy');
    });
  }

  it('AC-2 both libraries record the same outcome for the same queue type', () => {
    expect(observed).toHaveLength(subjects.length * kinds.length);
    for (const type of kinds) {
      const [first, ...rest] = observed.filter((o) => o.queueType === type);
      expect(first).toBeDefined();
      expect(rest.length).toBe(subjects.length - 1);
      for (const other of rest) {
        expect(classify(other.nackAfterCancel)).toBe(
          classify(first?.nackAfterCancel ?? 'missing'),
        );
        expect(classify(other.ackAfterNack)).toBe(
          classify(first?.ackAfterNack ?? 'missing'),
        );
        expect(other.heldAtCancel).toBe(first?.heldAtCancel);
      }
    }
    recordObservation(broker, 'server-cancel', {
      question:
        'After the broker cancels a consumer (queue deleted), can a delivery that was held at that moment still be nacked (requeue) or acked on the same channel?',
      trigger:
        'queue deleted under an active consumer with 3 unacknowledged deliveries',
      results: observed,
    });
  });
});
