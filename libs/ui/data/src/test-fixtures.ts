// Contracts and an engine handler for the specs of this library. Real actions arrive with their
// service modules; these exercise every shape of binding EngineApi has to map.
import {
  defineAction,
  defineTopic,
  type Problem,
  type ActionId,
} from '@app/contracts';
import {
  ENGINE_CREDENTIALS,
  ENGINE_TRANSPORT,
  type EngineCredentialsSource,
  type EngineTransport,
} from '@app/ui-platform';
import {
  FakeEngine,
  MemoryTransport,
  jsonResponse,
  problemResponse,
  type FakeEngineOptions,
  type FakeHandler,
} from '@app/ui-platform/testing';
import { TestBed } from '@angular/core/testing';
import type { Provider } from '@angular/core';
import { z } from 'zod';

import type { LiveClientConfig } from './live-client';
import { ENGINE_PARSE } from './parse-mode';
import { provideEngineData } from './provide-engine-data';

const cid = z.string().min(1);

/** GET with path parameters and flat query fields. */
export const queuesGet = defineAction({
  id: 'queues.get',
  kind: 'query',
  summary: 'Read one queue',
  input: z.strictObject({
    cid,
    qkey: z.string().min(1),
    verbose: z.boolean().optional(),
    fields: z.array(z.string()).optional(),
  }),
  output: z.strictObject({ name: z.string(), messages: z.number().int() }),
  permission: 'queues.read',
  risk: 'none',
  planning: 'none',
  audit: 'none',
  target: () => ({}),
  http: { method: 'GET', path: '/connections/{cid}/queues/{qkey}' },
  since: '1.0',
});

/** POST command that needs a plan. */
export const queuesPurge = defineAction({
  id: 'queues.purge',
  kind: 'command',
  summary: 'Purge a queue',
  input: z.strictObject({
    cid,
    qkey: z.string().min(1),
    reason: z.string(),
  }),
  output: z.strictObject({ purged: z.number().int() }),
  permission: 'messages.purge',
  risk: 'high',
  planning: 'required',
  audit: 'attempt+outcome',
  target: () => ({}),
  http: { method: 'POST', path: '/connections/{cid}/queues/{qkey}/purge' },
  since: '1.0',
});

/** POST that only reads: a windowed query with a structured filter. */
export const inventoryQuery = defineAction({
  id: 'inventory.query',
  kind: 'query',
  summary: 'Query the inventory',
  input: z.strictObject({
    cid,
    filter: z.strictObject({ text: z.string() }),
    window: z.strictObject({
      offset: z.number().int(),
      limit: z.number().int(),
    }),
  }),
  output: z.strictObject({ names: z.array(z.string()) }),
  permission: 'inventory.read',
  risk: 'none',
  planning: 'none',
  audit: 'none',
  target: () => ({}),
  http: { method: 'POST', path: '/connections/{cid}/inventory/queries' },
  since: '1.0',
});

/** POST with a path parameter and no body fields. */
export const jobsCancel = defineAction({
  id: 'jobs.cancel',
  kind: 'command',
  summary: 'Cancel a job',
  input: z.strictObject({ jobId: z.string() }),
  output: z.strictObject({ state: z.string() }),
  permission: 'jobs.cancel',
  risk: 'low',
  planning: 'none',
  audit: 'attempt+outcome',
  target: () => ({}),
  http: { method: 'POST', path: '/jobs/{jobId}/cancel' },
  since: '1.0',
});

/** POST whose only body field is optional. */
export const settingsPut = defineAction({
  id: 'settings.put',
  kind: 'command',
  summary: 'Save a setting',
  input: z.strictObject({ name: z.string(), value: z.string().optional() }),
  output: z.strictObject({ saved: z.boolean() }),
  permission: 'settings.write',
  risk: 'low',
  planning: 'none',
  audit: 'attempt+outcome',
  target: () => ({}),
  http: { method: 'PUT', path: '/settings/{name}' },
  since: '1.0',
});

/** An action with no HTTP binding (MCP or CLI only). */
export const unbound = defineAction({
  id: 'meta.ping',
  kind: 'query',
  summary: 'No binding',
  input: z.strictObject({}),
  output: z.strictObject({}),
  permission: 'meta.read',
  risk: 'none',
  planning: 'none',
  audit: 'none',
  target: () => ({}),
  since: '1.0',
});

export const eventsTopic = defineTopic({
  id: 'test.events',
  params: z.strictObject({ cid }),
  item: z.strictObject({ n: z.number().int() }),
  qos: 'lossless',
  flow: 'credit',
  permission: 'events.read',
  ring: { items: 1000, bytes: 1_000_000 },
});

export const smallEventsTopic = defineTopic({
  id: 'test.small-events',
  params: z.strictObject({ cid }),
  item: z.strictObject({ n: z.number().int() }),
  qos: 'lossless',
  flow: 'credit',
  permission: 'events.read',
  ring: { items: 3, bytes: 100_000 },
});

export const stateTopic = defineTopic({
  id: 'test.state',
  params: z.strictObject({ cid }),
  item: z.strictObject({ id: z.string(), v: z.number().int() }),
  qos: 'latest',
  flow: 'snapshot-delta',
  key: (item) => (item as { id: string }).id,
  permission: 'state.read',
  ring: { items: 100, bytes: 100_000 },
});

