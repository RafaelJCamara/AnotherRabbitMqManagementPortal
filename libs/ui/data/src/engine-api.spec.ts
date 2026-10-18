import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { EngineApi } from './engine-api';
import { EngineProblemError } from './errors';
import {
  configureTestbed,
  inventoryQuery,
  jobsCancel,
  queuesGet,
  queuesPurge,
  sentBody,
  unbound,
} from './test-fixtures';

describe('EngineApi', () => {
  describe('call', () => {
    it('reads a query action: path parameters in the URL, the rest in the query string', async () => {
      const { engine } = configureTestbed();
      const queue = await firstValueFrom(
        TestBed.inject(EngineApi).call(queuesGet, {
          cid: 'c1',
          qkey: 'q1',
          verbose: true,
        }),
      );
      expect(queue).toEqual({ name: 'q1', messages: 42 });
      expect(engine.requests[0]).toMatchObject({
        method: 'GET',
        url: '/api/v1/connections/c1/queues/q1?verbose=true',
      });
    });

    it('sends the fields that are not in the path as the JSON body of a POST', async () => {
      const { engine } = configureTestbed();
      const result = await firstValueFrom(
        TestBed.inject(EngineApi).call(inventoryQuery, {
          cid: 'c1',
          filter: { text: 'q' },
          window: { offset: 0, limit: 50 },
        }),
      );
      expect(result.names).toEqual(['q1', 'q2']);
      expect(engine.requests[0]).toMatchObject({
        method: 'POST',
        url: '/api/v1/connections/c1/inventory/queries',
        body: '{"filter":{"text":"q"},"window":{"offset":0,"limit":50}}',
      });
      expect(engine.requests[0]?.headers['content-type']).toBe(
        'application/json',
      );
    });

    it('calls a command without a body when the input is only path parameters', async () => {
      const { engine } = configureTestbed();
      const result = await firstValueFrom(
        TestBed.inject(EngineApi).call(jobsCancel, { jobId: 'j1' }),
      );
      expect(result.state).toBe('cancelled');
      expect(engine.requests[0]).not.toHaveProperty('body');
    });

    it('surfaces a Problem as an EngineProblemError', async () => {
      configureTestbed();
      const error = await firstValueFrom(
        TestBed.inject(EngineApi).call(queuesGet, {
          cid: 'c1',
          qkey: 'missing',
        }),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EngineProblemError);
      expect((error as EngineProblemError).code).toBe('NOT_FOUND');
    });

    it('fails the Observable, not the call, for an action with no HTTP binding or a bad input', async () => {
      configureTestbed();
      const api = TestBed.inject(EngineApi);
      const unboundCall = api.call(unbound, {});
      await expect(firstValueFrom(unboundCall)).rejects.toThrow(
        'no HTTP binding',
      );
      await expect(
        firstValueFrom(api.call(queuesGet, { cid: 'c1' } as never)),
      ).rejects.toThrow(/path parameter 'qkey'/);
    });

    it('checks the answer against the output schema in dev and test builds', async () => {
      configureTestbed();
      await expect(
        firstValueFrom(
          TestBed.inject(EngineApi).call(queuesGet, { cid: 'c1', qkey: 'bad' }),
        ),
      ).rejects.toMatchObject({ name: 'ZodError' });
    });

    it('trusts the answer when parsing is off (production builds)', async () => {
      configureTestbed({ parse: false });
      const queue = await firstValueFrom(
        TestBed.inject(EngineApi).call(queuesGet, { cid: 'c1', qkey: 'bad' }),
      );
      expect(queue).toEqual({ name: 'q1', messages: 'many' });
    });
  });

  describe('plan', () => {
    it('posts the whole input to the plans collection of the action and returns the plan', async () => {
      const { engine } = configureTestbed();
      const input = { cid: 'c1', qkey: 'q1', reason: 'test' };
      const plan = await firstValueFrom(
        TestBed.inject(EngineApi).plan(queuesPurge, input),
      );
      expect(engine.requests[0]).toMatchObject({
        method: 'POST',
        url: '/api/v1/actions/queues.purge/plans',
        body: JSON.stringify(input),
      });
      expect(plan.id).toBe('p1');
      expect(plan.consentsRequired).toEqual(['W-purge-1']);
      expect(plan.confirmationPhrase).toBe('purge q1');
      expect(plan.warnings.map((w) => w.id)).toEqual([
        'W-purge-1',
        'W-purge-2',
      ]);
    });
  });

  describe('execute', () => {
    it('posts the consents, the typed phrase and an idempotency key, and returns the output with its receipt', async () => {
      const { engine } = configureTestbed();
      const result = await firstValueFrom(
        TestBed.inject(EngineApi).execute(queuesPurge, 'p1', {
          consents: ['W-purge-1'],
          confirmation: 'purge q1',
        }),
      );
      expect(result).toEqual({ output: { purged: 42 }, receipt: { id: 'r1' } });
      const sent = sentBody(engine.requests[0]);
      expect(engine.requests[0]).toMatchObject({
        method: 'POST',
        url: '/api/v1/plans/p1/execute',
      });
      expect(sent).toMatchObject({
        consents: ['W-purge-1'],
        confirmation: 'purge q1',
      });
      expect(sent.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('reuses the idempotency key when the same call is repeated, and keeps a given key', async () => {
      const { engine } = configureTestbed();
      const api = TestBed.inject(EngineApi);
      const call = api.execute(queuesPurge, 'p1', { consents: ['W-purge-1'] });
      await firstValueFrom(call);
      await firstValueFrom(call);
      const keys = engine.requests.map((r) => sentBody(r).idempotencyKey);
      expect(keys[0]).toBe(keys[1]);
      await firstValueFrom(
        api.execute(queuesPurge, 'p1', {
          consents: ['W-purge-1'],
          idempotencyKey: 'mine',
        }),
      );
      expect(sentBody(engine.requests[2])).toMatchObject({
        idempotencyKey: 'mine',
      });
    });

    it('omits the confirmation when there is none', async () => {
      const { engine } = configureTestbed();
      await firstValueFrom(
        TestBed.inject(EngineApi).execute(queuesPurge, 'p1', {
          consents: ['W-purge-1'],
        }),
      );
      expect(sentBody(engine.requests[0])).not.toHaveProperty('confirmation');
    });

    it('returns a job when the engine runs the action as one', async () => {
      configureTestbed();
      const result = await firstValueFrom(
        TestBed.inject(EngineApi).execute(queuesPurge, 'job', { consents: [] }),
      );
      expect(result).toEqual({ jobId: 'job-1' });
    });

    it('fails with the engine Problem, with its warnings, when consent is missing', async () => {
      configureTestbed();
      const error = (await firstValueFrom(
        TestBed.inject(EngineApi).execute(queuesPurge, 'p1', { consents: [] }),
      ).catch((e: unknown) => e)) as EngineProblemError;
      expect(error.code).toBe('CONSENT_REQUIRED');
      expect(error.warnings).toHaveLength(2);
    });

    it('checks the output of an executed plan in dev and test builds', async () => {
      configureTestbed({
        engine: {
          handler: () => ({
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ output: { purged: 'many' } }),
          }),
        },
      });
      await expect(
        firstValueFrom(
          TestBed.inject(EngineApi).execute(queuesPurge, 'p1', {
            consents: [],
          }),
        ),
      ).rejects.toMatchObject({ name: 'ZodError' });
    });
  });
});
