// createTestEngine: the real router over the real executor, with in-memory parts, for the HTTP spec
// of every action (blueprint 12). A request goes through every hook of the transport (Host, Origin,
// JSON-only, the launch token) and the whole action pipeline, so a spec sees what a client sees:
// status codes, Problems, plans, audit rows and receipts. Nothing listens on a socket: `inject`
// hands the request to Fastify in-process, which is also how the desktop tunnel delivers it.
//
// The router sends no environment class, so every call is `prod` and a mutation is locked until a
// person arms the connection (OQ-283). `arm(connectionId)` does that for the launch-token user.
import { randomBytes } from 'node:crypto';

import { registry, type Registry } from '@app/contracts';
import {
  createArmActions,
  createTestContext,
  createTestExecutor,
  type ActionImpl,
  type Authorizer,
  type ExecutorContext,
  type ExecutorWrite,
  type TestExecutor,
} from '@app/kernel';
import type { Principal } from '@app/ports';
import { buildApp, createLocalTokenAuth } from '@app/transport';

export const API = '/api/v1';

export interface TestEngineOptions {
  /** What the engine registers. A registry action without one is routed but denied. */
  actions: readonly ActionImpl[];
  /** The contract registry the routes come from. Default: the real one of `@app/contracts`. */
  registry?: Registry;
  /** Default: allow the UI principal and refuse everyone else, as a local engine does. */
  authorizer?: Authorizer;
  /** Register `ops.arm` and `ops.disarm` too, so a spec can arm over HTTP. Default false. */
  withArming?: boolean;
  /** The write ports `execute` gets, for an action that needs a scripted lease. Default: recording stubs. */
  writes?: ExecutorWrite;
}

export interface InjectRequest {
  /** Default GET. */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Below `/api/v1`, for example `/meta`. */
  path: string;
  /** A JSON body; its presence sets the content type. */
  payload?: unknown;
  headers?: Readonly<Record<string, string>>;
  /** Send the launch token. Default true. */
  authenticated?: boolean;
}

/** Fastify answers `inject` with a light-my-request response; this is its type, inferred. */
async function send(
  app: ReturnType<typeof buildApp>,
  request: InjectRequest,
  token: string,
) {
  const headers: Record<string, string> = {
    ...(request.authenticated === false
      ? {}
      : { authorization: `Bearer ${token}` }),
    ...(request.payload === undefined
      ? {}
      : { 'content-type': 'application/json' }),
    ...request.headers,
  };
  return app.inject({
    method: request.method ?? 'GET',
    url: `${API}${request.path}`,
    headers,
    ...(request.payload === undefined
      ? {}
      : { payload: JSON.stringify(request.payload) }),
  });
}

export type TestResponse = Awaited<ReturnType<typeof send>>;

export interface TestEngine extends TestExecutor {
  readonly app: ReturnType<typeof buildApp>;
  /** The launch token of this engine: 256 random bits, fresh for every engine, never a constant. */
  readonly token: string;
  /** Who the launch token stands for. */
  readonly principal: Principal;
  inject(request: InjectRequest): Promise<TestResponse>;
  /** Arms a connection for the launch-token user, as `ops.arm` would (15 minutes of the test clock). */
  arm(connectionId: string): void;
  /** A context for calling the executor directly as the launch-token user, with the router's defaults. */
  context(overrides?: Partial<ExecutorContext>): ExecutorContext;
  close(): Promise<void>;
}

export function createTestEngine(options: TestEngineOptions): TestEngine {
  const parts = createTestExecutor({
    ...(options.authorizer === undefined && options.writes === undefined
      ? {}
      : {
          executor: {
            ...(options.authorizer === undefined
              ? {}
              : { authorizer: options.authorizer }),
            ...(options.writes === undefined ? {} : { writes: options.writes }),
          },
        }),
  });
  parts.executor.register(
    ...options.actions,
    ...(options.withArming === true ? createArmActions(parts.arming) : []),
  );

  // A fresh secret per engine: a spec that listens on a socket exposes nothing that is guessable.
  const token = randomBytes(32).toString('base64url');
  const authenticate = createLocalTokenAuth(token);
  const principal = authenticate({ bearer: token, carrier: undefined });
  if (principal === undefined) {
    throw new Error('the launch token does not authenticate');
  }

  const app = buildApp(options.registry ?? registry, parts.executor, {
    mode: 'local',
    authenticators: [authenticate],
  });

  return {
    ...parts,
    app,
    token,
    principal,
    inject: (request) => send(app, request, token),
    arm: (connectionId) => {
      parts.arming.arm(principal, connectionId);
    },
    context: (overrides = {}) =>
      // No `env`: the router sends none either, so a plan made over HTTP executes under the same class.
      ({
        ...createTestContext({ principal, mode: 'local' }),
        env: undefined,
        ...overrides,
      }),
    close: () => app.close(),
  };
}
