// The wire: Node's HTTP/1.1 client over sockets that the Dialer opens (I-9). Nothing here calls
// `net` or `tls`: the agent's `createConnection` asks the Dialer, which applies the egress policy,
// resolves the name once and, for an https origin, completes the TLS handshake against the
// profile's TrustStore trust. The socket the HTTP client sees is therefore already connected and
// already secure, which is why requests use the `http:` client whatever the scheme is.
//
// The same module owns the keep-alive agents: one per connection profile, at most `MAX_AGENTS`
// at a time (I-6), each with a small socket cap. The BrokerScheduler caps the concurrency above
// this, so the agent cap is a second line of defence, not the scheduler.
import {
  Agent,
  request as httpRequest,
  type ClientRequestArgs,
  type IncomingMessage,
  type OutgoingHttpHeaders,
} from 'node:http';
import type { Duplex } from 'node:stream';

import type { Dialer } from '@app/net-dialer';
import type { TlsTrust } from '@app/net-truststore';

import { MgmtHttpError, errorForNetwork } from './errors.ts';

/** Why the connection is made, for the egress policy and the audit trail. */
export const DIAL_PURPOSE = 'mgmt-http';

/** Where to connect: everything the Dialer needs, nothing about credentials. */
export interface DialInfo {
  readonly host: string;
  readonly port: number;
  /** Present: an https origin, verified with this trust. Absent: plain http. */
  readonly tls?: TlsTrust;
  /** The name to verify and send as SNI when the profile's trust has no override. */
  readonly servername?: string;
  /** The profile's route; its shape belongs to net-dialer. */
  readonly route: unknown;
}

type Dialling = Pick<Dialer, 'dial'>;

class DialerAgent extends Agent {
  dialInfo: DialInfo;
  readonly #dialer: Dialling;

  constructor(dialer: Dialling, dialInfo: DialInfo, maxSockets: number) {
    super({
      keepAlive: true,
      maxSockets,
      maxFreeSockets: 2,
      scheduling: 'fifo',
    });
    this.#dialer = dialer;
    this.dialInfo = dialInfo;
  }

  override createConnection(
    _options: ClientRequestArgs,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const done = callback as
      | ((error: Error | null, stream?: Duplex) => void)
      | undefined;
    const { host, port, tls, servername, route } = this.dialInfo;
    this.#dialer
      .dial(
        {
          host,
          port,
          purpose: DIAL_PURPOSE,
          ...(servername === undefined ? {} : { servername }),
          ...(tls === undefined ? {} : { tls }),
        },
        route,
      )
      .then(
        ({ socket }) => {
          done?.(null, socket);
        },
        (error: unknown) => {
          done?.(error instanceof Error ? error : new Error(String(error)));
        },
      );
    // The socket arrives through the callback.
    return undefined;
  }
}

/** Keep-alive agents by connection profile, least recently used out first (I-6). */
export class AgentPool {
  static readonly MAX_AGENTS = 64;
  readonly #dialer: Dialling;
  readonly #maxSockets: number;
  readonly #byConnection = new Map<string, DialerAgent>();

  constructor(dialer: Dialling, maxSockets: number) {
    this.#dialer = dialer;
    this.#maxSockets = maxSockets;
  }

  /** The agent of a connection; new sockets use `dial`, so a changed profile applies at once. */
  agentFor(connectionId: string, dial: DialInfo): Agent {
    let agent = this.#byConnection.get(connectionId);
    if (agent === undefined) {
      agent = new DialerAgent(this.#dialer, dial, this.#maxSockets);
    } else {
      agent.dialInfo = dial;
      this.#byConnection.delete(connectionId);
    }
    this.#byConnection.set(connectionId, agent);
    const oldest = this.#byConnection.keys().next();
    if (this.#byConnection.size > AgentPool.MAX_AGENTS && !oldest.done) {
      this.invalidate(oldest.value);
    }
    return agent;
  }

  /** Closes the idle sockets of a connection, for example after its credentials or CA changed. */
  invalidate(connectionId: string): void {
    const agent = this.#byConnection.get(connectionId);
    this.#byConnection.delete(connectionId);
    agent?.destroy();
  }

  close(): void {
    for (const agent of this.#byConnection.values()) agent.destroy();
    this.#byConnection.clear();
  }

  get size(): number {
    return this.#byConnection.size;
  }
}

export interface Exchange {
  readonly status: number;
  readonly response: IncomingMessage;
  /** Turns a failure while reading the body into the right error (timeout, abort, network). */
  failure(error: unknown): MgmtHttpError;
  /** Stops the deadline and releases the abort listener. Call when the body is done. */
  settle(): void;
}

export interface ExchangeRequest {
  readonly agent: Agent;
  readonly host: string;
  readonly port: number;
  readonly method: 'GET' | 'PUT' | 'POST' | 'DELETE';
  readonly target: string;
  readonly headers: OutgoingHttpHeaders;
  readonly body?: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  /** `true`: the deadline covers the whole body. `false`: it ends when the headers arrive. */
  readonly deadlineCoversBody: boolean;
}

/** Sends one request and resolves when the response headers arrive. */
export function startExchange(request: ExchangeRequest): Promise<Exchange> {
  return new Promise<Exchange>((resolve, reject) => {
    if (request.signal.aborted) {
      reject(new MgmtHttpError('aborted', 'the request was aborted'));
      return;
    }
    let reason: 'timeout' | 'aborted' | undefined;
    let timer: NodeJS.Timeout | undefined;
    const clearDeadline = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const stop = (): void => {
      clearDeadline();
      request.signal.removeEventListener('abort', onAbort);
    };
    const failure = (error: unknown): MgmtHttpError =>
      reason === 'timeout'
        ? new MgmtHttpError(
            'timeout',
            'the management API did not answer in time',
          )
        : reason === 'aborted'
          ? new MgmtHttpError('aborted', 'the request was aborted')
          : errorForNetwork(error, 'the management API');
    const req = httpRequest(
      {
        agent: request.agent,
        host: request.host,
        port: request.port,
        method: request.method,
        path: request.target,
        headers: request.headers,
      },
      (response) => {
        if (!request.deadlineCoversBody) clearDeadline();
        response.once('close', stop);
        resolve({
          status: response.statusCode ?? 0,
          response,
          failure,
          settle: stop,
        });
      },
    );
    function onAbort(): void {
      reason ??= 'aborted';
      req.destroy();
    }
    request.signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      reason ??= 'timeout';
      req.destroy();
    }, request.timeoutMs);
    // Not `once`: an error after the headers (a reset mid-body) still arrives here, and an
    // unhandled 'error' event would end the process. The body reader sees it on the response.
    req.on('error', (error) => {
      stop();
      reject(failure(error));
    });
    req.end(request.body);
  });
}
