// I-9: the client reaches the broker only through the Dialer and the TrustStore.
import { createServer as createHttpsServer } from 'node:https';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createTestPki } from '@app/net-truststore/testing';

import type { MgmtHttpError } from './errors.ts';
import {
  CID,
  emptyTrustStore,
  harness,
  startMgmtServer,
  type Harness,
  type MgmtServer,
} from './test-support.ts';

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const request = (h: Harness) =>
  h.client.read.get(
    {
      connectionId: CID,
      path: '/api/overview',
      schema: z.object({ node: z.string() }),
      lane: 'interactive',
    },
    h.signal,
  );

async function rejection(promise: Promise<unknown>): Promise<MgmtHttpError> {
  try {
    await promise;
  } catch (error) {
    return error as MgmtHttpError;
  }
  throw new Error('expected the request to fail');
}

describe('sockets come from the Dialer', () => {
  it('stops at the egress policy before any socket exists', async () => {
    const server = await startMgmtServer();
    closers.push(() => server.close());
    const h = harness(server.port, {
      dialer: {
        policy: {
          evaluate: (asked) => ({
            allowed: false,
            reason: `${asked.purpose} may not dial`,
          }),
        },
      },
    });
    closers.push(() => {
      h.client.close();
    });

    const error = await rejection(request(h));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(error.code).toBe('EGRESS_DENIED');
    expect(error.retryable).toBe(false);
    expect(server.requests).toHaveLength(0);
  });

  it('asks the policy with the mgmt-http purpose', async () => {
    const server = await startMgmtServer();
    closers.push(() => server.close());
    const purposes: string[] = [];
    const h = harness(server.port, {
      dialer: {
        policy: {
          evaluate: (asked) => {
            purposes.push(asked.purpose);
            return { allowed: true };
          },
        },
      },
    });
    closers.push(() => {
      h.client.close();
    });
    server.reply(() => ({ status: 200, body: '{"node":"n1"}' }));

    expect(await request(h)).toEqual({ node: 'n1' });
    expect(purposes).toEqual(['mgmt-http']);
  });
});

describe('https origins', () => {
  async function secured(): Promise<{
    server: MgmtServer;
    root: string;
  }> {
    const pki = createTestPki('Lab Root');
    const { leaf, chainPem } = pki.issueServer({
      dnsNames: ['broker.lab.test'],
      ipAddresses: [],
    });
    const server = await startMgmtServer((listener) =>
      createHttpsServer({ cert: chainPem, key: leaf.keyPem }, listener),
    );
    closers.push(() => server.close());
    server.reply(() => ({ status: 200, body: '{"node":"n1"}' }));
    return { server, root: pki.root.pem };
  }

  it('verifies the broker against the profile CA and the overridden name', async () => {
    const { server, root } = await secured();
    const h = harness(server.port, {
      tls: emptyTrustStore().forProfile({ ca: [root] }),
      servername: 'broker.lab.test',
    });
    closers.push(() => {
      h.client.close();
    });

    expect(await request(h)).toEqual({ node: 'n1' });
    expect(server.requests[0]?.headers.authorization).toMatch(/^Basic /);
  });

  it('refuses a broker whose certificate no CA vouches for, and sends nothing', async () => {
    const { server } = await secured();
    const h = harness(server.port, {
      tls: emptyTrustStore().forProfile(),
      servername: 'broker.lab.test',
    });
    closers.push(() => {
      h.client.close();
    });

    const error = await rejection(request(h));

    expect(error.code).toBe('TLS_UNTRUSTED');
    expect(server.requests).toHaveLength(0);
  });
});
