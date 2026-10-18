import { Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { engineResource } from './engine-resource';
import { EngineProblemError } from './errors';
import {
  configureTestbed,
  inventoryQuery,
  jobsCancel,
  queuesGet,
  queuesPurge,
} from './test-fixtures';
import { tick } from '@app/ui-platform/testing';

/** Lets effects run and the request finish. */
async function settle(done: () => boolean): Promise<void> {
  for (let round = 0; round < 100; round += 1) {
    TestBed.tick();
    if (done()) return;
    await tick();
  }
  throw new Error('the resource did not settle');
}

describe('engineResource', () => {
  it('loads the answer of a query action and parses it', async () => {
    const { engine } = configureTestbed();
    const queue = TestBed.runInInjectionContext(() =>
      engineResource(queuesGet, () => ({
        cid: 'c1',
        qkey: 'q1',
        verbose: true,
      })),
    );
    await settle(() => queue.hasValue());
    expect(queue.value()).toEqual({ name: 'q1', messages: 42 });
    expect(queue.error()).toBeUndefined();
    expect(engine.requests[0]?.url).toBe(
      '/api/v1/connections/c1/queues/q1?verbose=true',
    );
    expect(queue.statusCode()).toBe(200);
  });

  it('reloads when the signals the input reads change', async () => {
    const { engine } = configureTestbed();
    const verbose = signal(false);
    const queue = TestBed.runInInjectionContext(() =>
      engineResource(queuesGet, () => ({
        cid: 'c1',
        qkey: 'q1',
        verbose: verbose(),
      })),
    );
    await settle(() => queue.hasValue());
    expect(queue.value()?.messages).toBe(0);
    verbose.set(true);
    await settle(() => queue.value()?.messages === 42);
    expect(engine.requests.map((r) => r.url)).toEqual([
      '/api/v1/connections/c1/queues/q1?verbose=false',
      '/api/v1/connections/c1/queues/q1?verbose=true',
    ]);
  });

  it('stays idle while the input is undefined, and loads when it appears', async () => {
    const { engine } = configureTestbed();
    const qkey = signal<string | undefined>(undefined);
    const queue = TestBed.runInInjectionContext(() =>
      engineResource(queuesGet, () => {
        const key = qkey();
        return key === undefined ? undefined : { cid: 'c1', qkey: key };
      }),
    );
    TestBed.tick();
    await tick(5);
    expect(queue.status()).toBe('idle');
    expect(queue.value()).toBeUndefined();
    expect(engine.requests).toEqual([]);
    qkey.set('q1');
    await settle(() => queue.hasValue());
    expect(queue.value()?.name).toBe('q1');
  });

  it('reports a Problem as an EngineProblemError in the resource error', async () => {
    configureTestbed();
    const queue = TestBed.runInInjectionContext(() =>
      engineResource(queuesGet, () => ({ cid: 'c1', qkey: 'missing' })),
    );
    await settle(() => queue.status() === 'error');
    expect(queue.hasValue()).toBe(false);
    const error = queue.error();
    expect(error).toBeInstanceOf(EngineProblemError);
    expect((error as EngineProblemError).code).toBe('NOT_FOUND');
  });

  it('fails the resource, in dev and test builds, when the answer breaks the contract', async () => {
    configureTestbed();
    const queue = TestBed.runInInjectionContext(() =>
      engineResource(queuesGet, () => ({ cid: 'c1', qkey: 'bad' })),
    );
    await settle(() => queue.status() === 'error');
    expect(queue.error()).toMatchObject({ name: 'ZodError' });
  });

  it('does not parse in production builds', async () => {
    configureTestbed({ parse: false });
    const queue = TestBed.runInInjectionContext(() =>
      engineResource(queuesGet, () => ({ cid: 'c1', qkey: 'bad' })),
    );
    await settle(() => queue.hasValue());
    expect(queue.value()).toEqual({ name: 'q1', messages: 'many' });
  });

  it('sends a query action that is a POST with its body', async () => {
    const { engine } = configureTestbed();
    const names = TestBed.runInInjectionContext(() =>
      engineResource(inventoryQuery, () => ({
        cid: 'c1',
        filter: { text: 'q' },
        window: { offset: 0, limit: 10 },
      })),
    );
    await settle(() => names.hasValue());
    expect(names.value()).toEqual({ names: ['q1', 'q2'] });
    expect(engine.requests[0]).toMatchObject({
      method: 'POST',
      body: '{"filter":{"text":"q"},"window":{"offset":0,"limit":10}}',
    });
  });

  it('refuses a command: a resource re-runs, and a command must not', () => {
    configureTestbed();
    for (const action of [queuesPurge, jobsCancel]) {
      expect(() =>
        TestBed.runInInjectionContext(() =>
          engineResource(action, () => undefined),
        ),
      ).toThrow(/not a read/);
    }
  });

  it('takes an injector when it is created outside an injection context', async () => {
    configureTestbed();
    const queue = engineResource(queuesGet, () => ({ cid: 'c1', qkey: 'q1' }), {
      injector: TestBed.inject(Injector),
    });
    await settle(() => queue.hasValue());
    expect(queue.value()?.name).toBe('q1');
  });
});
