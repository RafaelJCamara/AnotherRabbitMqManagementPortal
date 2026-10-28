// `connection.update-secret` and the credentials function (M1-23, slice E1, AC-23): the adapter
// passes a renewed secret to the driver once, keeps none, tells a refusal with fixed text, and a
// reconnect asks for the login again. The driver is the scripted fake; amqplib over a socket is in
// `update-secret.wiring.spec.ts`.
import { inspect } from 'node:util';

import { describe, expect, expectTypeOf, it } from 'vitest';

import type { ConnectorEvent, OpenedConnection, PeekLease } from '@app/ports';

import type { ConnectionEvent } from './channel.ts';
import { connectControl, type OpenedLease } from './connect.ts';
import type { AmqpModel, AmqplibModel } from './driver.ts';
import { Amqp091Error } from './errors.ts';
import { harness } from './testing/harness.ts';

const SECRET = 'eyJhbGciOi.canary-token-4f2a9c.sig';
const MISMATCH = 'mismatch_username_after_token_refresh';

/** Everything an error shows: its fields, message, stack and cause, as a log or a dump would. */
const shown = (value: unknown): string =>
  `${inspect(value, { depth: 12, showHidden: true })}\n${String(value)}\n${JSON.stringify(value)}`;

const failure = async (promise: Promise<unknown>): Promise<Amqp091Error> => {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Amqp091Error);
  return error as Amqp091Error;
};

/** What amqplib 2.2.0 emits for a close frame from the broker: a message and a numeric code. */
const brokerClose = (code: number, text: string): Error =>
  Object.assign(
    new Error(
      `Connection closed: ${String(code)} (NAME) with message "${text}"`,
    ),
    { code },
  );

/** A library may reject with anything, a string included (a thenable keeps the lint rule quiet). */
const rejectWith = (reason: unknown): Promise<void> =>
  ({
    then: (_ok: unknown, fail: (value: unknown) => void) => {
      fail(reason);
    },
  }) as unknown as Promise<void>;

const never = (): Promise<void> => new Promise<void>(() => undefined);

async function open(overrides: Parameters<typeof harness>[0] = {}) {
  const h = harness(overrides);
  const opened = await connectControl(h.options);
  return { h, opened, model: h.driver.model };
}

describe('M1-23 AC-23 update-secret', () => {
  it('M1-23 AC-23 adapter updateSecret passes the secret on, keeps none and maps a username mismatch', async () => {
    // A credentials function: asked at each connect, so a reconnect has the renewed value.
    let current = 'pw-first';
    let asked = 0;
    const h = harness({
      credentials: () => {
        asked += 1;
        return { kind: 'plain', username: 'guest', password: current };
      },
    });
    expect(asked).toBe(0);
    const opened = await connectControl(h.options);
    expect(asked).toBe(1);
    const loginOf = (index: number): string =>
      h.driver.connects[index]?.options.credentials.response().toString() ?? '';
    expect(loginOf(0)).toBe('\u0000guest\u0000pw-first');

    // The secret reaches the driver once, as bytes, with the reason; the bytes are wiped after.
    await opened.updateSecret(SECRET, 'token-refresh');
    expect(h.driver.model.secretUpdates).toHaveLength(1);
    const update = h.driver.model.secretUpdates[0];
    expect(update?.secret).toBe(SECRET);
    expect(update?.reason).toBe('token-refresh');
    expect(update?.buffer.every((byte) => byte === 0)).toBe(true);
    expect(shown(opened)).not.toContain(SECRET);
    expect(shown(h.driver.connects)).not.toContain(SECRET);

    // The broker refuses a token for another user: it closes over it, quoting what it was sent.
    h.driver.model.onUpdateSecret = (secret) =>
      Promise.reject(
        brokerClose(
          530,
          `NOT_ALLOWED - New secret was refused by one of the backends: ${MISMATCH} ${secret}`,
        ),
      );
    const refused = await failure(opened.updateSecret(SECRET, 'token-refresh'));
    expect(refused.reason).toBe('secret-refused');
    expect(refused.code).toBe('UNAUTHENTICATED');
    expect(refused.retryable).toBe(false);
    expect(refused.detail).toBe(
      'the broker refused the new secret: the user name differs from the login',
    );
    expect(refused.broker).toEqual({ protocol: 'amqp091', code: 530 });
    expect(refused.cause).toBeUndefined();
    expect(shown(refused)).not.toContain(SECRET);
    expect(h.driver.model.secretUpdates).toHaveLength(2);
    expect(
      h.driver.model.secretUpdates.every((u) => u.buffer.every((b) => b === 0)),
    ).toBe(true);

    // A reconnect asks the function again and logs in with what it returns now.
    current = 'pw-renewed';
    await connectControl(h.options);
    expect(asked).toBe(2);
    expect(loginOf(1)).toBe('\u0000guest\u0000pw-renewed');
  });
});

