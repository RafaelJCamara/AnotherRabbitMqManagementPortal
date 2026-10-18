import { TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createTestPki,
  startTestTlsServer,
  type TestTlsServer,
} from '@app/net-truststore/testing';
import {
  NetworkError,
  toProfileTls,
  type CertDiagnostics,
} from '@app/net-truststore';

import { createDialer, type DialResult } from './dialer.ts';
import type { EgressPolicy, EgressRequest, Resolver } from './policy-hook.ts';
import {
  emptyTrustStore,
  readAll,
  startPlainServer,
  type PlainServer,
} from './test-support.ts';

const DIRECT = { kind: 'direct' } as const;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function plain(
  onConnection?: Parameters<typeof startPlainServer>[0],
): Promise<PlainServer> {
  const server = await startPlainServer(onConnection);
  closers.push(() => server.close());
  return server;
}

async function secured(
  pki: ReturnType<typeof createTestPki>,
  options: Parameters<ReturnType<typeof createTestPki>['issueServer']>[0] = {},
): Promise<TestTlsServer> {
  const { leaf, chainPem } = pki.issueServer(options);
  const server = await startTestTlsServer({
    certPem: chainPem,
    keyPem: leaf.keyPem,
  });
  closers.push(() => server.close());
  return server;
}

const target = (port: number, extra = {}) => ({
  host: '127.0.0.1',
  port,
  purpose: 'test',
  ...extra,
});

function requireTls(result: DialResult): CertDiagnostics {
  if (result.tls === undefined)
    throw new Error('the result has no TLS outcome');
  return result.tls;
}

async function rejection(promise: Promise<unknown>): Promise<NetworkError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(NetworkError);
    return error as NetworkError;
  }
  throw new Error('expected the promise to reject');
}

describe('direct TCP', () => {
  it('connects to an IP and carries bytes both ways', async () => {
    const server = await plain();
    const socket = await createDialer().connect(target(server.port), DIRECT);

    socket.write('ping');
    const echoed = await readAll(socket, 4);
    socket.destroy();

    expect(echoed).toBe('ping');
  });

  it('resolves a host name with the system resolver and connects to what it found', async () => {
    const server = await plain();
    // "localhost" may resolve to ::1 first; the server listens on 127.0.0.1 only.
    const socket = await createDialer().connect(
      { host: 'localhost', port: server.port, purpose: 'test' },
      DIRECT,
    );
    socket.destroy();

    expect(server.accepted()).toBe(1);
  });

  it('reports a refused connection as BROKER_UNREACHABLE, retryable', async () => {
    const server = await plain();
    const port = server.port;
    await server.close();

    const error = await rejection(createDialer().connect(target(port), DIRECT));

    expect(error.code).toBe('BROKER_UNREACHABLE');
    expect(error.retryable).toBe(true);
    expect(error.detail).toContain(`127.0.0.1:${String(port)}`);
  });

  it('reports a name that does not resolve as BROKER_UNREACHABLE', async () => {
    const resolver: Resolver = () => Promise.reject(new Error('ENOTFOUND'));

    const error = await rejection(
      createDialer({ resolver }).connect(
        { host: 'nowhere.test', port: 5672, purpose: 'test' },
        DIRECT,
      ),
    );

    expect(error.code).toBe('BROKER_UNREACHABLE');
    expect(error.detail).toContain('nowhere.test');
  });

  it('bounds a resolver that never answers by the connect timeout', async () => {
    const resolver: Resolver = () => new Promise(() => undefined);

    const error = await rejection(
      createDialer({ resolver, connectTimeoutMs: 100 }).connect(
        { host: 'slow.test', port: 5672, purpose: 'test' },
        DIRECT,
      ),
    );

    expect(error.code).toBe('BROKER_UNREACHABLE');
    expect(error.detail).toContain('timed out after 100 ms');
  });

  it('bounds a policy that never answers, and check() gives up on both', async () => {
    const hanging: EgressPolicy = {
      evaluate: () => new Promise(() => undefined),
    };
    const slowResolver: Resolver = () => new Promise(() => undefined);
    const dialer = createDialer({ policy: hanging, connectTimeoutMs: 100 });

    const error = await rejection(dialer.connect(target(5672), DIRECT));
    const checked = await dialer.check({
      host: '127.0.0.1',
      port: 5672,
      purpose: 'test',
    });
    const unresolved = await createDialer({
      resolver: slowResolver,
      connectTimeoutMs: 100,
    }).check({ host: 'slow.test', port: 5672, purpose: 'test' });

    expect(error.detail).toContain('timed out after 100 ms');
    expect(checked.allowed).toBe(false);
    expect(unresolved.allowed).toBe(false);
  });

  it('gives up after the connect timeout', async () => {
    // A listener that never completes the TLS handshake keeps the dialer waiting.
    const silent = await plain(() => undefined);
    const store = emptyTrustStore();

    const error = await rejection(
      createDialer({ connectTimeoutMs: 150 }).connect(
        target(silent.port, { tls: store.forProfile() }),
        DIRECT,
      ),
    );

    expect(error.code).toBe('BROKER_UNREACHABLE');
    expect(error.retryable).toBe(true);
    expect(error.detail).toContain('timed out after 150 ms');
  });

  it('rejects with the caller’s own reason when the caller aborts', async () => {
    const silent = await plain(() => undefined);
    const controller = new AbortController();
    const pending = createDialer().connect(
      target(silent.port, { tls: emptyTrustStore().forProfile() }),
      DIRECT,
      controller.signal,
    );
    controller.abort(new Error('user cancelled'));

    await expect(pending).rejects.toThrow('user cancelled');
  });

  it('does not open anything when the signal is already aborted', async () => {
    const server = await plain();

    await expect(
      createDialer().connect(
        target(server.port),
        DIRECT,
        AbortSignal.abort(new Error('gone')),
      ),
    ).rejects.toThrow('gone');
    expect(server.accepted()).toBe(0);
  });
});

