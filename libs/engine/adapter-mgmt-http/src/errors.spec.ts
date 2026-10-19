import { describe, expect, it } from 'vitest';

import { NetworkError } from '@app/net-truststore';

import {
  MgmtHttpError,
  brokerText,
  errorForNetwork,
  errorForStatus,
  safeText,
} from './errors.ts';

const reason = (text: string): string => JSON.stringify({ reason: text });

describe('status-to-code map', () => {
  const table: readonly [number, string, string, boolean][] = [
    [401, reason('Login failed'), 'UNAUTHENTICATED', false],
    [401, reason('Not administrator user'), 'FORBIDDEN_BROKER', false],
    [401, reason('Access token has expired'), 'TOKEN_EXPIRED', false],
    [
      403,
      reason('User can only log in via localhost'),
      'FORBIDDEN_BROKER',
      false,
    ],
    [
      404,
      '{"error":"Object Not Found","reason":"Not Found"}',
      'NOT_FOUND',
      false,
    ],
    [400, reason('bad vhost'), 'VALIDATION_FAILED', false],
    [409, reason('x'), 'BROKER_PRECONDITION_FAILED', false],
    [423, reason('x'), 'BROKER_RESOURCE_LOCKED', false],
    [429, '', 'RATE_LIMITED', true],
    [503, reason('health check failed'), 'BROKER_UNREACHABLE', true],
    [502, '<html>Bad Gateway</html>', 'BROKER_UNREACHABLE', true],
    [504, '', 'BROKER_UNREACHABLE', true],
    [500, reason('boom'), 'BROKER_ERROR', false],
    [302, '', 'BROKER_ERROR', false],
  ];

  it.each(table)(
    'maps %i %s to %s (retryable %s)',
    (status, body, code, retry) => {
      const error = errorForStatus(status, body, 'GET /api/x');

      expect(error.code).toBe(code);
      expect(error.retryable).toBe(retry);
      expect(error.broker).toMatchObject({ protocol: 'http', code: status });
    },
  );

  it('keeps a plain 405 apart from a provider restriction', () => {
    const plain = errorForStatus(405, reason('Method not allowed'), 'POST /x');
    const provider = errorForStatus(
      405,
      reason('Broker settings disallow quorum queue replica operations.'),
      'POST /x',
    );

    expect(plain.code).toBe('BROKER_ERROR');
    expect(plain.gate).toBeUndefined();
    expect(provider.code).toBe('FORBIDDEN_BROKER');
    expect(provider.gate?.enabled).toBe(false);
  });

  it('shows the 503 reason of a failing health check', () => {
    const error = errorForStatus(
      503,
      '{"status":"failed","reason":"There are alarms in effect"}',
      'GET /api/health/checks/alarms',
    );

    expect(error.broker?.text).toBe('There are alarms in effect');
  });
});

describe('text from the network', () => {
  it('strips control characters and bounds the length', () => {
    expect(safeText('a\u0000b\nc\u007fd')).toBe('a b c d');
    expect(safeText('x'.repeat(1_000)).length).toBeLessThan(310);
    expect(brokerText('   ')).toBe('');
    expect(brokerText('<html>\nproxy error</html>')).toBe(
      '<html> proxy error</html>',
    );
  });
});

describe('network failures', () => {
  it('keeps the code of an egress or TLS refusal', () => {
    const denied = errorForNetwork(
      new NetworkError('EGRESS_DENIED', 'broker.test:15672 is not allowed'),
      'GET /api/x',
    );
    const untrusted = errorForNetwork(
      new NetworkError('TLS_UNTRUSTED', 'the certificate was refused', {
        tls: { nodeCode: 'CERT_HAS_EXPIRED', verifiedName: 'broker.test' },
      }),
      'GET /api/x',
    );

    expect(denied.code).toBe('EGRESS_DENIED');
    expect(denied.retryable).toBe(false);
    expect(untrusted.code).toBe('TLS_UNTRUSTED');
    expect(untrusted.tls?.nodeCode).toBe('CERT_HAS_EXPIRED');
  });

  it('names a socket error by its code only, never by its message', () => {
    const error = errorForNetwork(
      Object.assign(new Error('connect ECONNREFUSED http://u:secret@h/'), {
        code: 'ECONNREFUSED',
      }),
      'GET /api/x',
    );

    expect(error.code).toBe('BROKER_UNREACHABLE');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('ECONNREFUSED');
    expect(error.message).not.toContain('secret');
    expect(errorForNetwork(error, 'again')).toBe(error);
    expect(error).toBeInstanceOf(MgmtHttpError);
  });
});
