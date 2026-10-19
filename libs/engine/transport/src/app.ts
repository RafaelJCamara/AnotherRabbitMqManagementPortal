// buildApp: one Fastify instance whose routes are the action registry (ADR-004, blueprint 3.3).
// It never listens: the composition root (M0-36) binds a socket, and the MessagePort tunnel
// (M0-34) injects requests. Every request passes the same hooks, in this order:
//   identify, carrier, Host/Origin, Sec-Fetch, JSON-only, authenticate, then the route.
// A route is private unless it says `config: { public: true }`, so a forgotten route is closed.
import { randomBytes } from 'node:crypto';
import { Socket } from 'node:net';

import { assertRegistry, type Registry } from '@app/contracts';
import {
  createIdGenerator,
  type ActionExecutor,
  type IdGenerator,
  type Logger,
} from '@app/kernel';
import type { Principal } from '@app/ports';
import fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

import { createAdmission, type TransportAuth } from './auth/admission.ts';
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
import { registerLive, type LiveEndpoint } from './ws/upgrade.ts';

export type { TransportAuth };

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

export interface BuildAppOptions {
  readonly logger?: Logger;
  readonly ids?: IdGenerator;
  readonly ui?: StaticUiOptions;
  /** Replaces the default policy; it gets the nonce of the response. */
  readonly csp?: (nonce: string) => string;
  /** Largest JSON body in bytes. Default 1 MiB. */
  readonly bodyLimit?: number;
  /** Serves the live WebSocket (/api/v1/live) and its tickets from this hub. */
  readonly live?: LiveEndpoint;
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
  const admission = createAdmission(auth);
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

    const isPublic = request.routeOptions.config.public === true;
    // A socket is the network; only an injected request (the tunnel) is in-process.
    const viaSocket = request.raw.socket instanceof Socket;
    admission.guard(request.headers, request.method, viaSocket, isPublic);
    if (isPublic) return;

    const principal = admission.authenticate(request.headers);
    if (principal === undefined) {
      reply.header('www-authenticate', 'Bearer');
      throw httpError(401, 'Authentication required.');
    }
    request.principal = principal;
  });

  registerActionRoutes(app, registry, executor, auth.mode);
  if (options.live !== undefined) registerLive(app, options.live, admission);
  if (options.ui !== undefined) registerStaticUi(app, options.ui, auth.mode);
  return app;
}
