// The Host header of a scrape (fix after the M1-23 review): the wire carries the origin's host, with
// the default port of the scheme left out. Real HTTP over a real socket; only the Dialer is replaced
// by one that records what was asked and connects to the loopback server instead.
import { createDialer } from '@app/net-dialer';
import { createTrustStore, type TlsTrust } from '@app/net-truststore';
import { afterEach, describe, expect, it } from 'vitest';

import { createPromScrapeClient, type PromTarget } from './client.ts';
import { CID, startPromServer, type PromServer } from './test-support.ts';
import { hostHeader } from './transport.ts';

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const trust: TlsTrust = createTrustStore({
  runtime: {
    getCACertificates: () => [],
    setDefaultCACertificates: () => undefined,
  },
}).forProfile({});

async function hostSeen(
  target: Pick<PromTarget, 'host' | 'port'> & { secure: boolean },
): Promise<{
  host: string | undefined;
  dialed: { host: string; port: number; tls: boolean }[];
}> {
  const server: PromServer = await startPromServer();
  closers.push(() => server.close());
  const real = createDialer();
  const dialed: { host: string; port: number; tls: boolean }[] = [];
  const client = createPromScrapeClient({
    dialer: {
      dial: (...args) => {
        const [wanted, route] = args;
        dialed.push({
          host: wanted.host,
          port: wanted.port,
          tls: wanted.tls !== undefined,
        });
        return real.dial(
          { host: '127.0.0.1', port: server.port, purpose: wanted.purpose },
          route,
        );
      },
    },
    targets: {
      resolve: () =>
        Promise.resolve({
          host: target.host,
          port: target.port,
          route: { kind: 'direct' },
          auth: { kind: 'none' },
          ...(target.secure ? { tls: trust } : {}),
        }),
    },
  });
  closers.push(() => {
    client.close();
  });
  const body = await client.scrape.scrape(
    {
      connectionId: CID,
      node: 'rabbit@n1',
      path: '/metrics',
      lane: 'background',
    },
    new AbortController().signal,
  );
  let bytes = 0;
  for await (const chunk of body) bytes += chunk.length;
  expect(bytes).toBeGreaterThanOrEqual(0);
  expect(server.requests).toHaveLength(1);
  return { host: server.requests[0]?.headers.host, dialed };
}

describe('scrape Host header', () => {
  it('M1-23 hardening https on the default port sends Host without a port, and any other port keeps it', async () => {
    expect(
      await hostSeen({ host: 'rmq.example.test', port: 443, secure: true }),
    ).toEqual({
      host: 'rmq.example.test',
      dialed: [{ host: 'rmq.example.test', port: 443, tls: true }],
    });
    expect(
      (await hostSeen({ host: 'rmq.example.test', port: 15692, secure: true }))
        .host,
    ).toBe('rmq.example.test:15692');
    // 80 is the default of http, not of https.
    expect(
      (await hostSeen({ host: 'rmq.example.test', port: 80, secure: true }))
        .host,
    ).toBe('rmq.example.test:80');
  });

  it('M1-23 hardening http on port 80 sends Host without a port, any other port keeps it, and an IPv6 literal is bracketed', async () => {
    expect(
      (await hostSeen({ host: 'rmq.example.test', port: 80, secure: false }))
        .host,
    ).toBe('rmq.example.test');
    expect(
      (await hostSeen({ host: 'rmq.example.test', port: 15692, secure: false }))
        .host,
    ).toBe('rmq.example.test:15692');
    // 443 is the default of https, not of http.
    expect(
      (await hostSeen({ host: 'rmq.example.test', port: 443, secure: false }))
        .host,
    ).toBe('rmq.example.test:443');
    expect(
      (await hostSeen({ host: '[::1]', port: 9, secure: false })).host,
    ).toBe('[::1]:9');
    expect((await hostSeen({ host: '::1', port: 9, secure: false })).host).toBe(
      '[::1]:9',
    );
    expect(
      (await hostSeen({ host: '[::1]', port: 80, secure: false })).host,
    ).toBe('[::1]');
    expect(
      (await hostSeen({ host: '::1', port: 443, secure: true })).host,
    ).toBe('[::1]');
  });

  it('M1-23 hardening hostHeader is a pure function of host, port and scheme', () => {
    const dial = (host: string, port: number, secure: boolean) => ({
      host,
      port,
      route: { kind: 'direct' },
      ...(secure ? { tls: trust } : {}),
    });
    expect(hostHeader(dial('a.test', 443, true))).toBe('a.test');
    expect(hostHeader(dial('a.test', 80, false))).toBe('a.test');
    expect(hostHeader(dial('a.test', 8443, true))).toBe('a.test:8443');
    expect(hostHeader(dial('a.test', 8080, false))).toBe('a.test:8080');
    expect(hostHeader(dial('2001:db8::1', 15692, false))).toBe(
      '[2001:db8::1]:15692',
    );
  });
});