describe('M1-23 slice E1 what may be sent', () => {
  it('sends the bytes of the text as UTF-8', async () => {
    const { opened, model } = await open();
    await opened.updateSecret('tök€n-🐇', 'r');
    expect(model.secretUpdates[0]?.secret).toBe('tök€n-🐇');
  });

  it.each([
    ['an empty secret', '', 'refresh'],
    ['a secret that is not text', 42 as unknown as string, 'refresh'],
    ['a secret over 65,536 bytes', 'x'.repeat(65_537), 'refresh'],
    ['a multi-byte secret over 65,536 bytes', '€'.repeat(21_846), 'refresh'],
    ['an empty reason', SECRET, ''],
    ['a reason over 128 characters', SECRET, 'r'.repeat(129)],
    ['a reason with a control character', SECRET, 'a\nb'],
    ['a reason with a unit separator', SECRET, 'a\u001fb'],
    ['a reason with DEL', SECRET, 'a\u007fb'],
    ['a reason that is not ASCII', SECRET, 'café'],
    ['a reason that is not text', SECRET, undefined as unknown as string],
  ])('refuses %s before anything is sent', async (_name, secret, reason) => {
    const { opened, model } = await open();
    const error = await failure(opened.updateSecret(secret, reason));
    expect(error.reason).toBe('invalid-argument');
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(model.secretUpdates).toHaveLength(0);
    expect(shown(error)).not.toContain('x'.repeat(100));
    expect(shown(error)).not.toContain(SECRET);
  });

  it('accepts a secret of exactly 65,536 bytes, a reason of 128 characters and the whole printable range', async () => {
    const { opened, model } = await open();
    await opened.updateSecret('x'.repeat(65_536), 'r'.repeat(128));
    await opened.updateSecret(SECRET, ' ~ a reason ~ ');
    expect(model.secretUpdates).toHaveLength(2);
  });

  it('refuses a second update while one waits, and the first still completes', async () => {
    const { opened, model } = await open();
    let answer: (() => void) | undefined;
    model.onUpdateSecret = () =>
      new Promise<void>((resolve) => {
        answer = resolve;
      });
    const first = opened.updateSecret(SECRET, 'one');
    const second = await failure(opened.updateSecret(SECRET, 'two'));
    expect(second.reason).toBe('busy');
    expect(model.secretUpdates).toHaveLength(1);
    answer?.();
    await first;
    // The slot is free again.
    model.onUpdateSecret = () => Promise.resolve();
    await opened.updateSecret(SECRET, 'three');
    expect(model.secretUpdates).toHaveLength(2);
  });
});

