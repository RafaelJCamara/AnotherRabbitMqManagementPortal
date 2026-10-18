import { describe, expect, it } from 'vitest';

import { createManualClock } from '../clock/clock.ts';
import { createLogger, withCorrelation, type LogSink } from './logger.ts';
import { REDACTED } from './redact.ts';

/** A sink that keeps the lines, so a test can read exactly what would be written. */
function memorySink(): LogSink & { lines: string[]; text: () => string } {
  const lines: string[] = [];
  return {
    lines,
    write: (line) => {
      lines.push(line);
    },
    text: () => lines.join(''),
  };
}

// Canary secrets of AC-1. None of them may reach the output.
const AMQP_PASSWORD = 'Canary-AmqpPw-91f3';
const BEARER_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjYW5hcnktYmVhcmVyIn0.Q2FuYXJ5QmVhcmVyU2lnbmF0dXJl';
const HEADER_JWT =
  'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJjYW5hcnktaGVhZGVyIiwiYXVkIjoiZW5naW5lIn0.Q2FuYXJ5SGVhZGVyU2lnbmF0dXJl';
const SHOVEL_PASSWORD = 'Canary-ShovelPw-7c2d';
const SHOVEL_URI = `amqps://shovel-user:${SHOVEL_PASSWORD}@remote.example:5671/%2Fprod?heartbeat=30`;

describe('createLogger', () => {
  it('AC-1 writes none of the canary secrets for credentialed URIs, Bearer JWTs, x- header JWTs and shovel URIs', () => {
    const sink = memorySink();
    const logger = createLogger({ sink, level: 'trace' });

    logger.info('dialing amqps://u:p@h');
    logger.info(
      { uri: `amqps://svc:${AMQP_PASSWORD}@broker.example:5671/%2F` },
      `connect to amqps://svc:${AMQP_PASSWORD}@broker.example:5671/%2F`,
    );
    logger.warn(
      { req: { headers: { authorization: `Bearer ${BEARER_JWT}` } } },
      `rejected: Authorization: Bearer ${BEARER_JWT}`,
    );
    logger.warn(
      { headers: { 'x-custom-claims': HEADER_JWT, 'x-request-id': 'r-1' } },
      'headers received',
    );
    logger.info(
      { definition: { 'src-uri': SHOVEL_URI, 'dest-uri': [SHOVEL_URI] } },
      `shovel declared with ${SHOVEL_URI}`,
    );
    logger.error(
      { err: new Error(`handshake with ${SHOVEL_URI} failed`) },
      'shovel failed',
    );

    const output = sink.text();
    expect(sink.lines).toHaveLength(6);
    for (const canary of [
      AMQP_PASSWORD,
      BEARER_JWT,
      HEADER_JWT,
      SHOVEL_PASSWORD,
      'u:p@h',
      'shovel-user',
    ]) {
      expect(output).not.toContain(canary);
    }
    // The useful parts survive: hosts, ports, and the harmless header.
    expect(output).toContain('broker.example:5671');
    expect(output).toContain('remote.example:5671');
    expect(output).toContain('r-1');
    expect(output).toContain(REDACTED);
  });

  it('writes one JSON object per line with level, time, pid and the message', () => {
    const sink = memorySink();
    const clock = createManualClock(1_700_000_000_000);
    const logger = createLogger({
      sink,
      clock,
      bindings: { service: 'kernel-test' },
    });

    logger.info({ queue: 'orders' }, 'queue listed');

    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]?.endsWith('\n')).toBe(true);
    expect(JSON.parse(sink.lines[0] ?? '')).toEqual({
      level: 'info',
      time: 1_700_000_000_000,
      pid: process.pid,
      service: 'kernel-test',
      queue: 'orders',
      msg: 'queue listed',
    });
  });

  it('serialises an error under err with its message and stack', () => {
    const sink = memorySink();
    const logger = createLogger({ sink });
    logger.error({ err: new RangeError('out of range') }, 'failed');
    const line = JSON.parse(sink.text()) as {
      err: { type: string; message: string; stack: string };
    };
    expect(line.err.type).toBe('RangeError');
    expect(line.err.message).toBe('out of range');
    expect(line.err.stack).toContain('out of range');
  });

  it('never logs a message body or payload', () => {
    const sink = memorySink();
    const logger = createLogger({ sink });
    logger.info(
      { body: 'canary-message-body', payload: { text: 'canary-payload' } },
      'peeked',
    );
    expect(sink.text()).not.toContain('canary');
  });

  it('masks credential fields at any depth and in bindings', () => {
    const sink = memorySink();
    const logger = createLogger({
      sink,
      bindings: { token: 'canary-bound-token' },
    });
    logger.info(
      { a: { b: { password: 'canary-pw', cookie: 'sid=canary-cookie' } } },
      'nested',
    );
    expect(sink.text()).not.toContain('canary');
  });

  it('respects the level', () => {
    const sink = memorySink();
    const logger = createLogger({ sink, level: 'warn' });
    logger.debug('quiet');
    logger.info('quiet');
    logger.warn('loud');
    expect(sink.lines).toHaveLength(1);
    expect(logger.level).toBe('warn');
    expect(logger.isLevelEnabled('info')).toBe(false);
    expect(logger.isLevelEnabled('error')).toBe(true);
  });

  it('does not treat % in a message as a format string', () => {
    const sink = memorySink();
    createLogger({ sink }).info('disk at 100% %s');
    expect((JSON.parse(sink.text()) as { msg: string }).msg).toBe(
      'disk at 100% %s',
    );
  });

  it('stamps correlation ids on every line of a child logger and redacts there too', () => {
    const sink = memorySink();
    const logger = withCorrelation(createLogger({ sink }), {
      requestId: 'req-1',
      planId: 'plan-1',
    });
    logger.child({ jobId: 'job-1' }).info('with ids amqp://u:canary-pw@h');
    const line = JSON.parse(sink.text()) as Record<string, string>;
    expect(line).toMatchObject({
      requestId: 'req-1',
      planId: 'plan-1',
      jobId: 'job-1',
    });
    expect(sink.text()).not.toContain('canary-pw');
  });

  it('writes nothing when silent', () => {
    const sink = memorySink();
    createLogger({ sink, level: 'silent' }).fatal('nothing');
    expect(sink.lines).toEqual([]);
  });
});
