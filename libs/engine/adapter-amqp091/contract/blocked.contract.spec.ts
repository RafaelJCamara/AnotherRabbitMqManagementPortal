// Contract: `connection.blocked` / `connection.unblocked` through the publish lease, once per
// client library (M0-28). The broker's memory alarm is raised with `rabbitmqctl` inside the lab
// container; it is broker-wide, which is why the contract files run one after the other.
import { describe, expect, it } from 'vitest';

import { connectPublish, type ConnectionEvent } from '../src/index.ts';
import {
  contractBroker,
  declare,
  optionsFor,
  rabbitmqctl,
  subjects,
  text,
  unique,
  waitFor,
} from './harness.ts';

const broker = contractBroker();
/** Zero is "block every publisher"; 0.4 is the broker's default. */
const ALARM = ['set_vm_memory_high_watermark', '0'] as const;
const CLEAR = ['set_vm_memory_high_watermark', '0.4'] as const;

describe.each(subjects)('$name', (subject) => {
  it('AC-1 a memory alarm blocks the publisher (event, no proof) and lifting it unblocks it', async () => {
    const queue = unique('blocked');
    await declare(broker, queue, 'classic');
    const opened = await connectPublish(
      optionsFor(broker, subject, unique('pub')),
    );
    const { lease } = opened;
    const events: ConnectionEvent[] = [];
    opened.subscribe((event) => events.push(event));
    const has = (type: ConnectionEvent['type']): boolean =>
      events.some((event) => event.type === type);

    try {
      await rabbitmqctl(broker, ...ALARM);
      // The broker stops reading from a connection that publishes under an alarm: no confirm
      // comes, and it tells the client why with connection.blocked.
      const stuck = await lease.publish(
        '',
        queue,
        text('b1'),
        {},
        {
          mandatory: true,
          timeoutMs: 3_000,
        },
      );
      await waitFor(() => has('blocked'), 10_000, 'connection.blocked');
      expect(stuck.outcome === 'blocked' || stuck.outcome === 'timeout').toBe(
        true,
      );
      expect(lease.blocked()).toBe(true);
      expect('proof' in stuck).toBe(false);

      // While blocked, nothing is sent and the answer is immediate.
      const refused = await lease.publish(
        '',
        queue,
        text('b2'),
        {},
        {
          mandatory: true,
          timeoutMs: 3_000,
        },
      );
      expect(refused.outcome).toBe('blocked');
    } finally {
      await rabbitmqctl(broker, ...CLEAR);
    }

    await waitFor(() => has('unblocked'), 30_000, 'connection.unblocked');
    expect(lease.blocked()).toBe(false);
    const after = await lease.publish(
      '',
      queue,
      text('b3'),
      {},
      {
        mandatory: true,
        timeoutMs: 10_000,
      },
    );
    expect(after.outcome).toBe('confirmed');
    await lease.release();
  });
});