describe('M1-23 slice E1 how a failure is told', () => {
  it('a broker that never answers ends with a retryable timeout and the connection stays open', async () => {
    const { opened, model } = await open({ operationTimeoutMs: 20 });
    model.onUpdateSecret = never;
    const error = await failure(opened.updateSecret(SECRET, 'refresh'));
    expect(error.reason).toBe('timeout');
    expect(error.retryable).toBe(true);
    expect(error.detail).toBe('updating the secret failed: timeout');
    expect(shown(error)).not.toContain(SECRET);
    // Not the lease's business to close it; the manager decides.
    expect(model.closed).toBe(false);
  });

  it.each([
    [530, 'NOT_ALLOWED - refused'],
    [403, 'ACCESS_REFUSED - refused'],
  ])(
    'a refusal that closes the connection (%s) rejects the waiting update with the fixed text',
    async (code, text) => {
      const { h, opened, model } = await open();
      model.onUpdateSecret = never;
      const events: ConnectionEvent[] = [];
      opened.subscribe((event) => events.push(event));
      const waiting = opened.updateSecret(SECRET, 'refresh');
      // amqplib emits 'error' only for a fatal close, then 'close' with the same error.
      const error = brokerClose(code, `${text} ${SECRET}`);
      model.emit('error', error);
      model.emit('close', error);
      const refused = await failure(waiting);
      expect(refused.reason).toBe('secret-refused');
      expect(refused.detail).toBe('the broker refused the new secret');
      expect(refused.broker).toEqual({ protocol: 'amqp091', code });
      expect(refused.cause).toBeUndefined();
      expect(shown(refused)).not.toContain(SECRET);
      // The close that followed says the same, and the error a later call meets is as clean.
      const closed = events.find((event) => event.type === 'closed');
      expect(closed).toMatchObject({ type: 'closed', code });
      expect(shown(closed)).not.toContain(SECRET);
      const later = await failure(opened.updateSecret(SECRET, 'again'));
      expect(shown(later)).not.toContain(SECRET);
      expect(h.driver.model.secretUpdates).toHaveLength(1);
    },
  );

  it('the user-name mismatch is named even when the close carries no code', async () => {
    const { opened, model } = await open();
    model.onUpdateSecret = () =>
      Promise.reject(new Error(`${MISMATCH}: ${SECRET}`));
    const error = await failure(opened.updateSecret(SECRET, 'refresh'));
    expect(error.reason).toBe('secret-refused');
    expect(error.detail).toContain('the user name differs');
    expect(error.broker).toBeUndefined();
    expect(shown(error)).not.toContain(SECRET);
  });

  it('only the exact name of the mismatch counts, not a longer or a shorter one', async () => {
    const { opened, model } = await open();
    for (const text of [
      'mismatch_username_other',
      'mismatch_username_after_token',
    ]) {
      model.onUpdateSecret = () => rejectWith(new Error(`${text} ${SECRET}`));
      const error = await failure(opened.updateSecret(SECRET, 'refresh'));
      expect(error.reason).toBe('broker-error');
    }
  });

  it('a 320 close is not a refusal: it is retryable, and its code reaches the subscriber', async () => {
    const { opened, model } = await open();
    model.onUpdateSecret = never;
    const events: ConnectorEvent[] = [];
    opened.subscribe((event) => events.push(event));
    const waiting = opened.updateSecret(SECRET, 'refresh');
    model.emit(
      'close',
      brokerClose(320, `CONNECTION_FORCED - credential expired ${SECRET}`),
    );
    const error = await failure(waiting);
    expect(error.reason).toBe('broker-error');
    expect(error.code).toBe('BROKER_UNREACHABLE');
    expect(error.retryable).toBe(true);
    expect(error.broker).toEqual({ protocol: 'amqp091', code: 320 });
    expect(events.find((event) => event.type === 'closed')?.code).toBe(320);
    // The close that no 'error' came before is told without the broker's text as well.
    expect(shown(events)).not.toContain(SECRET);
  });

  it('a driver error that quotes the secret, or is not an error, leaves no trace of it', async () => {
    const { opened, model } = await open();
    for (const rejection of [
      new Error(`could not use ${SECRET}`),
      `bad value ${SECRET}`,
      Object.assign(new Error(`boom ${SECRET}`), { cause: new Error(SECRET) }),
      { message: SECRET, code: 'ECONNRESET' },
    ]) {
      model.onUpdateSecret = () => rejectWith(rejection);
      const error = await failure(opened.updateSecret(SECRET, 'refresh'));
      expect(error.cause).toBeUndefined();
      expect(shown(error)).not.toContain(SECRET);
      expect(error.detail).toMatch(/^updating the secret failed: /);
    }
  });

  it('a connection that drops while an update waits rejects it, and nothing is left waiting', async () => {
    const { opened, model } = await open();
    model.onUpdateSecret = never;
    const waiting = opened.updateSecret(SECRET, 'refresh');
    model.drop();
    const error = await failure(waiting);
    expect(error.reason).toBe('connection-closed');
    expect(error.retryable).toBe(true);
    // A new update meets the closed connection, not `busy`.
    expect((await failure(opened.updateSecret(SECRET, 'x'))).reason).toBe(
      'connection-closed',
    );
  });

  it('closing the lease while an update waits rejects it as released', async () => {
    const { opened, model } = await open();
    model.onUpdateSecret = never;
    const waiting = opened.updateSecret(SECRET, 'refresh');
    await opened.lease.release('healthy');
    expect((await failure(waiting)).reason).toBe('released');
    expect((await failure(opened.updateSecret(SECRET, 'x'))).reason).toBe(
      'released',
    );
  });

  it('only a close by the broker carries a reply code', async () => {
    const dropped = await open();
    const droppedEvents: ConnectorEvent[] = [];
    dropped.opened.subscribe((event) => droppedEvents.push(event));
    dropped.model.drop(new Error('Heartbeat timeout'));
    expect(droppedEvents).toEqual([
      expect.objectContaining({ type: 'closed' }),
    ]);
    expect(droppedEvents[0]).not.toHaveProperty('code');

    const released = await open();
    const releasedEvents: ConnectorEvent[] = [];
    released.opened.subscribe((event) => releasedEvents.push(event));
    await released.opened.lease.release('healthy');
    expect(releasedEvents).toEqual([{ type: 'closed' }]);
  });

  it('an update after an ordinary 320 close (nothing waiting) reports the connection error', async () => {
    const { opened, model } = await open();
    model.emit(
      'close',
      brokerClose(320, 'CONNECTION_FORCED - credential expired'),
    );
    const error = await failure(opened.updateSecret(SECRET, 'late'));
    expect(error.broker?.code).toBe(320);
    expect(model.secretUpdates).toHaveLength(0);
  });
});

