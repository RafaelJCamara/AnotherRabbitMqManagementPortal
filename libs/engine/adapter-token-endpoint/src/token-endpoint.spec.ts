// M1-23 slice B: the token endpoint client (AC-8). Real loopback servers (plain and TLS) behind the
// real Dialer, so what the wire carries is what is asserted.
import { readFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

import {
  createDialer,
  isRegisteredPurpose,
  PURPOSES,
  type Dialer,
  type DialerOptions,
} from '@app/net-dialer';
import { createTrustStore, type TlsTrust } from '@app/net-truststore';
import { createTestPki, startTestTlsServer } from '@app/net-truststore/testing';
import type { TokenRequest, TokenResponse } from '@app/ports';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createTokenEndpoint,
  MAX_RESPONSE_BYTES,
  parseTokenResponse,
} from './token-endpoint';

const SECRET = 'CANARY-client-secret-Zk4pQ8wN2m';
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzdmMifQ.c2ln';
const OK_BODY = JSON.stringify({
  access_token: TOKEN,
  token_type: 'Bearer',
  expires_in: 300,
});
const signal = new AbortController().signal;

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

type Responder = (seen: Seen, res: ServerResponse) => void;

const json =
  (body: string, status = 200, type = 'application/json'): Responder =>
  (_seen, res) => {
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  };

/** A plain HTTP issuer on 127.0.0.1 that records every request. */
async function startIssuer(responder: Responder = json(OK_BODY)) {
  const requests: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const seen: Seen = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(seen);
      responder(seen, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  );
  const port = (server.address() as { port: number }).port;
  return {
    port,
    requests,
    url: `http://127.0.0.1:${String(port)}/oauth/token`,
  };
}

function trust(ca?: string): TlsTrust {
  const store = createTrustStore({
    runtime: {
      getCACertificates: () => [],
      setDefaultCACertificates: () => undefined,
    },
  });
  return store.forProfile(ca === undefined ? {} : { ca: [ca] });
}

/** The real Dialer, with the purpose registry on, and a record of what was dialled. */
function spied(options: DialerOptions = {}) {
  const real = createDialer({ purposes: isRegisteredPurpose, ...options });
  const dialed: {
    host: string;
    port: number;
    purpose: string;
    tls: boolean;
  }[] = [];
  return {
    dialed,
    dialer: {
      dial: (...args: Parameters<typeof real.dial>) => {
        const [target] = args;
        dialed.push({
          host: target.host,
          port: target.port,
          purpose: target.purpose,
          tls: target.tls !== undefined,
        });
        return real.dial(...args);
      },
    },
  };
}

const request = (endpoint: string, extra: Partial<TokenRequest> = {}) => ({
  endpoint,
  clientId: 'svc client',
  clientSecret: SECRET,
  ...extra,
});

/** Reads one whole HTTP request from a TLS socket (headers, then content-length bytes). */
function requestOf(onRequest: (text: string) => void) {
  let received = '';
  return (chunk: Buffer): boolean => {
    received += chunk.toString('utf8');
    const end = received.indexOf('\r\n\r\n');
    if (end < 0) return false;
    const length = Number(/content-length: (\d+)/i.exec(received)?.[1] ?? 0);
    if (received.length - end - 4 < length) return false;
    onRequest(received);
    return true;
  };
}

