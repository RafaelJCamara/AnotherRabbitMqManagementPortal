// Contract: logging in, naming the connection, and a broker that closes it, once per client library
// (M0-28). SASL EXTERNAL is the one capability the libraries do not share: amqplib has it,
// @cloudamqp/amqp-client 4.1.1 offers PLAIN only. The suite records that as an expected skip
// (OQ-260) instead of dropping the case.
import { describe, expect, it } from 'vitest';

import {
  connectControl,
  connectPeek,
  type Amqp091Error,
  type ConnectionEvent,
} from '../src/index.ts';
import {
  contractBroker,
  optionsFor,
  rabbitmqctl,
  subjects,
  unique,
  waitFor,
} from './harness.ts';

const broker = contractBroker();

describe.each(subjects)('$name', (subject) => {
  it('AC-1 a PLAIN login is accepted and a wrong password is refused as auth-refused', async () => {
    const good = await connectControl(
      optionsFor(broker, subject, unique('ctl')),
    );
    await good.lease.release();

    const error = await connectControl(
      optionsFor(broker, subject, unique('bad'), {
        credentials: { kind: 'plain', username: 'guest', password: 'wrong' },
      }),
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      reason: 'auth-refused',
      code: 'UNAUTHENTICATED',
    });
  });

  // The lab broker does not enable rabbitmq_auth_mechanism_ssl, so it cannot accept EXTERNAL; what
  // is shared is that asking for it ends in a typed error, not a hang.
  // A real EXTERNAL login needs client certificates and that plugin; the lab has neither (OQ-260).
  const external = subject.external ? it : it.skip;
  external(
    subject.external
      ? 'AC-1 an EXTERNAL login against a broker that does not offer it fails with a typed error, quickly'
      : 'AC-1 an EXTERNAL login against a broker that does not offer it fails with a typed error, quickly (expected skip: @cloudamqp/amqp-client 4.1.1 offers PLAIN only)',
    async () => {
      const started = Date.now();
      const error = await connectControl(
        optionsFor(broker, subject, unique('ext'), {
          credentials: { kind: 'external' },
        }),
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Amqp091Error).code).toMatch(/^[A-Z_]+$/);
      expect(Date.now() - started).toBeLessThan(15_000);
    },
  );

  it('AC-1 the connection shows up at the broker as <product>/<mode>/<role>/<session>', async () => {
    const session = unique('named');
    const opened = await connectPeek({
      ...optionsFor(broker, subject, session),
      queueTypes: { typeOf: () => 'classic' },
    });
    const name = `product/contract/peek/${session}`;
    expect(opened.info.connectionName).toBe(name);
    await waitFor(
      async () => {
        const listed = await rabbitmqctl(
          broker,
          'list_connections',
          'client_properties',
        );
        // The name is ours; the product is the library's own, so this is the library we asked for.
        return listed
          .split('\n')
          .some(
            (line) => line.includes(name) && line.includes(subject.product),
          );
      },
      15_000,
      'the connection name at the broker',
    );
    await opened.lease.release('healthy');
  });

  it('AC-1 a connection the broker closes is reported as closed with a retryable error', async () => {
    const opened = await connectPeek({
      ...optionsFor(broker, subject, unique('forced')),
      queueTypes: { typeOf: () => 'classic' },
    });
    const events: ConnectionEvent[] = [];
    opened.subscribe((event) => events.push(event));
    await rabbitmqctl(
      broker,
      'close_all_connections',
      '--global',
      'contract suite',
    );
    await waitFor(
      () => events.some((event) => event.type === 'closed'),
      15_000,
      'the closed event',
    );
    const closed = events.find((event) => event.type === 'closed');
    expect(closed).toMatchObject({
      type: 'closed',
      error: { code: 'BROKER_UNREACHABLE', retryable: true },
    });
    await expect(opened.lease.get('anything')).rejects.toMatchObject({
      code: 'BROKER_UNREACHABLE',
    });
  });
});
