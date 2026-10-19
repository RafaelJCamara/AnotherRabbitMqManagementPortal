import { describe, expect, it } from 'vitest';

import { amqpPortsFromListeners } from './listeners';

describe('amqpPortsFromListeners', () => {
  it('takes the plain and the TLS AMQP port from /api/overview listeners and ignores the other protocols', () => {
    expect(
      amqpPortsFromListeners([
        { protocol: 'clustering', port: 25672 },
        { protocol: 'amqp', port: 5672 },
        { protocol: 'amqp/ssl', port: 5671 },
        { protocol: 'http', port: 15672 },
        { protocol: 'stream', port: 5552 },
      ]),
    ).toEqual({ plain: 5672, tls: 5671 });
  });

  it('answers null for a kind the broker does not listen on', () => {
    expect(amqpPortsFromListeners([{ protocol: 'amqp', port: 5672 }])).toEqual({
      plain: 5672,
      tls: null,
    });
    expect(amqpPortsFromListeners([])).toEqual({ plain: null, tls: null });
  });

  it('picks the port most nodes use, and the lowest on a tie, whatever the order of the nodes', () => {
    const listeners = [
      { protocol: 'amqp', port: 5673 },
      { protocol: 'amqp', port: 5672 },
      { protocol: 'amqp', port: 5672 },
      { protocol: 'amqp/ssl', port: 5772 },
      { protocol: 'amqp/ssl', port: 5771 },
    ];

    expect(amqpPortsFromListeners(listeners)).toEqual({
      plain: 5672,
      tls: 5771,
    });
    expect(amqpPortsFromListeners([...listeners].reverse())).toEqual({
      plain: 5672,
      tls: 5771,
    });
  });
});
