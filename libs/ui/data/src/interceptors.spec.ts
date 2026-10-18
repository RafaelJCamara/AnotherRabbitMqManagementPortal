import { HttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { TransportError } from '@app/ui-platform';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { EngineProblemError } from './errors';
import { REQUEST_ID_HEADER } from './interceptors';
import { configureTestbed, gateProblem } from './test-fixtures';

async function failure(request: Promise<unknown>): Promise<unknown> {
  try {
    await request;
  } catch (error) {
    return error;
  }
  throw new Error('the request should have failed');
}

describe('problemInterceptor', () => {
  it('AC-2 turns a Problem answer into a typed error that carries the gate and the warnings', async () => {
    configureTestbed();
    const http = TestBed.inject(HttpClient);
    const error = await failure(
      firstValueFrom(
        http.post('/api/v1/connections/c1/queues/blocked/purge', {
          reason: 'r',
        }),
      ),
    );
    expect(error).toBeInstanceOf(EngineProblemError);
    const problem = error as EngineProblemError;
    expect(problem.code).toBe('GATE_BLOCKED');
    expect(problem.status).toBe(422);
    expect(problem.retryable).toBe(false);
    expect(problem.correlationId).toBe('req-gate');
    expect(problem.gate).toEqual(gateProblem.gate);
    expect(problem.gate?.reason).toBe(
      'Statistics are disabled on this broker.',
    );
    expect(problem.gate?.fix?.actionId).toBe('settings.put');
    expect(problem.warnings.map((w) => w.id)).toEqual([
      'W-purge-1',
      'W-purge-2',
    ]);
    expect(problem.problem).toEqual(gateProblem);
    expect(problem.synthetic).toBe(false);
    expect(problem.message).toBe('Statistics are off for this broker.');
  });

  it('has no gate and no warnings on a plain Problem', async () => {
    configureTestbed();
    const error = (await failure(
      firstValueFrom(
        TestBed.inject(HttpClient).get('/api/v1/connections/c1/queues/missing'),
      ),
    )) as EngineProblemError;
    expect(error.code).toBe('NOT_FOUND');
    expect(error.gate).toBeUndefined();
    expect(error.warnings).toEqual([]);
  });

  it('keeps the Location header: the plan the engine made for a PLAN_REQUIRED answer', async () => {
    configureTestbed();
    const error = (await failure(
      firstValueFrom(
        TestBed.inject(HttpClient).post(
          '/api/v1/connections/c1/queues/q1/purge',
          {
            reason: 'r',
          },
        ),
      ),
    )) as EngineProblemError;
    expect(error.code).toBe('PLAN_REQUIRED');
    expect(error.status).toBe(428);
    expect(error.location).toBe('/api/v1/plans/p1');
  });

  it('ignores fields of a Problem that this build does not know', async () => {
    configureTestbed({
      engine: {
        handler: () => ({
          status: 409,
          headers: { 'content-type': 'application/problem+json' },
          body: JSON.stringify({
            ...gateProblem,
            status: 409,
            code: 'PLAN_STALE',
            docs: 'https://docs.example/plan-stale',
          }),
        }),
      },
    });
    const error = (await failure(
      firstValueFrom(TestBed.inject(HttpClient).get('/api/v1/x')),
    )) as EngineProblemError;
    expect(error.synthetic).toBe(false);
    expect(error.code).toBe('PLAN_STALE');
    expect(error.gate).toBeDefined();
  });

  it('makes a flagged Problem for an error answer that has none', async () => {
    configureTestbed();
    const error = (await failure(
      firstValueFrom(TestBed.inject(HttpClient).get('/api/v1/html-error')),
    )) as EngineProblemError;
    expect(error).toBeInstanceOf(EngineProblemError);
    expect(error.synthetic).toBe(true);
    expect(error.code).toBe('INTERNAL');
    expect(error.status).toBe(502);
    expect(error.retryable).toBe(true);
    // The id it sent is the one to look for in the engine's log.
    expect(error.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([
    [401, 'UNAUTHENTICATED', false],
    [404, 'NOT_FOUND', false],
    [429, 'RATE_LIMITED', true],
    [500, 'INTERNAL', false],
    [503, 'INTERNAL', true],
  ])(
    'maps a bodiless HTTP %i to %s (retryable %s)',
    async (status, code, retryable) => {
      configureTestbed({
        engine: { handler: () => ({ status, headers: {} }) },
      });
      const error = (await failure(
        firstValueFrom(TestBed.inject(HttpClient).get('/api/v1/x')),
      )) as EngineProblemError;
      expect(error.synthetic).toBe(true);
      expect(error.code).toBe(code);
      expect(error.retryable).toBe(retryable);
    },
  );

  it('treats a body that is almost a Problem as no Problem', async () => {
    configureTestbed({
      engine: {
        handler: () => ({
          status: 400,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...gateProblem, code: 'NOT_A_CODE' }),
        }),
      },
    });
    const error = (await failure(
      firstValueFrom(TestBed.inject(HttpClient).get('/api/v1/x')),
    )) as EngineProblemError;
    expect(error.synthetic).toBe(true);
    expect(error.gate).toBeUndefined();
  });

  it('lets a carrier failure through as the TransportError', async () => {
    const { transport } = configureTestbed();
    const lost = new TransportError('network', 'down');
    transport.request = () => Promise.reject(lost);
    const error = await failure(
      firstValueFrom(TestBed.inject(HttpClient).get('/api/v1/x')),
    );
    expect(error).toBe(lost);
  });
});

describe('correlationInterceptor', () => {
  it('gives every request an id, a different one each time', async () => {
    const { engine } = configureTestbed();
    const http = TestBed.inject(HttpClient);
    await firstValueFrom(http.get('/api/v1/connections/c1/queues/q1'));
    await firstValueFrom(http.get('/api/v1/connections/c1/queues/q1'));
    const ids = engine.requests.map((r) => r.headers[REQUEST_ID_HEADER]);
    expect(ids[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(ids[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('keeps an id the caller set', async () => {
    const { engine } = configureTestbed();
    await firstValueFrom(
      TestBed.inject(HttpClient).get('/api/v1/connections/c1/queues/q1', {
        headers: { [REQUEST_ID_HEADER]: 'mine' },
      }),
    );
    expect(engine.requests[0]?.headers[REQUEST_ID_HEADER]).toBe('mine');
  });
});

describe('authInterceptor', () => {
  const queue = '/api/v1/connections/c1/queues/q1';

  it('sends the bearer token on engine requests and the CSRF token on unsafe methods only', async () => {
    const { engine } = configureTestbed({
      credentials: () => ({ bearer: 'launch', csrf: 'csrf-1' }),
    });
    const http = TestBed.inject(HttpClient);
    await firstValueFrom(http.get(queue));
    await firstValueFrom(
      http.post('/api/v1/connections/c1/inventory/queries', {}),
    );
    const [get, post] = engine.requests;
    expect(get?.headers.authorization).toBe('Bearer launch');
    expect(get?.headers).not.toHaveProperty('x-csrf-token');
    expect(post?.headers.authorization).toBe('Bearer launch');
    expect(post?.headers['x-csrf-token']).toBe('csrf-1');
  });

  it('reads the credentials fresh on every request', async () => {
    let token = 'one';
    const { engine } = configureTestbed({
      credentials: () => ({ bearer: token }),
    });
    const http = TestBed.inject(HttpClient);
    await firstValueFrom(http.get(queue));
    token = 'two';
    await firstValueFrom(http.get(queue));
    expect(engine.requests.map((r) => r.headers.authorization)).toEqual([
      'Bearer one',
      'Bearer two',
    ]);
  });

  it('never sends credentials to another origin', async () => {
    const { engine } = configureTestbed({
      credentials: () => ({ bearer: 'launch', csrf: 'csrf-1' }),
      engine: { handler: () => ({ status: 200, headers: {}, body: '{}' }) },
    });
    const http = TestBed.inject(HttpClient);
    await firstValueFrom(http.post('https://other.example/x', {}));
    await firstValueFrom(http.post('//other.example/x', {}));
    for (const request of engine.requests) {
      expect(request.headers).not.toHaveProperty('authorization');
      expect(request.headers).not.toHaveProperty('x-csrf-token');
    }
  });

  it('sends no credential header when there is none', async () => {
    const { engine } = configureTestbed();
    await firstValueFrom(TestBed.inject(HttpClient).get(queue));
    expect(engine.requests[0]?.headers).not.toHaveProperty('authorization');
  });
});
