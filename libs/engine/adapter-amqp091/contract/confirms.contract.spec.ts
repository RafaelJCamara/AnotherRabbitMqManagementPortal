// Contract: publisher confirms, mandatory returns and negative confirms through the publish lease,
// once per client library (M0-28). A proof exists only when the broker confirmed the message and
// did not return it, so a library that reports a return or a nack differently would let a copy be
// "proven" that is not there.
import { describe, expect, it } from 'vitest';

import type { PublishOutcome } from '@app/ports';

import { connectPublish } from '../src/index.ts';
import {
  contractBroker,
  declare,
  deleteQueue,
  MANDATORY,
  optionsFor,
  subjects,
  text,
  unique,
} from './harness.ts';

const broker = contractBroker();

describe.each(subjects)('$name', (subject) => {
  const open = () => connectPublish(optionsFor(broker, subject, unique('pub')));

  it('AC-1 a mandatory publish to a routed queue is confirmed and carries a proof naming the queue', async () => {
    const queue = unique('routed');
    await declare(broker, queue, 'classic');
    const { lease } = await open();
    const outcome: PublishOutcome = await lease.publish(
      '',
      queue,
      text('hello'),
      { contentType: 'text/plain' },
      MANDATORY,
    );
    expect(outcome.outcome).toBe('confirmed');
    expect(outcome.outcome === 'confirmed' && outcome.proof.destination).toBe(
      queue,
    );
    expect(lease.blocked()).toBe(false);
    await lease.release();
  });

  it('AC-1 a mandatory publish nobody routes is returned, and returns carry no proof', async () => {
    const { lease } = await open();
    const lost = await lease.publish(
      '',
      unique('no-such-queue'),
      text('hello'),
      {},
      MANDATORY,
    );
    expect(lost.outcome).toBe('returned');
    expect('proof' in lost).toBe(false);

    // The next publish on the same lease is judged on its own, not by the earlier return.
    const queue = unique('routed-after');
    await declare(broker, queue, 'classic');
    const routed = await lease.publish('', queue, text('x'), {}, MANDATORY);
    expect(routed.outcome).toBe('confirmed');
    await lease.release();
  });

  it('AC-1 a publish the queue refuses (reject-publish at its limit) is a negative confirm, not a proof', async () => {
    const queue = unique('full');
    await declare(broker, queue, 'classic', {
      'x-max-length': 1,
      'x-overflow': 'reject-publish',
    });
    const { lease } = await open();
    expect(
      (await lease.publish('', queue, text('1'), {}, MANDATORY)).outcome,
    ).toBe('confirmed');
    const refused = await lease.publish('', queue, text('2'), {}, MANDATORY);
    expect(refused.outcome).toBe('nacked');
    expect('proof' in refused).toBe(false);
    // A nack does not poison the lease.
    await deleteQueue(broker, queue);
    await lease.release();
  });

  it('AC-1 fifty publishes in a row are each confirmed', async () => {
    const queue = unique('burst');
    await declare(broker, queue, 'quorum');
    const { lease } = await open();
    const outcomes: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      outcomes.push(
        (await lease.publish('', queue, text(String(i)), {}, MANDATORY))
          .outcome,
      );
    }
    expect(outcomes.every((outcome) => outcome === 'confirmed')).toBe(true);
    await lease.release();
  });
});
