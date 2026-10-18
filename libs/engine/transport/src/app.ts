// buildApp: one Fastify instance whose routes are the action registry (ADR-004, blueprint 3.3).
// It never listens: the composition root (M0-36) binds a socket, and the MessagePort tunnel
// (M0-34) injects requests. Every request passes the same hooks, in this order:
//   identify, carrier, Host/Origin, Sec-Fetch, JSON-only, authenticate, then the route.
// A route is private unless it says `config: { public: true }`, so a forgotten route is closed.
import { randomBytes } from 'node:crypto';
import { Socket } from 'node:net';

import { assertRegistry, type EngineMode, type Registry } from '@app/contracts';
import {
  createIdGenerator,
  type ActionExecutor,
  type IdGenerator,
  type Logger,
} from '@app/kernel';
import type { Principal } from '@app/ports';
import fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

import {
  CARRIER_HEADER,
  parseBearer,
  type Authenticator,
} from './auth/credentials.ts';
import { checkJsonOnly } from './guards/json-only.ts';
import { createHostPolicy } from './guards/host-origin.ts';
import { checkSecFetch } from './guards/sec-fetch.ts';
import {
  httpError,
  installProblemHandlers,
  sendProblem,
} from './problem-handler.ts';
import { registerActionRoutes } from './router.ts';
import {
  contentSecurityPolicy,
  registerStaticUi,
  type StaticUiOptions,
} from './static-ui.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Who the request acts as; null on a public route. */
    principal: Principal | null;
    correlationId: string;
    cspNonce: string;
  }
  interface FastifyContextConfig {
    /** Open to unauthenticated callers (the static UI). Absent means private. */
    public?: boolean;
  }
}

export interface TransportAuth {
  readonly mode: EngineMode;
  /** Tried in order; the first principal wins, none means 401. */
  readonly authenticators: readonly Authenticator[];
  /** Origins other than loopback this engine answers to (a reverse proxy, a published port). */
  readonly publicOrigins?: readonly string[];
}

export interface BuildAppOptions {
  readonly logger?: Logger;
  readonly ids?: IdGenerator;
  readonly ui?: StaticUiOptions;
  /** Replaces the default policy; it gets the nonce of the response. */
  readonly csp?: (nonce: string) => string;
  /** Largest JSON body in bytes. Default 1 MiB. */
  readonly bodyLimit?: number;
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function buildApp(
  registry: Registry,
  executor: ActionExecutor,
  auth: TransportAuth,
  options: BuildAppOptions = {},
): FastifyInstance {
  assertRegistry(registry);
  const ids = options.ids ?? createIdGenerator();
  const csp = options.csp ?? contentSecurityPolicy;
  const hosts = createHostPolicy(auth.publicOrigins ?? []);
  /** Headers every answer carries, the ones a framework error (a bad URL) included. */
  const stamp = (reply: FastifyReply, id: string, nonce: string): void => {
    reply.headers({
      'x-request-id': id,
      'cache-control': 'no-store',
      'content-security-policy': csp(nonce),
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
  };
  const app = fastify({
    logger: false,
    trustProxy: false,
    bodyLimit: options.bodyLimit ?? 1024 * 1024,
    requestTimeout: 30_000,
    http: { maxHeaderSize: 16 * 1024 },
    exposeHeadRoutes: false,
    // Errors Fastify finds before routing (an undecodable URL) never reach a hook.
    frameworkErrors: (error, _request, reply) => {
      const id = ids.correlationId();
      stamp(reply, id, randomBytes(16).toString('base64'));
      sendProblem(reply, error, id, options.logger);
    },
    routerOptions: { maxParamLength: 1024 },
    clientErrorHandler: (_error, socket) => {
      // The parser refused the bytes (smuggling, bad framing): answer once, then hang up.
      socket.end(
        'HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n',
      );
    },
  });
  // Only JSON has a parser: `text/plain` and forms are what a page sends without a preflight.
  app.removeContentTypeParser('text/plain');
  app.decorateRequest('principal', null);
  app.decorateRequest('correlationId', '');
  app.decorateRequest('cspNonce', '');
  installProblemHandlers(app, options.logger);

  app.addHook('onRequest', async (request, reply) => {
    const supplied = request.headers['x-request-id'];
    request.correlationId =
      typeof supplied === 'string' && REQUEST_ID.test(supplied)
        ? supplied
        : ids.correlationId();
    request.cspNonce = randomBytes(16).toString('base64');
    stamp(reply, request.correlationId, request.cspNonce);

    // A socket is the network; only an injected request (the tunnel) is in-process.
    const viaSocket = request.raw.socket instanceof Socket;
    const carrier = request.headers[CARRIER_HEADER];
    if (viaSocket && carrier !== undefined) {
      throw httpError(403, 'The carrier header is not accepted here.');
    }
    const isPublic = request.routeOptions.config.public === true;
    hosts.check(request.headers, viaSocket);
    checkSecFetch(request.headers, isPublic);
    checkJsonOnly(request.headers, request.method);
    if (isPublic) return;

    const principal = [...auth.authenticators]
      .map((authenticate) =>
        authenticate({
          // A carrier request never falls back to a bearer token.
          bearer:
            carrier === undefined
              ? parseBearer(request.headers.authorization)
              : undefined,
          carrier: typeof carrier === 'string' ? carrier : undefined,
        }),
      )
      .find((candidate) => candidate !== undefined);
    if (principal === undefined) {
      reply.header('www-authenticate', 'Bearer');
      throw httpError(401, 'Authentication required.');
    }
    request.principal = principal;
  });

  registerActionRoutes(app, registry, executor, auth.mode);
  if (options.ui !== undefined) registerStaticUi(app, options.ui, auth.mode);
  return app;
}
