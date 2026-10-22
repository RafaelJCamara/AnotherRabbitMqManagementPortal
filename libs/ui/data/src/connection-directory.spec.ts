import { TestBed } from '@angular/core/testing';
import {
  CONNECTIONS_PAGE_MAX,
  CONNECTIONS_PER_PRINCIPAL_MAX,
  connectionsList,
  type ConnectionProfile,
  type Problem,
} from '@app/contracts';
import {
  jsonResponse,
  problemResponse,
  tick,
  type FakeHandler,
} from '@app/ui-platform/testing';
import { describe, expect, it } from 'vitest';

import { ConnectionDirectory } from './connection-directory';
import { EngineProblemError } from './errors';
import { configureTestbed } from './test-fixtures';

export function profile(
  id: string,
  envClass: ConnectionProfile['envClass'] = 'dev',
): ConnectionProfile {
  const secret = { isSet: true, updatedAt: 1 };
  return {
    id: id as ConnectionProfile['id'],
    name: `Broker ${id}`,
    envClass,
    color: null,
    visibility: 'private',
    canEdit: true,
    http: {
      url: 'http://127.0.0.1:15672',
      host: '127.0.0.1',
      port: 15672,
      tls: false,
      pathPrefix: null,
      auth: { kind: 'basic', username: 'guest', secret },
    },
    amqp: {
      host: '127.0.0.1',
      port: 5672,
      tls: false,
      vhost: '/',
      auth: { kind: 'plain', username: 'guest', secret },
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

const unavailable: Problem = {
  type: 'about:blank',
  title: 'The engine is busy',
  status: 503,
  code: 'INTERNAL',
  correlationId: 'req-1',
  retryable: true,
};

/** An engine that lists `total` profiles in windows of the size it is asked for. */
function listing(total: number, calls: string[] = []): FakeHandler {
  return (request) => {
    const url = new URL(request.url, 'http://engine.test');
    calls.push(`${request.method} ${url.pathname}${url.search}`);
    const limit = Number(url.searchParams.get('limit') ?? '25');
    const start = Number(url.searchParams.get('cursor') ?? '0');
    const end = Math.min(total, start + limit);
    const items = Array.from({ length: end - start }, (_, i) =>
      profile(`c${String(start + i)}`),
    );
    return jsonResponse(200, {
      items,
      ...(end < total ? { nextCursor: String(end) } : {}),
    });
  };
}

async function settle(done: () => boolean): Promise<void> {
  for (let round = 0; round < 100 && !done(); round += 1) await tick();
  if (!done()) throw new Error('the directory did not settle');
}

describe('ConnectionDirectory', () => {
  it('AC-9 reads the first window of connections.list and shares it with every reader', async () => {
    const calls: string[] = [];
    configureTestbed({ engine: { handler: listing(3, calls) } });
    const directory = TestBed.inject(ConnectionDirectory);
    expect(directory.status()).toBe('idle');
    directory.ensureLoaded();
    directory.ensureLoaded();
    await settle(() => directory.status() === 'ready');
    expect(directory.items().map((p) => p.id)).toEqual(['c0', 'c1', 'c2']);
    expect(directory.hasMore()).toBe(false);
    expect(directory.find('c1')?.name).toBe('Broker c1');
    expect(directory.find('nope')).toBeUndefined();
    // Two ensureLoaded calls make one request, and it is the contract's window.
    expect(calls).toEqual([
      `GET /api/v1/connections?limit=${String(CONNECTIONS_PAGE_MAX)}`,
    ]);
    expect(connectionsList.http?.path).toBe('/connections');
  });

  it('AC-9 reads further windows on request and stops at the per-person bound', async () => {
    configureTestbed({ engine: { handler: listing(250) } });
    const directory = TestBed.inject(ConnectionDirectory);
    await directory.refresh();
    expect(directory.items()).toHaveLength(100);
    expect(directory.hasMore()).toBe(true);
    await directory.more();
    expect(directory.items()).toHaveLength(200);
    // 200 is the most one person can have, so nothing is read past it (I-6, I-7).
    expect(directory.items()).toHaveLength(CONNECTIONS_PER_PRINCIPAL_MAX);
    expect(directory.hasMore()).toBe(false);
    await directory.more();
    expect(directory.items()).toHaveLength(CONNECTIONS_PER_PRINCIPAL_MAX);
  });

  it('AC-9 a refresh replaces what was read, and a failed read keeps the last good list and says why', async () => {
    let fail = false;
    const base = listing(2);
    configureTestbed({
      engine: {
        handler: (request) =>
          fail ? problemResponse(unavailable) : base(request),
      },
    });
    const directory = TestBed.inject(ConnectionDirectory);
    await directory.refresh();
    expect(directory.items()).toHaveLength(2);
    fail = true;
    await directory.refresh();
    expect(directory.status()).toBe('error');
    expect(directory.items()).toHaveLength(2);
    const error = directory.error();
    expect(error).toBeInstanceOf(EngineProblemError);
    expect((error as EngineProblemError).problem.title).toBe(
      'The engine is busy',
    );
    fail = false;
    await directory.refresh();
    expect(directory.status()).toBe('ready');
    expect(directory.error()).toBeNull();
  });

  it('AC-9 of two overlapping refreshes the later one wins', async () => {
    const release: (() => void)[] = [];
    let call = 0;
    configureTestbed({
      engine: {
        handler: async () => {
          call += 1;
          const mine = call;
          await new Promise<void>((resolve) => release.push(resolve));
          return jsonResponse(200, {
            items: mine === 1 ? [profile('old')] : [profile('new')],
          });
        },
      },
    });
    const directory = TestBed.inject(ConnectionDirectory);
    const first = directory.refresh();
    const second = directory.refresh();
    await settle(() => release.length === 2);
    // The second answer arrives first, then the first (older) one.
    release[1]?.();
    await second;
    release[0]?.();
    await first;
    expect(directory.items().map((p) => p.id)).toEqual(['new']);
  });
});
