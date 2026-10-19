// Test support for the transport specs: a small registry, executor-backed actions that count how
// often they ran, and helpers for real TCP requests on an ephemeral loopback port (a test-only
// listener; `buildApp` itself never listens). Not part of the public API and not part of the kit.
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defineAction,
  registry,
  type ActionDef,
  type Registry,
} from '@app/contracts';
import {
  createLogger,
  createTestExecutor,
  createTestPrincipal,
  implementAction,
  type LogSink,
  type TestExecutor,
} from '@app/kernel';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { buildApp, type BuildAppOptions } from '../app.ts';
import { createCarrierAuth } from '../auth/carrier.ts';
import type { Authenticator } from '../auth/credentials.ts';
import { createLocalTokenAuth } from '../auth/local-token.ts';

/** 43 characters of base64url, like a real 256-bit launch token. */
export const TOKEN = 'tok_8Qe3vX1mZp0LrYb7NcWk2HdSgA5JfUoTiEqVxMn4B6';
export const CARRIER = 'car_4Zt9KwE2yQrB7HsLpXc1VdNgMu6JfAoTiYqW0Rn3S8';
export const LOG_CANARY = 'canary-do-not-log-3f9a1c';

const probeDef = defineAction({
  id: 'connections.probe',
  kind: 'query',
  summary: 'Probe a connection',
  input: z.strictObject({
    cid: z.string().min(1).max(64),
    timeoutMs: z.number().int().positive().optional(),
  }),
  output: z.strictObject({
    ok: z.boolean(),
    cid: z.string(),
    principal: z.string(),
  }),
  permission: 'connection.view',
  risk: 'none',
  planning: 'none',
  audit: 'none',
  target: () => ({}),
  http: { method: 'POST', path: '/connections/{cid}/ping' },
  since: '1.0',
});

const listDef = defineAction({
  id: 'queues.list',
  kind: 'query',
  summary: 'List queues',
  input: z.strictObject({
    cid: z.string().min(1).max(64),
    limit: z.number().int().positive().max(1000).optional(),
    names: z.array(z.string()).optional(),
    deep: z.boolean().optional(),
  }),
  output: z.unknown(),
  permission: 'broker.read',
  risk: 'none',
  planning: 'none',
  audit: 'none',
  target: () => ({}),
  http: { method: 'GET', path: '/connections/{cid}/queues' },
  since: '1.0',
});

const purgeDef = defineAction({
  id: 'queues.purge',
  kind: 'command',
  summary: 'Purge a queue',
  input: z.strictObject({ cid: z.string(), qkey: z.string() }),
  output: z.strictObject({ purged: z.number() }),
  permission: 'messages.purge',
  risk: 'critical',
  planning: 'required',
  audit: 'attempt+outcome',
  target: (input) => ({ connectionId: input.cid as never }),
  http: { method: 'POST', path: '/connections/{cid}/queues/{qkey}/purge' },
  since: '1.0',
});

const renameDef = defineAction({
  id: 'queues.rename',
  kind: 'command',
  summary: 'Rename a queue label',
  input: z.strictObject({ cid: z.string(), label: z.string() }),
  output: z.strictObject({ label: z.string() }),
  permission: 'topology.admin',
  risk: 'low',
  planning: 'none',
  audit: 'attempt+outcome',
  target: (input) => ({ connectionId: input.cid as never }),
  http: { method: 'PUT', path: '/connections/{cid}/label' },
  since: '1.0',
});

const failDef = defineAction({
  id: 'debug.fail',
  kind: 'query',
  summary: 'Always fails with an unexpected error',
  input: z.strictObject({}),
  output: z.unknown(),
  permission: 'meta.read',
  risk: 'none',
  planning: 'none',
  audit: 'none',
  target: () => ({}),
  http: { method: 'GET', path: '/debug/fail' },
  since: '1.0',
});

const hangDef = defineAction({
  id: 'debug.hang',
  kind: 'query',
  summary: 'Waits until it is aborted',
  input: z.strictObject({}),
  output: z.unknown(),
  permission: 'meta.read',
  risk: 'none',
  planning: 'none',
  audit: 'none',
  target: () => ({}),
  http: { method: 'GET', path: '/debug/hang' },
  since: '1.0',
});