describe('token endpoint adapter', () => {
  it('M1-23 AC-8 token endpoint adapter dials only through the Dialer with purpose oidc and bounds the body', async () => {
    // An https issuer: the socket is the Dialer's, verified with the profile trust.
    const pki = createTestPki('Issuer Root');
    const { leaf, chainPem } = pki.issueServer();
    let wire = '';
    const tlsServer = await startTestTlsServer({
      certPem: chainPem,
      keyPem: leaf.keyPem,
      onConnection: (socket) => {
        const read = requestOf((text) => {
          wire = text;
          socket.end(
            `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${String(OK_BODY.length)}\r\nconnection: close\r\n\r\n${OK_BODY}`,
          );
        });
        socket.on('data', read);
      },
    });
    closers.push(() => tlsServer.close());
    const secure = spied();
    const adapter = createTokenEndpoint({
      dialer: secure.dialer,
      trust: trust(pki.root.pem),
    });
    const tlsUrl = `https://127.0.0.1:${String(tlsServer.port)}/oauth/token?tenant=a`;

    const issued = await adapter.requestToken(
      request(tlsUrl, { scope: 'rabbitmq.read', audience: 'rabbitmq' }),
      signal,
    );

    expect(issued).toEqual({
      ok: true,
      accessToken: TOKEN,
      expiresInSeconds: 300,
      tokenType: 'Bearer',
    });
    expect(secure.dialed).toEqual([
      { host: '127.0.0.1', port: tlsServer.port, purpose: 'oidc', tls: true },
    ]);
    // RFC 6749 4.4 on the wire: the secret only in the Authorization field, form-encoded.
    const [head = '', body = ''] = wire.split('\r\n\r\n');
    expect(head).toContain('POST /oauth/token?tenant=a HTTP/1.1');
    expect(head.toLowerCase()).toContain(
      'content-type: application/x-www-form-urlencoded',
    );
    expect(head).toContain(
      `Basic ${Buffer.from(`svc+client:${SECRET}`).toString('base64')}`,
    );
    expect(body).toBe(
      'grant_type=client_credentials&scope=rabbitmq.read&audience=rabbitmq',
    );
    expect(head.split('\r\n')[0]).not.toContain(SECRET);
    expect(body).not.toContain(SECRET);

    // An egress denial: nothing connects.
    const issuer = await startIssuer();
    const denied = spied({
      policy: { evaluate: () => ({ allowed: false, reason: 'no egress' }) },
    });
    const refusedByPolicy = await createTokenEndpoint({
      dialer: denied.dialer,
      trust: trust(),
    }).requestToken(request(issuer.url), signal);
    expect(refusedByPolicy).toEqual({ ok: false, reason: 'egress-denied' });
    expect(denied.dialed.map((each) => each.purpose)).toEqual(['oidc']);
    expect(issuer.requests).toHaveLength(0);

    // A certificate the trust does not accept, and plain http beyond loopback: no request is made.
    const untrusted = await createTokenEndpoint({
      dialer: spied().dialer,
      trust: trust(),
    }).requestToken(request(tlsUrl), signal);
    expect(untrusted).toEqual({ ok: false, reason: 'tls-untrusted' });
    const remote = spied();
    expect(
      await createTokenEndpoint({
        dialer: remote.dialer,
        trust: trust(),
      }).requestToken(request('http://issuer.example.test/token'), signal),
    ).toEqual({ ok: false, reason: 'egress-denied' });
    expect(remote.dialed).toEqual([]);

    // The body is read up to 64 KiB: exactly the cap parses, one byte more is too large.
    const padded = (size: number): string =>
      OK_BODY + ' '.repeat(size - OK_BODY.length);
    for (const [size, expected] of [
      [MAX_RESPONSE_BYTES, 'ok'],
      [MAX_RESPONSE_BYTES + 1, 'too-large'],
    ] as const) {
      const big = await startIssuer(json(padded(size)));
      const outcome = await createTokenEndpoint({
        dialer: spied().dialer,
        trust: trust(),
      }).requestToken(request(big.url), signal);
      expect(outcome.ok ? 'ok' : outcome.reason, String(size)).toBe(expected);
    }
    // Chunked, with no length declared: the cap is counted while reading.
    const endless = await startIssuer((_seen, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(`{"x":"${'a'.repeat(MAX_RESPONSE_BYTES)}`);
      res.write('b'.repeat(10));
    });
    expect(
      await createTokenEndpoint({
        dialer: spied().dialer,
        trust: trust(),
      }).requestToken(request(endless.url), signal),
    ).toEqual({ ok: false, reason: 'too-large' });

    // The registry and its generated page: the purpose is built, not only registered.
    expect(PURPOSES.find((purpose) => purpose.id === 'oidc')?.status).toBe(
      'active',
    );
    const page = readFileSync(
      fileURLToPath(
        new URL(
          '../../../../apps/docs/src/content/docs/security/outbound-calls.md',
          import.meta.url,
        ),
      ),
      'utf8',
    );
    const row = page.split('\n').find((line) => line.startsWith('| `oidc` |'));
    expect(row).toMatch(/\| Built \|$/);
  });
});