export const gateProblem: Problem = {
  type: 'https://errors.example/gate-blocked',
  title: 'The purge is blocked',
  status: 422,
  code: 'GATE_BLOCKED',
  detail: 'Statistics are off for this broker.',
  correlationId: 'req-gate',
  retryable: false,
  gate: {
    enabled: false,
    mode: 'degraded',
    reason: 'Statistics are disabled on this broker.',
    source: 'SEM-stats-off',
    fix: { actionId: 'settings.put' as ActionId, input: { name: 'stats' } },
  },
  warnings: [
    {
      id: 'W-purge-1',
      severity: 'consent',
      textKey: 'warn.purge',
      textVersion: 1,
    },
    {
      id: 'W-purge-2',
      severity: 'info',
      textKey: 'warn.other',
      textVersion: 3,
    },
  ],
};

export const notFoundProblem: Problem = {
  type: 'about:blank',
  title: 'Not found',
  status: 404,
  code: 'NOT_FOUND',
  correlationId: 'req-404',
  retryable: false,
};

const plan = {
  id: 'p1',
  actionId: 'queues.purge',
  risk: 'high',
  env: 'prod',
  gates: [],
  warnings: gateProblem.warnings,
  consentsRequired: ['W-purge-1'],
  confirmationPhrase: 'purge q1',
  approvals: { required: 0, granted: [] },
  preview: { messages: 42 },
  expiresAt: 1_800_000_000_000,
  state: 'open',
};

/** The engine behind the specs: routes by method and path. */
export const engineHandler: FakeHandler = (request) => {
  const url = new URL(request.url, 'http://engine.test');
  const route = `${request.method} ${url.pathname}`;
  switch (route) {
    case 'GET /api/v1/connections/c1/queues/q1':
      return jsonResponse(200, {
        name: 'q1',
        messages: url.searchParams.get('verbose') === 'true' ? 42 : 0,
      });
    case 'GET /api/v1/connections/c1/queues/bad':
      return jsonResponse(200, { name: 'q1', messages: 'many' });
    case 'GET /api/v1/connections/c1/queues/missing':
      return problemResponse(notFoundProblem);
    case 'POST /api/v1/connections/c1/queues/q1/purge':
      return problemResponse(
        {
          ...gateProblem,
          status: 428,
          code: 'PLAN_REQUIRED',
          title: 'A plan is required',
        },
        { location: '/api/v1/plans/p1' },
      );
    case 'POST /api/v1/connections/c1/queues/blocked/purge':
      return problemResponse(gateProblem);
    case 'POST /api/v1/connections/c1/inventory/queries':
      return jsonResponse(200, { names: ['q1', 'q2'] });
    case 'POST /api/v1/actions/queues.purge/plans':
      return jsonResponse(200, plan);
    case 'POST /api/v1/plans/p1/execute': {
      const body = JSON.parse(
        typeof request.body === 'string' ? request.body : '{}',
      ) as {
        consents: string[];
        idempotencyKey?: string;
      };
      return body.consents.length === 0
        ? problemResponse({
            ...gateProblem,
            status: 428,
            code: 'CONSENT_REQUIRED',
            title: 'Consent is required',
          })
        : jsonResponse(200, { output: { purged: 42 }, receipt: { id: 'r1' } });
    }
    case 'POST /api/v1/plans/job/execute':
      return jsonResponse(202, { jobId: 'job-1' });
    case 'POST /api/v1/jobs/j1/cancel':
      return jsonResponse(200, { state: 'cancelled' });
    case 'PUT /api/v1/settings/theme':
      return jsonResponse(200, { saved: true });
    case 'GET /api/v1/html-error':
      return {
        status: 502,
        headers: { 'content-type': 'text/html' },
        body: '<html>Bad gateway</html>',
      };
    default:
      return problemResponse({ ...notFoundProblem, detail: route });
  }
};

export interface Testbed {
  readonly engine: FakeEngine;
  readonly transport: MemoryTransport;
}

/**
 * Configures TestBed with the data layer on the in-memory fake carrier. Use `transport` option to
 * run the same spec on another carrier.
 */
export function configureTestbed(
  options: {
    readonly engine?: FakeEngineOptions;
    readonly transport?: (engine: FakeEngine) => EngineTransport;
    readonly credentials?: EngineCredentialsSource;
    readonly live?: Partial<LiveClientConfig>;
    readonly parse?: boolean;
    readonly providers?: Provider[];
  } = {},
): Testbed & { readonly carrier: EngineTransport } {
  const engine = new FakeEngine({
    handler: engineHandler,
    topics: [eventsTopic, smallEventsTopic, stateTopic],
    ...options.engine,
  });
  const memory = new MemoryTransport(engine);
  const carrier = options.transport?.(engine) ?? memory;
  TestBed.configureTestingModule({
    providers: [
      provideEngineData(
        options.live === undefined ? {} : { live: options.live },
      ),
      { provide: ENGINE_TRANSPORT, useValue: carrier },
      ...(options.credentials === undefined
        ? []
        : [{ provide: ENGINE_CREDENTIALS, useValue: options.credentials }]),
      ...(options.parse === undefined
        ? []
        : [{ provide: ENGINE_PARSE, useValue: options.parse }]),
      ...(options.providers ?? []),
    ],
  });
  return { engine, transport: memory, carrier };
}

/** The JSON body of a request the fake engine received. */
export function sentBody(
  request: { readonly body?: string | ArrayBuffer } | undefined,
): Record<string, unknown> {
  if (typeof request?.body !== 'string') {
    throw new Error('the request has no text body');
  }
  return JSON.parse(request.body) as Record<string, unknown>;
}
