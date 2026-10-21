import { TestBed } from '@angular/core/testing';
import {
  EXPLORER_VERSION_KEY,
  explorerWindowTopic,
  type Problem,
} from '@app/contracts';
import type { ExplorerLiveEvent } from '@app/explorer-model';
import { EngineProblemError } from '@app/ui-data';
import { waitFor } from '@app/ui-platform/testing';
import { describe, expect, it } from 'vitest';

import { configureExplorerTestbed } from '../testing/explorer-testbed';

const window200 = { offset: 0, limit: 200 };

describe('createEngineExplorerData', () => {
  it('sends inventory.query as one POST with the connection in the path and the answer parsed against the contract', async () => {
    const { engine, fake, data } = configureExplorerTestbed();
    const answer = await data.query(
      {
        cid: 'c1' as never,
        kind: 'queues',
        filter: { text: 'queue-0001' },
        sort: { column: 'messages', dir: 'desc' },
        window: window200,
      },
      new AbortController().signal,
    );
    expect(answer.kind).toBe('queues');
    expect(answer.matched).toBe(10);
    expect(answer.version).toBe(fake.version);
    const [request] = engine.requests;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('/api/v1/connections/c1/inventory/queries');
    expect(
      JSON.parse(typeof request?.body === 'string' ? request.body : '{}'),
    ).toEqual({
      kind: 'queues',
      filter: { text: 'queue-0001' },
      sort: { column: 'messages', dir: 'desc' },
      window: window200,
    });
  });

  it('rejects with the engine Problem as sent, and aborts without a failure', async () => {
    const { data } = configureExplorerTestbed();
    await expect(
      data.query(
        {
          cid: 'c1' as never,
          kind: 'bindings',
          window: window200,
        },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(EngineProblemError);

    const controller = new AbortController();
    controller.abort();
    await expect(
      data.query(
        { cid: 'c1' as never, kind: 'queues', window: window200 },
        controller.signal,
      ),
    ).rejects.toBeDefined();
  });

  it('follows explorer.window: snapshot, delta, a Problem that ends the topic, and a completed end', async () => {
    const { engine, data } = configureExplorerTestbed();
    const events: ExplorerLiveEvent[] = [];
    const stop = data.follow(
      { cid: 'c1' as never, kind: 'queues', keys: ['k1'] },
      (event) => events.push(event),
    );
    await waitFor(
      () => engine.clientFrames.some((f) => f.t === 'sub'),
      'the sub',
    );
    const sub = engine.clientFrames.find((f) => f.t === 'sub');
    expect(sub).toMatchObject({
      topic: explorerWindowTopic.id,
      params: { cid: 'c1', kind: 'queues', keys: ['k1'] },
    });

    engine.publish(explorerWindowTopic.id, {
      key: EXPLORER_VERSION_KEY,
      version: 7,
    });
    // The topic is rate limited on the engine's own clock (a fake one here): move it on.
    engine.advance(1000);
    engine.pumpAll();
    await waitFor(() => events.length > 0, 'the first event');
    expect(events[0]?.kind).toMatch(/snapshot|delta/);
    engine.publish(explorerWindowTopic.id, {
      key: 'k1',
      version: 8,
      row: { vhost: '/', name: 'q' },
    });
    engine.advance(1000);
    engine.pumpAll();
    await waitFor(
      () => events.some((e) => e.kind === 'delta' && e.upserts.length > 0),
      'the upsert',
    );
    engine.remove(explorerWindowTopic.id, 'k1');
    engine.advance(1000);
    engine.pumpAll();
    await waitFor(
      () => events.some((e) => e.kind === 'delta' && e.removes.includes('k1')),
      'the removal',
    );

    const problem: Problem = {
      type: 'about:blank',
      title: 'Subscription refused',
      status: 403,
      code: 'FORBIDDEN_RBAC',
      correlationId: 'c',
      retryable: false,
    };
    const session = engine.sessions[0];
    if (session === undefined) throw new Error('no session');
    engine.endSubscription(session, 1, 'error', problem);
    await waitFor(() => events.some((e) => e.kind === 'error'), 'the end');
    const ended = events.find((e) => e.kind === 'error');
    expect(ended?.kind === 'error' && ended.error).toBeInstanceOf(
      EngineProblemError,
    );

    const more: ExplorerLiveEvent[] = [];
    data.follow({ cid: 'c1' as never, kind: 'queues', keys: [] }, (e) =>
      more.push(e),
    );
    await waitFor(
      () => engine.clientFrames.filter((f) => f.t === 'sub').length === 2,
      'the second sub',
    );
    engine.endSubscription(session, 2, 'completed');
    await waitFor(
      () => more.some((e) => e.kind === 'end'),
      'the completed end',
    );
    stop();
    TestBed.resetTestingModule();
  });
});
