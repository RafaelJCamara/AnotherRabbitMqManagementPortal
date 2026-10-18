import { describe, expect, it } from 'vitest';

import { isConfirmedCopyProof, type PublishOutcome } from '@app/ports';

import { connectPublish } from '../connect.ts';
import { Amqp091Error } from '../errors.ts';
import type { FakeChannel } from '../testing/fake-driver.ts';
import { harness } from '../testing/harness.ts';

const MANDATORY = { mandatory: true, timeoutMs: 1_000 } as const;
const body = new TextEncoder().encode('payload');

async function open(configure?: (channel: FakeChannel) => void) {
  const h = harness();
  h.driver.model.onChannel = (channel) => {
    configure?.(channel);
  };
  const opened = await connectPublish(h.options);
  return { ...h, ...opened };
}

const reasonOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof Amqp091Error ? error.reason : error),
  );

const published = (channel: FakeChannel) =>
  channel.calls.filter((call) => call.method === 'publish');

describe('PublishLease', () => {
  it('has exactly publish, blocked and release: it cannot consume or settle', async () => {
    const { lease } = await open();
    expect(Object.keys(lease).sort()).toEqual([
      'blocked',
      'publish',
      'release',
    ]);
    const loose = lease as unknown as Record<string, unknown>;
    for (const forbidden of ['get', 'consume', 'ackWithProof', 'nackRequeue']) {
      expect(loose[forbidden]).toBeUndefined();
    }
    expect(Object.isFrozen(lease)).toBe(true);
  });

  it('publishes on a confirm channel, mandatory, and a broker confirm yields the only copy proof', async () => {
    const { lease, driver } = await open();
    const outcome = await lease.publish(
      '',
      'q.quarantine',
      body,
      {},
      MANDATORY,
    );

    expect(outcome.outcome).toBe('confirmed');
    if (outcome.outcome !== 'confirmed') return;
    expect(isConfirmedCopyProof(outcome.proof)).toBe(true);
    expect(outcome.proof).toMatchObject({
      kind: 'confirmed-copy',
      destination: 'q.quarantine',
      confirmedAt: 1_700_000_000_000,
    });
    const channel = driver.model.last();
    expect(channel.confirm).toBe(true);
    const [call] = published(channel);
    expect(call?.args.slice(0, 2)).toEqual(['', 'q.quarantine']);
    expect(call?.args[3]).toMatchObject({ mandatory: true });
  });

  it('names the destination exchange/key when the exchange is not the default', async () => {
    const { lease } = await open();
    const outcome = await lease.publish('ex', 'key', body, {}, MANDATORY);
    expect(outcome.outcome === 'confirmed' && outcome.proof.destination).toBe(
      'ex/key',
    );
  });

  it('a mandatory message the broker returns is not a copy: no proof, even though the broker confirms', async () => {
    const { lease } = await open((channel) => {
      channel.confirmMode = 'return';
    });
    const outcome = await lease.publish('', 'nowhere', body, {}, MANDATORY);
    expect(outcome).toEqual({ outcome: 'returned', reason: 'NO_ROUTE' });
    expect('proof' in outcome).toBe(false);
  });

  it('a broker nack is no proof', async () => {
    const { lease } = await open((channel) => {
      channel.confirmMode = 'nack';
    });
    const outcome = await lease.publish('', 'q', body, {}, MANDATORY);
    expect(outcome.outcome).toBe('nacked');
    expect('proof' in outcome).toBe(false);
  });

  it('no confirm in time is a timeout with no proof, and a late confirm cannot reach the next publish', async () => {
    const { lease, driver } = await open((channel) => {
      channel.confirmMode = 'never';
    });
    const outcome = await lease.publish(
      '',
      'q',
      body,
      {},
      {
        mandatory: true,
        timeoutMs: 20,
      },
    );
    expect(outcome.outcome).toBe('timeout');
    expect('proof' in outcome).toBe(false);

    const first = driver.model.channels[0];
    expect(first?.closed).toBe(true);
    // The next publish gets a fresh channel; the old callback answering now changes nothing.
    driver.model.onChannel = (channel) => {
      channel.confirmMode = 'ack';
    };
    first?.pendingConfirms[0]?.(null);
    const next = await lease.publish('', 'q', body, {}, MANDATORY);
    expect(next.outcome).toBe('confirmed');
    expect(driver.model.channels).toHaveLength(2);
  });

  it('a channel the broker closes (no such exchange) is an error, never an outcome with a proof', async () => {
    const { lease } = await open((channel) => {
      channel.confirmMode = 'error';
    });
    const error = await lease
      .publish('ghost', 'k', body, {}, MANDATORY)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Amqp091Error);
    expect(error).toMatchObject({
      reason: 'channel-closed',
      code: 'NOT_FOUND',
    });
  });

  it('when the connection is blocked nothing is sent and the outcome is blocked', async () => {
    const { lease, driver } = await open();
    await lease.publish('', 'q', body, {}, MANDATORY);
    driver.model.emit('blocked', 'low on memory');
    expect(lease.blocked()).toBe(true);
    const outcome = await lease.publish('', 'q', body, {}, MANDATORY);
    expect(outcome).toEqual({ outcome: 'blocked', reason: 'low on memory' });
    expect(published(driver.model.last())).toHaveLength(1);

    driver.model.emit('unblocked');
    expect(lease.blocked()).toBe(false);
    expect((await lease.publish('', 'q', body, {}, MANDATORY)).outcome).toBe(
      'confirmed',
    );
  });

  it('a block that begins while waiting for the confirm is reported as blocked when the wait ends', async () => {
    const { lease, driver } = await open((channel) => {
      channel.confirmMode = 'never';
    });
    const pending = lease.publish(
      '',
      'q',
      body,
      {},
      {
        mandatory: true,
        timeoutMs: 30,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    driver.model.emit('blocked', 'disk alarm');
    expect(await pending).toEqual({ outcome: 'blocked', reason: 'disk alarm' });
  });

  it('mandatory cannot be switched off, however the call is made', async () => {
    const { lease, driver } = await open();
    for (const options of [
      { mandatory: false, timeoutMs: 10 },
      { mandatory: 'true', timeoutMs: 10 },
      { timeoutMs: 10 },
      undefined,
    ]) {
      expect(
        await reasonOf(lease.publish('', 'q', body, {}, options as never)),
      ).toBe('forbidden-settle');
    }
    // And a property bag cannot carry the flag in: it is not a property of a message.
    for (const props of [
      { mandatory: false },
      { immediate: true },
      { CC: ['other'] },
      { BCC: ['other'] },
      { 'x-anything': 1 },
    ]) {
      expect(
        await reasonOf(lease.publish('', 'q', body, props, MANDATORY)),
      ).toBe('invalid-argument');
    }
    expect(driver.model.channels).toHaveLength(0);
  });

  it('validates the call: timeout, body, names', async () => {
    const { lease } = await open();
    for (const timeoutMs of [0, -1, 1.5, 10 ** 9, Number.NaN]) {
      expect(
        await reasonOf(
          lease.publish('', 'q', body, {}, { mandatory: true, timeoutMs }),
        ),
      ).toBe('invalid-argument');
    }
    expect(
      await reasonOf(lease.publish('', 'q', 'text' as never, {}, MANDATORY)),
    ).toBe('invalid-argument');
    expect(await reasonOf(lease.publish('', '', body, {}, MANDATORY))).toBe(
      'invalid-argument',
    );
  });

  it('typed headers are encoded with the type that was asked for; untyped ones are refused', async () => {
    const { lease, driver } = await open();
    await lease.publish(
      '',
      'q',
      body,
      {
        contentType: 'text/plain',
        deliveryMode: 2,
        headers: {
          count: { t: 'long', v: 3 },
          name: { t: 'string', v: 'n' },
          nested: { t: 'table', v: { ok: { t: 'bool', v: true } } },
        },
      },
      MANDATORY,
    );
    const options = published(driver.model.last())[0]?.args[3] as Record<
      string,
      unknown
    >;
    expect(options.contentType).toBe('text/plain');
    expect(options.deliveryMode).toBe(2);
    expect(options.headers).toEqual({
      count: { '!': 'long', value: 3 },
      name: 'n',
      nested: { ok: true },
    });
    expect(
      await reasonOf(
        lease.publish('', 'q', body, { headers: { count: 3 } }, MANDATORY),
      ),
    ).toBe('invalid-argument');
  });

  it('publishes one at a time, so a return belongs to the message in flight', async () => {
    const { lease, driver } = await open((channel) => {
      channel.confirmMode = 'never';
    });
    const first = lease.publish('', 'a', body, {}, MANDATORY);
    const second = lease.publish('', 'b', body, {}, MANDATORY);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const channel = driver.model.last();
    expect(published(channel)).toHaveLength(1);

    channel.pendingConfirms[0]?.(null);
    expect((await first).outcome).toBe('confirmed');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(published(channel)).toHaveLength(2);
    channel.pendingConfirms[1]?.(null);
    expect((await second).outcome).toBe('confirmed');
  });

  it('a failed publish does not stop the next one', async () => {
    const { lease } = await open();
    expect(await reasonOf(lease.publish('', '', body, {}, MANDATORY))).toBe(
      'invalid-argument',
    );
    const next: PublishOutcome = await lease.publish(
      '',
      'q',
      body,
      {},
      MANDATORY,
    );
    expect(next.outcome).toBe('confirmed');
  });

  it('release closes the confirm channel and the connection, and the lease is dead afterwards', async () => {
    const { lease, driver, dialer } = await open();
    await lease.publish('', 'q', body, {}, MANDATORY);
    await lease.release();
    expect(driver.model.channels[0]?.closed).toBe(true);
    expect(driver.model.closed).toBe(true);
    expect(dialer.closed).toBeGreaterThanOrEqual(1);
    expect(await reasonOf(lease.publish('', 'q', body, {}, MANDATORY))).toBe(
      'released',
    );
  });
});