describe('token endpoint adapter strength', () => {
  const ask = async (
    responder: Responder,
    extra: Partial<TokenRequest> = {},
    timeoutMs?: number,
  ): Promise<TokenResponse> => {
    const issuer = await startIssuer(responder);
    return createTokenEndpoint({
      dialer: spied().dialer,
      trust: trust(),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }).requestToken(request(issuer.url, extra), signal);
  };

  it('M1-23 strength an answer maps to one fixed reason and its body is never copied', async () => {
    const BODY = 'ECHO-BODY-must-not-appear-9f2';
    const cases: [number, string][] = [
      [400, 'refused'],
      [401, 'refused'],
      [403, 'refused'],
      [404, 'refused'],
      [408, 'timeout'],
      [429, 'unreachable'],
      [500, 'unreachable'],
      [503, 'unreachable'],
      [504, 'timeout'],
      [302, 'malformed'],
    ];
    for (const [status, reason] of cases) {
      const seenAfterRedirect = await startIssuer();
      const outcome = await ask((_seen, res) => {
        res.writeHead(status, {
          'content-type': 'application/json',
          location: seenAfterRedirect.url,
        });
        res.end(JSON.stringify({ error: BODY, secret: SECRET }));
      });
      expect(outcome, String(status)).toEqual({ ok: false, reason });
      expect(JSON.stringify(outcome)).not.toContain(BODY);
      // A redirect is never followed.
      expect(seenAfterRedirect.requests).toHaveLength(0);
    }
  });

  it('M1-23 strength the answer is read with a strict schema', () => {
    const body = (value: unknown): Uint8Array =>
      Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    const good = { access_token: TOKEN, token_type: 'Bearer' };
    expect(parseTokenResponse(body(good))).toEqual({
      ok: true,
      accessToken: TOKEN,
      expiresInSeconds: null,
      tokenType: 'Bearer',
    });
    expect(
      parseTokenResponse(body({ ...good, expires_in: '300', extra: 1 })),
    ).toMatchObject({ ok: true, expiresInSeconds: 300 });
    const rejected: unknown[] = [
      [],
      'null',
      '[1]',
      '{',
      { token_type: 'Bearer' },
      { ...good, access_token: '' },
      { ...good, access_token: 5 },
      { ...good, access_token: 'a b' },
      { ...good, access_token: 'a\r\nx: y' },
      { ...good, access_token: 'a'.repeat(65_537) },
      { access_token: TOKEN },
      { ...good, token_type: 'Bear er' },
      { ...good, expires_in: 0 },
      { ...good, expires_in: -1 },
      { ...good, expires_in: 'soon' },
      { ...good, expires_in: '1e999' },
      { ...good, expires_in: true },
    ];
    for (const each of rejected) {
      expect(parseTokenResponse(body(each)), JSON.stringify(each)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
    expect(parseTokenResponse(Uint8Array.from([0x7b, 0xff, 0x7d]))).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('M1-23 strength the request keeps the secret out of the URL and refuses a login or a scheme', async () => {
    const issuer = await startIssuer();
    const adapter = createTokenEndpoint({
      dialer: spied().dialer,
      trust: trust(),
    });
    await adapter.requestToken(request(issuer.url), signal);
    expect(issuer.requests).toHaveLength(1);
    const [seen] = issuer.requests;
    expect(seen?.method).toBe('POST');
    expect(seen?.url).toBe('/oauth/token');
    expect(seen?.body).toBe('grant_type=client_credentials');
    expect(seen?.headers['accept-encoding']).toBe('identity');
    expect(String(seen?.headers.authorization)).toBe(
      `Basic ${Buffer.from(`svc+client:${SECRET}`).toString('base64')}`,
    );
    // RFC 6749 2.3.1: characters outside the unreserved set are percent-encoded before base64.
    const odd = await startIssuer();
    await adapter.requestToken(
      request(odd.url, { clientId: 'a:b', clientSecret: "p'w d~" }),
      signal,
    );
    expect(
      Buffer.from(
        String(odd.requests[0]?.headers.authorization).slice(6),
        'base64',
      ).toString(),
    ).toBe('a%3Ab:p%27w+d%7E');

    const before = issuer.requests.length;
    for (const endpoint of [
      `http://user:${SECRET}@127.0.0.1:${String(issuer.port)}/t`,
      'ftp://127.0.0.1/t',
      'not a url',
      'http://',
    ]) {
      expect(
        await adapter.requestToken(request(endpoint), signal),
        endpoint,
      ).toEqual({ ok: false, reason: 'malformed' });
    }
    expect(
      await adapter.requestToken(request(issuer.url, { clientId: '' }), signal),
    ).toEqual({ ok: false, reason: 'malformed' });
    expect(issuer.requests).toHaveLength(before);
  });

  it('M1-23 strength a silent issuer ends in timeout and an aborted request in unreachable, with nothing left open', async () => {
    const silent = await startIssuer(() => undefined);
    const adapter = createTokenEndpoint({
      dialer: spied().dialer,
      trust: trust(),
      timeoutMs: 80,
    });
    expect(await adapter.requestToken(request(silent.url), signal)).toEqual({
      ok: false,
      reason: 'timeout',
    });
    const control = new AbortController();
    const pending = adapter.requestToken(request(silent.url), control.signal);
    setTimeout(() => {
      control.abort();
    }, 10);
    expect(await pending).toEqual({ ok: false, reason: 'unreachable' });
    expect(
      await adapter.requestToken(request(silent.url), AbortSignal.abort()),
    ).toEqual({ ok: false, reason: 'unreachable' });
    // An issuer that is not listening, and a body that is not JSON.
    const closed = await startIssuer();
    const dead = closed.url;
    await closers.pop()?.();
    expect(await adapter.requestToken(request(dead), signal)).toEqual({
      ok: false,
      reason: 'unreachable',
    });
    // A valid body under the wrong media type is not a token response.
    expect(await ask(json(OK_BODY, 200, 'text/html'))).toEqual({
      ok: false,
      reason: 'malformed',
    });
    // A declared length above the cap ends the read at the headers, not at the deadline.
    const huge = await ask(
      (_seen, res) => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(MAX_RESPONSE_BYTES * 100),
        });
        res.flushHeaders();
      },
      {},
      1_500,
    );
    expect(huge).toEqual({ ok: false, reason: 'too-large' });
    expect(() =>
      createTokenEndpoint({
        dialer: spied().dialer,
        trust: trust(),
        timeoutMs: 0,
      }),
    ).toThrow(RangeError);
  });
});

/**
 * A Dialer that records what the adapter asked for and connects to the loopback issuer instead,
 * whatever the name and port were. `peer` overrides the address the socket reports, which is how a
 * name that resolved somewhere else is made. Nothing leaves the machine.
 */
function viaIssuer(port: number, peer?: { remoteAddress: string | undefined }) {
  const real = createDialer({ purposes: isRegisteredPurpose });
  const dialed: { host: string; port: number; tls: boolean }[] = [];
  const sockets: Awaited<ReturnType<Dialer['dial']>>['socket'][] = [];
  return {
    dialed,
    sockets,
    dialer: {
      dial: async (...args: Parameters<Dialer['dial']>) => {
        const [target, route] = args;
        dialed.push({
          host: target.host,
          port: target.port,
          tls: target.tls !== undefined,
        });
        const result = await real.dial(
          { host: '127.0.0.1', port, purpose: target.purpose },
          route,
        );
        if (peer !== undefined) {
          Object.defineProperty(result.socket, 'remoteAddress', {
            value: peer.remoteAddress,
            configurable: true,
          });
        }
        sockets.push(result.socket);
        return result;
      },
    },
  };
}

describe('token endpoint adapter Host header (N1)', () => {
  const hostSent = async (endpoint: string) => {
    const issuer = await startIssuer();
    const via = viaIssuer(issuer.port);
    const outcome = await createTokenEndpoint({
      dialer: via.dialer,
      trust: trust(),
    }).requestToken(request(endpoint), signal);
    expect(outcome.ok, endpoint).toBe(true);
    expect(issuer.requests).toHaveLength(1);
    return { host: issuer.requests[0]?.headers.host, dialed: via.dialed };
  };

  it('M1-23 hardening an https endpoint on the default port sends Host without a port, and any other port keeps it', async () => {
    expect(await hostSent('https://idp.example.test/t')).toEqual({
      host: 'idp.example.test',
      dialed: [{ host: 'idp.example.test', port: 443, tls: true }],
    });
    expect(await hostSent('https://idp.example.test:443/t')).toMatchObject({
      host: 'idp.example.test',
    });
    expect(await hostSent('https://idp.example.test:8443/t')).toEqual({
      host: 'idp.example.test:8443',
      dialed: [{ host: 'idp.example.test', port: 8443, tls: true }],
    });
    // 80 is the default of http, not of https.
    expect((await hostSent('https://idp.example.test:80/t')).host).toBe(
      'idp.example.test:80',
    );
  });

  it('M1-23 hardening an http endpoint sends Host without port 80, keeps any other, and brackets an IPv6 literal', async () => {
    expect(await hostSent('http://localhost/t')).toEqual({
      host: 'localhost',
      dialed: [{ host: 'localhost', port: 80, tls: false }],
    });
    expect((await hostSent('http://localhost:80/t')).host).toBe('localhost');
    expect(await hostSent('http://127.0.0.1:8080/t')).toEqual({
      host: '127.0.0.1:8080',
      dialed: [{ host: '127.0.0.1', port: 8080, tls: false }],
    });
    // 443 is the default of https, not of http.
    expect((await hostSent('http://localhost:443/t')).host).toBe(
      'localhost:443',
    );
    expect(await hostSent('http://[::1]:9/t')).toEqual({
      host: '[::1]:9',
      dialed: [{ host: '[::1]', port: 9, tls: false }],
    });
    expect((await hostSent('http://[::1]/t')).host).toBe('[::1]');
    expect((await hostSent('https://[::1]:8443/t')).host).toBe('[::1]:8443');
    expect((await hostSent('https://[::1]/t')).host).toBe('[::1]');
  });

  it('M1-23 hardening the Host header is the right one through the real Dialer to a real listener', async () => {
    const issuer = await startIssuer();
    const real = spied();
    await createTokenEndpoint({
      dialer: real.dialer,
      trust: trust(),
    }).requestToken(request(issuer.url), signal);
    expect(issuer.requests[0]?.headers.host).toBe(
      `127.0.0.1:${String(issuer.port)}`,
    );
  });
});

describe('token endpoint adapter loopback check (N2)', () => {
  it('M1-23 hardening plain http to a lookalike name is refused before anything is dialled', async () => {
    const issuer = await startIssuer();
    const via = viaIssuer(issuer.port);
    const adapter = createTokenEndpoint({
      dialer: via.dialer,
      trust: trust(),
    });
    for (const endpoint of [
      'http://127.0.0.1.evil.test/t',
      'http://evil.localhost/t',
      'http://localhost.evil.test/t',
      'http://notlocalhost/t',
      'http://localhost./t',
      'http://0.0.0.0/t',
      'http://[::ffff:127.0.0.1]/t',
      'http://[::ffff:7f00:1]/t',
      'http://[::2]/t',
      'http://issuer.example.test/t',
    ]) {
      expect(
        await adapter.requestToken(request(endpoint), signal),
        endpoint,
      ).toEqual({ ok: false, reason: 'egress-denied' });
    }
    expect(via.dialed).toEqual([]);
    expect(issuer.requests).toHaveLength(0);
  });

  it('M1-23 hardening a loopback name that reaches a non-loopback address is refused after the dial, with nothing sent', async () => {
    for (const peer of [
      '203.0.113.9',
      '10.0.0.1',
      '0.0.0.0',
      '::ffff:203.0.113.9',
      '2001:db8::1',
      '127.0.0.1.evil.test',
      '',
      undefined,
    ]) {
      for (const endpoint of [
        'http://localhost/t',
        'http://127.0.0.1:8080/t',
        'http://[::1]:8080/t',
      ]) {
        const issuer = await startIssuer();
        const via = viaIssuer(issuer.port, { remoteAddress: peer });
        const outcome = await createTokenEndpoint({
          dialer: via.dialer,
          trust: trust(),
        }).requestToken(request(endpoint), signal);
        const label = `${endpoint} via ${String(peer)}`;
        expect(outcome, label).toEqual({ ok: false, reason: 'egress-denied' });
        expect(via.dialed, label).toHaveLength(1);
        expect(via.sockets[0]?.destroyed, label).toBe(true);
        // The issuer never saw a request, so the secret never left.
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(issuer.requests, label).toHaveLength(0);
      }
    }
  });

  it('M1-23 hardening plain http to a peer on the loopback interface works in every form a socket reports', async () => {
    for (const peer of ['127.0.0.1', '127.8.8.8', '::1', '::ffff:127.0.0.1']) {
      const issuer = await startIssuer();
      const via = viaIssuer(issuer.port, { remoteAddress: peer });
      const outcome = await createTokenEndpoint({
        dialer: via.dialer,
        trust: trust(),
      }).requestToken(request('http://localhost/t'), signal);
      expect(outcome.ok, peer).toBe(true);
      expect(issuer.requests, peer).toHaveLength(1);
    }
  });

  it('M1-23 hardening an https issuer is not limited to loopback peers', async () => {
    const issuer = await startIssuer();
    const via = viaIssuer(issuer.port, { remoteAddress: '203.0.113.9' });
    const outcome = await createTokenEndpoint({
      dialer: via.dialer,
      trust: trust(),
    }).requestToken(request('https://idp.example.test/t'), signal);
    expect(outcome.ok).toBe(true);
    expect(issuer.requests).toHaveLength(1);
  });
});
