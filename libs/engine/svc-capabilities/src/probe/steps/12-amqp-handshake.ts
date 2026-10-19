// Step 12, AMQP handshake: connect, read what the broker says about itself (server properties, the
// channel and frame limits it advertises), disconnect. The socket is the wire probe's (Dialer, I-9).
// A blocked AMQP port is a normal answer: the management API can work while 5672 does not.
import type { ProbeStep } from '../types';

export const amqpHandshakeStep: ProbeStep = {
  id: 'amqp-handshake',
  async run(env, facts) {
    const result = await env.wire.amqpHandshake(env.connectionId, env.signal);
    facts.amqp = result;
    if (!result.ok) {
      return { status: 'unavailable', detail: result.failure.reason };
    }
    return {
      status: 'ok',
      detail:
        result.frameMax === undefined && result.channelMax === undefined
          ? 'connected; the broker reported no limits'
          : 'connected',
    };
  },
};