/** An action that is in the registry but was never registered with the executor. */
const orphanDef = defineAction({
  id: 'debug.orphan',
  kind: 'query',
  summary: 'Declared, not implemented',
  input: z.strictObject({}),
  output: z.unknown(),
  permission: 'meta.read',
  risk: 'none',
  planning: 'none',
  audit: 'none',
  target: () => ({}),
  http: { method: 'GET', path: '/debug/orphan' },
  since: '1.0',
});

export const testRegistry: Registry = {
  actions: [
    ...registry.actions,
    probeDef,
    listDef,
    purgeDef,
    renameDef,
    failDef,
    hangDef,
    orphanDef,
  ],
  topics: [],
};

const metaDef = ((): ActionDef => {
  const found = registry.actions.find((action) => action.id === 'meta.get');
  if (found === undefined) throw new Error('meta.get is not registered');
  return found;
})();

export interface Calls {
  probe: number;
  purge: number;
  rename: number;
  meta: number;
  lastList: unknown;
  aborted: boolean;
  started: boolean;
}

export interface Harness {
  app: FastifyInstance;
  engine: TestExecutor;
  calls: Calls;
  logLines: string[];
}

export function createHarness(
  options: BuildAppOptions & {
    publicOrigins?: string[];
    withCarrier?: boolean;
    authenticators?: Authenticator[];
  } = {},
): Harness {
  const calls: Calls = {
    probe: 0,
    purge: 0,
    rename: 0,
    meta: 0,
    lastList: undefined,
    aborted: false,
    started: false,
  };
  const engine = createTestExecutor();
  // The router sends no environment class, so every call is prod (ADR-006) and its mutations are
  // locked until a person arms the connection. These specs are about routing, not the lock: the two
  // people the carrier and the launch token stand for have armed the connection they use.
  for (const id of ['local-token', 'desktop-user']) {
    engine.arming.arm(
      createTestPrincipal({
        id,
        kind: id === 'local-token' ? 'local-token' : 'desktop-user',
      }),
      'c1',
    );
  }
  const executorBody = {
    meta: implementAction(metaDef, {
      execute: () => {
        calls.meta += 1;
        return Promise.resolve({
          engineVersion: '0.0.0-test',
          apiVersion: 'v1' as const,
          mode: 'local' as const,
        });
      },
    }),
  };
  engine.executor.register(
    executorBody.meta,
    implementAction(probeDef, {
      execute: (input, ctx) => {
        calls.probe += 1;
        return Promise.resolve({
          ok: true,
          cid: input.cid,
          principal: ctx.principal.kind,
        });
      },
    }),
    implementAction(listDef, {
      execute: (input) => {
        calls.lastList = input;
        return Promise.resolve(input);
      },
    }),
    implementAction(purgeDef, {
      plan: () =>
        Promise.resolve({
          preview: {},
          gates: [],
          warnings: [],
          consentsRequired: [],
        }),
      revalidate: () => Promise.resolve('valid' as const),
      execute: () => {
        calls.purge += 1;
        return Promise.resolve({ purged: 0 });
      },
    }),
    implementAction(renameDef, {
      plan: () =>
        Promise.resolve({
          preview: {},
          gates: [],
          warnings: [],
          consentsRequired: [],
        }),
      revalidate: () => Promise.resolve('valid' as const),
      execute: (input) => {
        calls.rename += 1;
        return Promise.resolve({ label: input.label });
      },
    }),
    implementAction(failDef, {
      execute: () => Promise.reject(new Error(`boom ${LOG_CANARY}`)),
    }),
    implementAction(hangDef, {
      execute: (_input, ctx) =>
        new Promise((resolve) => {
          calls.started = true;
          ctx.signal.addEventListener('abort', () => {
            calls.aborted = true;
            resolve({});
          });
        }),
    }),
  );
  const logLines: string[] = [];
  const sink: LogSink = { write: (line) => void logLines.push(line) };
  const app = buildApp(
    testRegistry,
    engine.executor,
    {
      mode: 'local',
      authenticators: options.authenticators ?? [
        createLocalTokenAuth(TOKEN),
        ...(options.withCarrier === false ? [] : [createCarrierAuth(CARRIER)]),
      ],
      ...(options.publicOrigins === undefined
        ? {}
        : { publicOrigins: options.publicOrigins }),
    },
    { logger: createLogger({ sink, level: 'debug' }), ...options },
  );
  return { app, engine, calls, logLines };
}