describe('M1-23 slice E1 the credentials function', () => {
  it('may be asynchronous, and an external login needs no secret', async () => {
    const h = harness({
      credentials: () => Promise.resolve({ kind: 'external' }),
    });
    await connectControl(h.options);
    expect(h.driver.connects[0]?.options.credentials.mechanism).toBe(
      'EXTERNAL',
    );
  });

  it('a plain value is still accepted and is not called', async () => {
    const h = harness();
    await connectControl(h.options);
    expect(h.driver.connects[0]?.options.credentials.mechanism).toBe('PLAIN');
  });

  it.each([
    [
      'throws',
      () => {
        throw new Error(`no token ${SECRET}`);
      },
    ],
    ['rejects', () => Promise.reject(new Error(`no token ${SECRET}`))],
    ['returns nothing', () => undefined],
    [
      'returns a login of another shape',
      () => ({ kind: 'bearer', token: SECRET }),
    ],
    [
      'returns a plain login without a password',
      () => ({ kind: 'plain', username: 'guest' }),
    ],
    [
      'returns a plain login with a number for the user',
      () => ({ kind: 'plain', username: 7, password: 'p' }),
    ],
  ])(
    'a function that %s fails the connect with a fixed text and no cause',
    async (_name, credentials) => {
      const h = harness({
        credentials: credentials as unknown as () => never,
      });
      const error = await failure(connectControl(h.options));
      expect(error.reason).toBe('credentials-unavailable');
      expect(error.code).toBe('UNAUTHENTICATED');
      expect(error.retryable).toBe(false);
      expect(error.cause).toBeUndefined();
      expect(shown(error)).not.toContain(SECRET);
      expect(h.driver.connects).toHaveLength(0);
      // The Dialer's endpoint is dropped, as for any failed connect.
      expect(h.dialer.closed).toBeGreaterThanOrEqual(1);
    },
  );

  it('is part of the connect budget: one that never answers times out', async () => {
    const h = harness({ credentials: never as never, connectTimeoutMs: 20 });
    const error = await failure(connectControl(h.options));
    expect(error.reason).toBe('timeout');
    expect(h.driver.connects).toHaveLength(0);
    expect(h.dialer.closed).toBeGreaterThanOrEqual(1);
  });

  it("and the caller's signal ends it", async () => {
    const controller = new AbortController();
    const h = harness({
      credentials: never as never,
      signal: controller.signal,
    });
    const connecting = connectControl(h.options);
    setTimeout(() => {
      controller.abort();
    }, 10);
    expect((await failure(connecting)).reason).toBe('aborted');
    expect(h.driver.connects).toHaveLength(0);
  });
});

describe('M1-23 slice E1 types', () => {
  it('the handle fits the connector seam, and the seam fits amqplib', () => {
    // The composition root offers `renew` from the handle without a cast.
    expectTypeOf<OpenedLease<PeekLease>['updateSecret']>().toExtend<
      NonNullable<OpenedConnection<PeekLease>['renew']>
    >();
    // amqplib's own signature is the seam's (a Buffer and a reason).
    expectTypeOf<AmqplibModel['updateSecret']>().toEqualTypeOf<
      AmqpModel['updateSecret']
    >();
    // The adapter's close event is a connector event.
    expectTypeOf<ConnectionEvent>().toExtend<ConnectorEvent>();
  });
});