describe('route and input validation', () => {
  it.each([
    ['no route', undefined],
    ['a SOCKS5 route', { kind: 'socks5' }],
    ['an SSH route', { kind: 'ssh2' }],
    ['a non-object', 'direct'],
  ])('refuses %s: only "direct" exists until M1-22', async (_label, route) => {
    const server = await plain();

    const error = await rejection(
      createDialer().connect(target(server.port), route),
    );

    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.detail).toContain('M1-22');
    expect(server.accepted()).toBe(0);
  });

  it.each([
    ['an empty host', { host: '' }],
    ['a host with a path', { host: 'a.test/x' }],
    ['a host with credentials', { host: 'user@a.test' }],
    ['a host with a space', { host: 'a b' }],
    ['a host:port pair', { host: 'broker.test:5672' }],
    ['a host with a control character', { host: 'a\nb' }],
    ['port 0', { port: 0 }],
    ['port 65536', { port: 65536 }],
    ['a fractional port', { port: 80.5 }],
    ['an empty purpose', { purpose: '' }],
    ['a purpose with spaces', { purpose: 'not ok' }],
  ])('refuses %s', async (_label, patch) => {
    const error = await rejection(
      createDialer().connect({ ...target(5672), ...patch }, DIRECT),
    );

    expect(error.code).toBe('VALIDATION_FAILED');
  });

  it('accepts a bracketed IPv6 literal', async () => {
    const seen: EgressRequest[] = [];
    const policy: EgressPolicy = {
      evaluate: (request) => {
        seen.push(request);
        return { allowed: false, reason: 'stop here' };
      },
    };

    await rejection(
      createDialer({ policy }).connect(
        { host: '[::1]', port: 5672, purpose: 'test' },
        DIRECT,
      ),
    );

    expect(seen[0]?.host).toBe('::1');
    expect(seen[0]?.addresses).toEqual(['::1']);
  });
});

