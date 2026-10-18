import { describe, expect, it } from 'vitest';

import { connectControl } from '../connect.ts';
import { Amqp091Error } from '../errors.ts';
import { harness } from '../testing/harness.ts';

describe('ControlLease', () => {
  it('has only metadata methods: no get, consume, publish or settle', async () => {
    const h = harness();
    const { lease } = await connectControl(h.options);
    expect(Object.keys(lease).sort()).toEqual([
      'checkExchange',
      'checkQueue',
      'release',
    ]);
    expect(Object.isFrozen(lease)).toBe(true);
  });

  it('runs every passive declare on a throwaway channel that is closed afterwards', async () => {
    const h = harness();
    h.driver.model.onChannel = (channel) => {
      channel.queues.set('q', { messageCount: 3, consumerCount: 2 });
    };
    const { lease } = await connectControl(h.options);
    expect(await lease.checkQueue('q')).toEqual({
      messageCount: 3,
      consumerCount: 2,
    });
    await lease.checkExchange('amq.topic');
    expect(h.driver.model.channels).toHaveLength(2);
    expect(h.driver.model.channels.every((channel) => channel.closed)).toBe(
      true,
    );
  });

  it('a 404 closes only its own throwaway channel; the next call works', async () => {
    const h = harness();
    const { lease } = await connectControl(h.options);
    const error = await lease
      .checkQueue('missing')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Amqp091Error);
    expect((error as Amqp091Error).code).toBe('NOT_FOUND');

    h.driver.model.onChannel = (channel) => {
      channel.queues.set('q', { messageCount: 0, consumerCount: 0 });
    };
    await expect(lease.checkQueue('q')).resolves.toEqual({
      messageCount: 0,
      consumerCount: 0,
    });
  });

  it('refuses a bad name before it opens a channel, and bounds the calls in flight', async () => {
    const h = harness();
    const { lease } = await connectControl(h.options);
    await expect(lease.checkQueue('')).rejects.toMatchObject({
      reason: 'invalid-argument',
    });
    await expect(lease.checkExchange('a\nb')).rejects.toMatchObject({
      reason: 'invalid-argument',
    });
    expect(h.driver.model.channels).toHaveLength(0);

    let finish!: () => void;
    h.driver.model.openGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const running = Array.from({ length: 4 }, () =>
      lease.checkExchange('amq.topic'),
    );
    await expect(lease.checkExchange('amq.topic')).rejects.toMatchObject({
      reason: 'busy',
    });
    finish();
    await Promise.all(running);
  });

  it('release closes the connection; any later call is refused', async () => {
    const h = harness();
    const { lease } = await connectControl(h.options);
    await lease.release();
    expect(h.driver.model.closed).toBe(true);
    await expect(lease.checkQueue('q')).rejects.toMatchObject({
      reason: 'released',
    });
    await expect(lease.release('nope' as never)).rejects.toMatchObject({
      reason: 'invalid-argument',
    });
  });
});
