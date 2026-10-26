// The wire: Node's HTTP/1.1 client over a socket the Dialer opens (I-9). Nothing here calls `net` or
// `tls`: `createConnection` asks the Dialer, which applies the egress policy, resolves the name once
// and, for an https origin, completes the TLS handshake against the profile's TrustStore trust. The
// socket the HTTP client sees is already connected and already secure, which is why requests use the
// `http:` client whatever the scheme is.
//
// A scrape is one request on one socket: no keep-alive pool. The cadence is a scrape every 15 s at
// the fastest, so a pooled socket would idle most of the time and would have to be invalidated when
// a profile changes; a fresh Dialer connection per scrape applies a changed profile at once.
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

import { PromScrapeError, errorForNetwork } from './errors.ts';

/** Why the connection is made, for the egress policy and the audit trail (net-dialer's purposes). */
export const DIAL_PURPOSE = 'prom-scrape';

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
  readonly #dialer: Dialling;
  readonly #dial: DialInfo;

  constructor(dialer: Dialling, dial: DialInfo) {
    super({ keepAlive: false, maxSockets: 1 });
    this.#dialer = dialer;
    this.#dial = dial;
  }

  override createConnection(
    _options: ClientRequestArgs,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const done = callback as
      | ((error: Error | null, stream?: Duplex) => void)
      | undefined;
    const { host, port, tls, servername, route } = this.#dial;
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

/**
 * The `Host` header of an origin. The agent's default port is 80, so left alone Node would add `:443`
 * to an https origin; here the scheme's default port is left out, any other port is kept and an IPv6
 * literal is bracketed.
 */
export function hostHeader(dial: DialInfo): string {
  const bare =
    dial.host.includes(':') && !dial.host.startsWith('[')
      ? `[${dial.host}]`
      : dial.host;
  const schemeDefault = dial.tls === undefined ? 80 : 443;
  return dial.port === schemeDefault ? bare : `${bare}:${String(dial.port)}`;
}

export interface Exchange {
  readonly status: number;
  readonly response: IncomingMessage;
  /** Turns a failure while reading the body into the right error (timeout, abort, network). */
  failure(error: unknown): PromScrapeError;
  /** Stops the deadline and releases the abort listener. Call when the body is done. */
  settle(): void;
}

export interface ExchangeRequest {
  readonly dial: DialInfo;
  readonly dialer: Dialling;
  readonly target: string;
  readonly headers: OutgoingHttpHeaders;
  readonly signal: AbortSignal;
  /** The deadline of the whole exchange, body included. */
  readonly timeoutMs: number;
}

/** Sends one GET and resolves when the response headers arrive. */
export function startExchange(request: ExchangeRequest): Promise<Exchange> {
  return new Promise<Exchange>((resolve, reject) => {
    if (request.signal.aborted) {
      reject(new PromScrapeError('aborted', 'the request was aborted'));
      return;
    }
    const agent = new DialerAgent(request.dialer, request.dial);
    let reason: 'timeout' | 'aborted' | undefined;
    let timer: NodeJS.Timeout | undefined;
    const stop = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      request.signal.removeEventListener('abort', onAbort);
      agent.destroy();
    };
    const failure = (error: unknown): PromScrapeError =>
      reason === 'timeout'
        ? new PromScrapeError(
            'timeout',
            'the metrics endpoint did not answer in time',
          )
        : reason === 'aborted'
          ? new PromScrapeError('aborted', 'the request was aborted')
          : errorForNetwork(error, 'the metrics endpoint');
    const req = httpRequest(
      {
        agent,
        host: request.dial.host,
        port: request.dial.port,
        method: 'GET',
        path: request.target,
        headers: { ...request.headers, host: hostHeader(request.dial) },
      },
      (response) => {
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
    req.end();
  });
}