describe('egress policy hook (DC-43)', () => {
  const denyAll = (reason: string): EgressPolicy => ({
    evaluate: () => ({ allowed: false, reason }),
  });

  it('is asked about an IP literal before any socket opens', async () => {
    const server = await plain();

    const error = await rejection(
      createDialer({ policy: denyAll('loopback is not allowed') }).connect(
        target(server.port),
        DIRECT,
      ),
    );

    expect(error.code).toBe('EGRESS_DENIED');
    expect(error.detail).toContain('loopback is not allowed');
    expect(server.accepted()).toBe(0);
  });

  it('is asked about every address a name resolved to, with host, port and purpose', async () => {
    const seen: EgressRequest[] = [];
    const resolver: Resolver = () =>
      Promise.resolve([
        { address: '10.0.0.5', family: 4 },
        { address: 'fd00::5', family: 6 },
      ]);

    await rejection(
      createDialer({
        resolver,
        policy: {
          evaluate: (request) => {
            seen.push(request);
            return { allowed: false, reason: 'no' };
          },
        },
      }).connect(
        { host: 'broker.corp.test', port: 5671, purpose: 'amqp' },
        DIRECT,
      ),
    );

    expect(seen).toEqual([
      {
        host: 'broker.corp.test',
        port: 5671,
        purpose: 'amqp',
        addresses: ['10.0.0.5', 'fd00::5'],
      },
    ]);
  });

  it('refuses a name that resolves to a denied address without connecting', async () => {
    const server = await plain();
    const resolver: Resolver = () =>
      Promise.resolve([{ address: '169.254.169.254', family: 4 }]);
    const policy: EgressPolicy = {
      evaluate: ({ addresses }) =>
        addresses.includes('169.254.169.254')
          ? { allowed: false, reason: 'metadata address' }
          : { allowed: true },
    };

    const error = await rejection(
      createDialer({ resolver, policy }).connect(
        { host: 'metadata.evil.test', port: server.port, purpose: 'test' },
        DIRECT,
      ),
    );

    expect(error.code).toBe('EGRESS_DENIED');
    expect(error.detail).toContain('metadata address');
  });

  it('connects to the very addresses the policy approved: no second lookup to rebind', async () => {
    const server = await plain();
    let lookups = 0;
    // First answer: allowed loopback. Any later answer: the metadata service.
    const resolver: Resolver = () => {
      lookups += 1;
      return Promise.resolve([
        lookups === 1
          ? { address: '127.0.0.1', family: 4 as const }
          : { address: '169.254.169.254', family: 4 as const },
      ]);
    };
    const approved: string[][] = [];
    const policy: EgressPolicy = {
      evaluate: ({ addresses }) => {
        approved.push([...addresses]);
        return addresses.every((address) => address === '127.0.0.1')
          ? { allowed: true }
          : { allowed: false, reason: 'rebound' };
      },
    };

    const socket = await createDialer({ resolver, policy }).connect(
      { host: 'rebind.test', port: server.port, purpose: 'test' },
      DIRECT,
    );
    socket.destroy();

    expect(lookups).toBe(1);
    expect(approved).toEqual([['127.0.0.1']]);
    expect(server.accepted()).toBe(1);
  });

  it('fails closed when the policy throws or answers something that is not an allow', async () => {
    const server = await plain();
    const policies: EgressPolicy[] = [
      {
        evaluate: () => {
          throw new Error('policy store unavailable');
        },
      },
      { evaluate: () => Promise.reject(new Error('timeout')) },
      { evaluate: () => ({}) as never },
      { evaluate: () => undefined as never },
      { evaluate: () => ({ allowed: 'yes' }) as never },
    ];

    for (const policy of policies) {
      const error = await rejection(
        createDialer({ policy }).connect(target(server.port), DIRECT),
      );
      expect(error.code).toBe('EGRESS_DENIED');
    }
    expect(server.accepted()).toBe(0);
  });

  it('check() resolves and evaluates without connecting', async () => {
    const server = await plain();
    const resolver: Resolver = () =>
      Promise.resolve([
        { address: '127.0.0.1', family: 4 },
        { address: '::1', family: 6 },
      ]);

    const allowed = await createDialer({ resolver }).check({
      host: 'broker.test',
      port: server.port,
      purpose: 'test',
    });
    const denied = await createDialer({
      resolver,
      policy: denyAll('private range'),
    }).check({ host: 'broker.test', port: server.port, purpose: 'test' });

    expect(allowed).toEqual({ allowed: true, resolved: ['127.0.0.1', '::1'] });
    expect(denied).toEqual({
      allowed: false,
      reason: 'private range',
      resolved: ['127.0.0.1', '::1'],
    });
    expect(server.accepted()).toBe(0);
  });

  it('check() answers "not allowed" for a name that does not resolve, and rejects bad input', async () => {
    const resolver: Resolver = () => Promise.reject(new Error('ENOTFOUND'));
    const dialer = createDialer({ resolver });

    const result = await dialer.check({
      host: 'nowhere.test',
      port: 5672,
      purpose: 'test',
    });

    expect(result.allowed).toBe(false);
    expect(result.resolved).toEqual([]);
    await expect(
      dialer.check({ host: '', port: 5672, purpose: 'test' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('TLS through the Dialer', () => {
  it('verifies against a profile CA, by IP with a servername override, and reports the handshake', async () => {
    const pki = createTestPki('Lab Root');
    const server = await secured(pki, {
      dnsNames: ['broker.lab.test'],
      ipAddresses: [],
    });
    const trust = emptyTrustStore().forProfile({
      ca: [pki.root.pem],
      servername: 'broker.lab.test',
    });

    const result = await createDialer().dial(
      target(server.port, { tls: trust }),
      DIRECT,
    );
    result.socket.write('GET / HTTP/1.1\r\n\r\n');
    const reply = await readAll(result.socket);

    expect(result.socket).toBeInstanceOf(TLSSocket);
    expect(reply).toContain('200 OK');
    expect(result.tls?.verified).toBe(true);
    expect(result.tls?.sni).toBe('broker.lab.test');
    expect(toProfileTls(requireTls(result))).toEqual({
      verified: true,
      notAfter: result.tls?.chain[0]?.validTo,
      insecureOverride: false,
    });
  });

  it('connect() hands back the secured socket', async () => {
    const pki = createTestPki();
    const server = await secured(pki);
    const trust = emptyTrustStore().forProfile({ ca: [pki.root.pem] });

    const socket = await createDialer().connect(
      target(server.port, { tls: trust }),
      DIRECT,
    );
    socket.destroy();

    expect(socket).toBeInstanceOf(TLSSocket);
    expect((socket as TLSSocket).authorized).toBe(true);
  });

  it('refuses an untrusted server with TLS_UNTRUSTED and leaves no connection behind', async () => {
    const server = await secured(createTestPki());
    const trust = emptyTrustStore().forProfile();

    const error = await rejection(
      createDialer().connect(
        target(server.port, { tls: trust, servername: 'localhost' }),
        DIRECT,
      ),
    );

    expect(error.code).toBe('TLS_UNTRUSTED');
    expect(error.tls?.verifiedName).toBe('localhost');
  });

  it('refuses a name mismatch even when the CA is trusted', async () => {
    const pki = createTestPki();
    const server = await secured(pki, {
      dnsNames: ['a.test'],
      ipAddresses: [],
    });
    const trust = emptyTrustStore().forProfile({ ca: [pki.root.pem] });

    const error = await rejection(
      createDialer().connect(
        target(server.port, { tls: trust, servername: 'b.test' }),
        DIRECT,
      ),
    );

    expect(error.code).toBe('TLS_UNTRUSTED');
    expect(error.tls?.nodeCode).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
  });

  it('refuses an expired certificate', async () => {
    const pki = createTestPki();
    const server = await secured(pki, {
      notBefore: new Date(Date.now() - 5 * 86_400_000),
      notAfter: new Date(Date.now() - 86_400_000),
    });
    const trust = emptyTrustStore().forProfile({ ca: [pki.root.pem] });

    const error = await rejection(
      createDialer().connect(target(server.port, { tls: trust }), DIRECT),
    );

    expect(error.code).toBe('TLS_UNTRUSTED');
    expect(error.tls?.nodeCode).toBe('CERT_HAS_EXPIRED');
  });

  it('with insecure=true connects, records the override and warns once, without secrets', async () => {
    const server = await secured(createTestPki(), {
      dnsNames: ['other.test'],
      ipAddresses: [],
    });
    const warn = vi.fn();
    const trust = emptyTrustStore().forProfile({ insecure: true });

    const result = await createDialer({ log: { warn } }).dial(
      target(server.port, { tls: trust, servername: 'broker.lab.test' }),
      DIRECT,
    );
    result.socket.destroy();

    expect(result.tls?.insecureOverride).toBe(true);
    expect(result.tls?.verified).toBe(false);
    expect(toProfileTls(requireTls(result)).insecureOverride).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(message).toContain('verification is switched off');
    expect(fields).toMatchObject({
      host: '127.0.0.1',
      port: server.port,
      purpose: 'test',
      verified: false,
    });
    expect(JSON.stringify(fields)).not.toMatch(/BEGIN|PRIVATE/);
  });

  it('keeps the connection when the logger throws', async () => {
    const server = await secured(createTestPki());
    const log = {
      warn: () => {
        throw new Error('log sink closed');
      },
    };

    const result = await createDialer({ log }).dial(
      target(server.port, {
        tls: emptyTrustStore().forProfile({ insecure: true }),
      }),
      DIRECT,
    );
    result.socket.destroy();

    expect(result.tls?.insecureOverride).toBe(true);
  });

  it('does not warn for a verifying connection', async () => {
    const pki = createTestPki();
    const server = await secured(pki);
    const warn = vi.fn();

    const result = await createDialer({ log: { warn } }).dial(
      target(server.port, {
        tls: emptyTrustStore().forProfile({ ca: [pki.root.pem] }),
      }),
      DIRECT,
    );
    result.socket.destroy();

    expect(warn).not.toHaveBeenCalled();
  });

  it('applies the egress policy before the TLS handshake', async () => {
    const server = await secured(createTestPki());

    const error = await rejection(
      createDialer({
        policy: { evaluate: () => ({ allowed: false, reason: 'no' }) },
      }).connect(
        target(server.port, {
          tls: emptyTrustStore().forProfile({ insecure: true }),
        }),
        DIRECT,
      ),
    );

    expect(error.code).toBe('EGRESS_DENIED');
    expect(server.accepted()).toBe(0);
  });
});
