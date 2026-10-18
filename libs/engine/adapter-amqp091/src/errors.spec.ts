import { describe, expect, it } from 'vitest';

import { Amqp091Error, mapAmqplibError, safeText } from './errors.ts';

const broker = (code: number, message: string): Error =>
  Object.assign(new Error(message), { code, classId: 50, methodId: 10 });

describe('mapAmqplibError', () => {
  it.each([
    [403, 'FORBIDDEN_BROKER'],
    [404, 'NOT_FOUND'],
    [405, 'BROKER_RESOURCE_LOCKED'],
    [406, 'BROKER_PRECONDITION_FAILED'],
    [320, 'BROKER_UNREACHABLE'],
    [540, 'BROKER_ERROR'],
    [504, 'BROKER_ERROR'],
  ])('maps the broker reply code %i to %s', (reply, expected) => {
    const mapped = mapAmqplibError(
      broker(reply, `Channel closed by server: ${String(reply)} (X)`),
      'basic.get',
    );
    expect(mapped.code).toBe(expected);
    expect(mapped.broker).toMatchObject({
      protocol: 'amqp091',
      code: reply,
      classId: 50,
      methodId: 10,
    });
    expect(mapped.reason).toBe('channel-closed');
  });

  it('a close of the whole connection is a broker error, not a channel one', () => {
    const mapped = mapAmqplibError(
      broker(540, 'Connection closed: 540 (NOT-IMPLEMENTED)'),
      'x',
    );
    expect(mapped.reason).toBe('broker-error');
  });

  it('a refused login is auth-refused / UNAUTHENTICATED', () => {
    const mapped = mapAmqplibError(
      new Error('Handshake terminated by server: 403 (ACCESS-REFUSED)'),
      'connecting',
    );
    expect(mapped).toMatchObject({
      reason: 'auth-refused',
      code: 'UNAUTHENTICATED',
      retryable: false,
    });
  });

  it('socket errors are connect-failed and retryable', () => {
    const mapped = mapAmqplibError(
      Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      }),
      'connecting',
    );
    expect(mapped).toMatchObject({
      reason: 'connect-failed',
      code: 'BROKER_UNREACHABLE',
      retryable: true,
    });
  });

  it('a certificate failure is TLS_UNTRUSTED with the Node code, not retryable', () => {
    const mapped = mapAmqplibError(
      Object.assign(new Error('certificate has expired'), {
        code: 'CERT_HAS_EXPIRED',
      }),
      'connecting',
    );
    expect(mapped).toMatchObject({
      reason: 'tls-untrusted',
      code: 'TLS_UNTRUSTED',
      retryable: false,
      tls: { nodeCode: 'CERT_HAS_EXPIRED' },
    });
  });

  it('an operation on a closed channel is channel-closed', () => {
    const error = Object.assign(new Error('Channel closed'), {
      name: 'IllegalOperationError',
    });
    expect(mapAmqplibError(error, 'x').reason).toBe('channel-closed');
  });

  it('a heartbeat timeout is a lost connection', () => {
    const mapped = mapAmqplibError(new Error('Heartbeat timeout'), 'x');
    expect(mapped).toMatchObject({
      reason: 'connection-closed',
      retryable: true,
    });
  });

  it('anything else is a plain broker error that keeps its cause but not its text', () => {
    const cause = new Error('unexpected');
    const mapped = mapAmqplibError(cause, 'x');
    expect(mapped.reason).toBe('broker-error');
    expect(mapped.cause).toBe(cause);
    expect(mapped.detail).toBe('x failed');
    expect(mapAmqplibError('a string', 'x').reason).toBe('broker-error');
    expect(mapAmqplibError(undefined, 'x').reason).toBe('broker-error');
  });

  it('returns an Amqp091Error unchanged', () => {
    const own = new Amqp091Error('timeout', 'slow');
    expect(mapAmqplibError(own, 'x')).toBe(own);
  });

  it('shortens and cleans the text it takes from the broker', () => {
    const text = `Channel closed by server: 404 (NOT-FOUND) ${'x'.repeat(1000)}\u001b[31m`;
    const mapped = mapAmqplibError(broker(404, text), 'x');
    expect(mapped.broker?.text?.length).toBeLessThan(320);
    expect(safeText('a\u0000b\nc\u007fd')).toBe('a b c d');
  });
});