// ---------------------------------------------------------------------------------------------
// Real requests over a loopback socket
// ---------------------------------------------------------------------------------------------

export interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json: () => Record<string, unknown>;
}

export interface Listening {
  port: number;
}

export async function listen(app: FastifyInstance): Promise<Listening> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('no TCP address');
  }
  return { port: address.port };
}

export interface Send {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Send the Host a browser on this port would send. On by default. */
  defaultHost?: boolean;
}

/** One request over TCP. Header names and values are sent as given (no browser rules). */
export function tcp(server: Listening, send: Send): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      ...(send.defaultHost === false
        ? {}
        : { host: `127.0.0.1:${String(server.port)}` }),
      ...send.headers,
    };
    if (send.body !== undefined) {
      headers['content-length'] ??= String(Buffer.byteLength(send.body));
    }
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: server.port,
        method: send.method ?? 'GET',
        path: send.path,
        headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: () => JSON.parse(body) as Record<string, unknown>,
          });
        });
      },
    );
    req.on('error', reject);
    req.end(send.body);
  });
}

export const bearer = (token = TOKEN): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

export const jsonHeaders = (
  extra: Record<string, string> = {},
): Record<string, string> => ({
  ...bearer(),
  'content-type': 'application/json',
  ...extra,
});

/** Raw bytes in, whatever the server writes back out (for requests Node's client would not send). */
export function raw(server: Listening, bytes: string): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const socket: Socket = connect({ host: '127.0.0.1', port: server.port });
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('connect', () => socket.write(bytes));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    // A server that hangs up on a refused request may reset the connection; what it wrote counts.
    socket.on('error', () => undefined);
    socket.on('close', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

// ---------------------------------------------------------------------------------------------
// A UI build on disk: N, N-1, and files outside both that no request may reach
// ---------------------------------------------------------------------------------------------

export const SECRET = 'secret-outside-the-asset-directories';

export interface UiFixture {
  readonly newest: string;
  readonly previous: string;
  readonly base: string;
  /** False when the platform would not create the directory link used by the symlink test. */
  readonly linked: boolean;
  cleanup(): void;
}

export function createUiFixture(): UiFixture {
  const base = mkdtempSync(join(tmpdir(), 'transport-ui-'));
  const newest = join(base, 'n');
  const previous = join(base, 'n1');
  const outside = join(base, 'outside');
  for (const dir of [newest, join(newest, 'assets'), previous, outside]) {
    mkdirSync(dir, { recursive: true });
  }
  const html = (label: string): string =>
    '<!doctype html><html><head>' +
    '<meta name="csp-nonce" content="__CSP_NONCE__"></head>' +
    '<body ngCspNonce="__CSP_NONCE__">' +
    label +
    '</body></html>';
  const files: Record<string, string> = {
    [join(newest, 'index.html')]: html('N-INDEX'),
    [join(newest, 'main-ABCD1234.js')]: 'N-main',
    [join(newest, 'shared.js')]: 'N-shared',
    [join(newest, 'styles.css')]: 'body{}',
    [join(newest, 'data.bin')]: 'bytes',
    [join(newest, 'assets', 'logo.svg')]:
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    [join(newest, '.env')]: SECRET,
    [join(previous, 'index.html')]: html('OLD-INDEX'),
    [join(previous, 'shared.js')]: 'OLD-shared',
    [join(previous, 'chunk-OLDCHUNK1.js')]: 'OLD-chunk',
    [join(outside, 'secret.txt')]: SECRET,
    [join(base, 'secret.txt')]: SECRET,
  };
  for (const [file, text] of Object.entries(files)) writeFileSync(file, text);
  let linked = true;
  try {
    symlinkSync(outside, join(newest, 'linked'), 'junction');
  } catch {
    linked = false;
  }
  return {
    newest,
    previous,
    base,
    linked,
    cleanup: () => {
      rmSync(base, { recursive: true, force: true });
    },
  };
}
