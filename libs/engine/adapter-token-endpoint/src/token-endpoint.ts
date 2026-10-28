// The token endpoint client (M1-23, CON-07, DC-37): `TokenEndpointPort` over Node's HTTP/1.1 client,
// with the socket from the Dialer (I-9). It sends one RFC 6749 4.4 client-credentials request and
// returns the access token, or a closed reason.
//
// Nothing here calls `net` or `tls`: `createConnection` asks the Dialer with the purpose `oidc`, which
// applies the egress policy, resolves the name once and, for an https issuer, completes the TLS
// handshake against the TrustStore's trust. The socket the HTTP client sees is already connected and
// secure, which is why requests use the `http:` client whatever the scheme is.
//
// The client secret is sent in the HTTP Basic `Authorization` field (RFC 6749 2.3.1) and nowhere
// else: not in the URL, not in the body, not in an error. A failure is one of the fixed reasons of the
// port: the body of the issuer's answer is never copied into it (I-10). The answer is read up to
// 64 KiB and parsed with a strict schema (I-6). A redirect is never followed, so the request cannot
// leave the host the Dialer approved. One request is one socket: no keep-alive pool, no retry.
import {
  Agent,
  request as httpRequest,
  type ClientRequestArgs,
  type IncomingMessage,
} from 'node:http';
import type { Duplex } from 'node:stream';

import type { Dialer } from '@app/net-dialer';
import {
  NetworkError,
  type TlsTrust,
  type TrustStore,
} from '@app/net-truststore';
import {
  isLoopbackAddress,
  isLoopbackHost,
  type TokenEndpointFailure,
  type TokenEndpointPort,
  type TokenRequest,
  type TokenResponse,
} from '@app/ports';

/** Why the connection is made, for the egress policy and the outbound-calls page. */
export const DIAL_PURPOSE = 'oidc';

/** The most of an answer that is read; one byte more is `too-large`. */
export const MAX_RESPONSE_BYTES = 64 * 1024;

/** The wait for the whole exchange, body included. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** The most the request fields may add up to; a client id and secret are far smaller. */
const MAX_REQUEST_FIELDS_CHARS = 16 * 1024;

/** The most CAs one request may bring (a root and a few intermediates are far fewer). */
export const MAX_TLS_CA_ENTRIES = 8;

/** The characters of a bearer token (RFC 6750 b64token), so it can sit in a header unquoted. */
const BEARER_TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;
const MAX_TOKEN_CHARS = 64 * 1024;
const TOKEN_TYPE = /^[A-Za-z][A-Za-z0-9._-]{0,31}$/;

export interface TokenEndpointOptions {
  /** The Dialer (I-9). Only `dial` is used. */
  readonly dialer: Pick<Dialer, 'dial'>;
  /**
   * The TrustStore. The trust of an https issuer is built from it for each request, from the
   * request's own CAs (`TokenRequest.tlsCa`) added to the defaults (N3, OQ-1559): nothing a request
   * brings is kept for the next one, so a CA configured for one identity provider is never used for
   * another. Only `forProfile` is used, and never with the insecure switch.
   */
  readonly trustStore: Pick<TrustStore, 'forProfile'>;
  /** The profile's route; its shape belongs to net-dialer. Default: direct. */
  readonly route?: unknown;
  /** Milliseconds for the whole exchange. Default 15,000. */
  readonly timeoutMs?: number;
}

type Dialling = Pick<Dialer, 'dial'>;

interface DialInfo {
  readonly host: string;
  readonly port: number;
  /** Present: an https issuer, verified with this trust. Absent: plain http (loopback only). */
  readonly tls: TlsTrust | undefined;
  readonly route: unknown;
  /**
   * Plain http: the connected peer must be on the loopback interface. The name in the URL proves
   * nothing (`localhost` is whatever the resolver says), so the address the socket reached decides.
   */
  readonly loopbackOnly: boolean;
}

class DialerAgent extends Agent {
  readonly #dialer: Dialling;
  readonly #target: DialInfo;

  constructor(dialer: Dialling, target: DialInfo) {
    super({ keepAlive: false, maxSockets: 1 });
    this.#dialer = dialer;
    this.#target = target;
  }

  override createConnection(
    _options: ClientRequestArgs,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const done = callback as
      | ((error: Error | null, stream?: Duplex) => void)
      | undefined;
    const { host, port, tls, route, loopbackOnly } = this.#target;
    this.#dialer
      .dial(
        {
          host,
          port,
          purpose: DIAL_PURPOSE,
          ...(tls === undefined ? {} : { tls }),
        },
        route,
      )
      .then(
        ({ socket }) => {
          if (loopbackOnly && !isLoopbackAddress(socket.remoteAddress)) {
            // Not a byte is sent: the request is written only after this callback hands over a socket.
            socket.destroy();
            done?.(
              new NetworkError(
                'EGRESS_DENIED',
                'a plain http token endpoint must be on the loopback interface',
              ),
            );
            return;
          }
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

/** RFC 6749 2.3.1: the id and the secret are form-encoded before they are joined and base64-ed. */
function formEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, '+')
    .replace(/[!'()*~]/g, (char) => {
      return `%${char.charCodeAt(0).toString(16).toUpperCase()}`;
    });
}

/** The endpoint as a URL the exchange may use, or the reason it may not. */
function checkEndpoint(
  endpoint: string,
): { ok: true; url: URL } | { ok: false; reason: TokenEndpointFailure } {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'malformed' };
  }
  // A login in the URL would be a secret in a URL (I-10).
  if (url.username !== '' || url.password !== '' || url.hostname === '') {
    return { ok: false, reason: 'malformed' };
  }
  // Plain http only for a loopback issuer (the lab); everything else must be verified TLS.
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    return { ok: false, reason: 'egress-denied' };
  }
  return { ok: true, url };
}

function failureOfNetwork(error: NetworkError): TokenEndpointFailure {
  switch (error.code) {
    case 'EGRESS_DENIED':
      return 'egress-denied';
    case 'TLS_UNTRUSTED':
      return 'tls-untrusted';
    case 'VALIDATION_FAILED':
    case 'BROKER_UNREACHABLE':
      return 'unreachable';
  }
}

function failureOfStatus(status: number): TokenEndpointFailure {
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429 || status >= 500) return 'unreachable';
  // A redirect is not followed: it would leave the host the Dialer approved.
  if (status >= 300 && status < 400) return 'malformed';
  return 'refused';
}

/**
 * The strict reading of a 200 answer (RFC 6749 5.1): `access_token` and `token_type` are required
 * strings of bounded shape, `expires_in` is a positive number or absent. Everything else is
 * ignored. The text of the answer is not kept anywhere, and a failure names no field value.
 */
export function parseTokenResponse(bytes: Uint8Array): TokenResponse {
  const bad: TokenResponse = { ok: false, reason: 'malformed' };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return bad;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return bad;
  }
  const { access_token, token_type, expires_in } = value as Record<
    string,
    unknown
  >;
  if (
    typeof access_token !== 'string' ||
    access_token.length === 0 ||
    access_token.length > MAX_TOKEN_CHARS ||
    !BEARER_TOKEN.test(access_token)
  ) {
    return bad;
  }
  if (typeof token_type !== 'string' || !TOKEN_TYPE.test(token_type)) {
    return bad;
  }
  let expiresInSeconds: number | null = null;
  if (expires_in !== undefined && expires_in !== null) {
    const seconds =
      typeof expires_in === 'string' && /^\d{1,10}$/.test(expires_in)
        ? Number(expires_in)
        : expires_in;
    if (
      typeof seconds !== 'number' ||
      !Number.isFinite(seconds) ||
      seconds <= 0
    ) {
      return bad;
    }
    expiresInSeconds = seconds;
  }
  return {
    ok: true,
    accessToken: access_token,
    expiresInSeconds,
    tokenType: token_type,
  };
}

export function createTokenEndpoint(
  options: TokenEndpointOptions,
): TokenEndpointPort {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError('timeoutMs must be a positive integer');
  }
  const route = options.route ?? { kind: 'direct' };

  /**
   * The trust for one request: the defaults of the TrustStore plus the CAs the request carries,
   * and never the insecure switch. A store that hands back a trust with verification off is
   * refused as untrusted before anything is dialled: for the purpose `oidc` the override does not
   * exist (a client secret goes to this socket).
   */
  function trustOf(
    tlsCa: readonly string[] | undefined,
  ):
    | { ok: true; trust: TlsTrust }
    | { ok: false; reason: TokenEndpointFailure } {
    const ca = tlsCa ?? [];
    if (ca.length > MAX_TLS_CA_ENTRIES) {
      return { ok: false, reason: 'malformed' };
    }
    let trust: TlsTrust;
    try {
      trust = options.trustStore.forProfile(ca.length === 0 ? {} : { ca });
    } catch {
      // A CA that does not parse (or is not text): the message is not copied (it could quote the request).
      return { ok: false, reason: 'malformed' };
    }
    if (trust.insecureOverride) return { ok: false, reason: 'tls-untrusted' };
    return { ok: true, trust };
  }

  function exchange(
    request: TokenRequest,
    signal: AbortSignal,
  ): Promise<TokenResponse> {
    const fail = (reason: TokenEndpointFailure): TokenResponse => ({
      ok: false,
      reason,
    });
    const checked = checkEndpoint(request.endpoint);
    if (!checked.ok) return Promise.resolve(fail(checked.reason));
    const { url } = checked;
    const fields =
      request.clientId.length +
      request.clientSecret.length +
      (request.scope?.length ?? 0) +
      (request.audience?.length ?? 0);
    if (request.clientId === '' || fields > MAX_REQUEST_FIELDS_CHARS) {
      return Promise.resolve(fail('malformed'));
    }
    if (signal.aborted) return Promise.resolve(fail('unreachable'));

    // The trust of this issuer only (N3). Plain http (loopback) has no TLS and needs none.
    const secure = url.protocol === 'https:';
    let tls: TlsTrust | undefined;
    if (secure) {
      const built = trustOf(request.tlsCa);
      if (!built.ok) return Promise.resolve(fail(built.reason));
      tls = built.trust;
    }

    const form = new URLSearchParams({ grant_type: 'client_credentials' });
    if (request.scope !== undefined && request.scope !== '') {
      form.set('scope', request.scope);
    }
    if (request.audience !== undefined && request.audience !== '') {
      form.set('audience', request.audience);
    }
    const body = Buffer.from(form.toString(), 'utf8');
    const login = Buffer.from(
      `${formEncode(request.clientId)}:${formEncode(request.clientSecret)}`,
      'utf8',
    ).toString('base64');
    const port = url.port === '' ? (secure ? 443 : 80) : Number(url.port);

    return new Promise<TokenResponse>((resolve) => {
      const agent = new DialerAgent(options.dialer, {
        host: url.hostname,
        port,
        tls,
        route,
        loopbackOnly: !secure,
      });
      let reason: 'timeout' | 'aborted' | undefined;
      let settled = false;
      let response: IncomingMessage | undefined;
      const finish = (result: TokenResponse): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        response?.destroy();
        req.destroy();
        agent.destroy();
        resolve(result);
      };
      const failed = (error: unknown): TokenResponse =>
        reason === 'timeout'
          ? fail('timeout')
          : reason === 'aborted'
            ? fail('unreachable')
            : fail(
                error instanceof NetworkError
                  ? failureOfNetwork(error)
                  : 'unreachable',
              );
      function onAbort(): void {
        reason ??= 'aborted';
        finish(failed(undefined));
      }

      const req = httpRequest(
        {
          agent,
          host: url.hostname,
          port,
          method: 'POST',
          path: `${url.pathname}${url.search}`,
          headers: {
            // The agent's default port is 80, so Node would add `:443` to an https Host. `url.host`
            // leaves the scheme's default port out and keeps any other, and brackets an IPv6 literal.
            host: url.host,
            accept: 'application/json',
            'accept-encoding': 'identity',
            authorization: `Basic ${login}`,
            'content-type': 'application/x-www-form-urlencoded',
            'content-length': body.length,
            connection: 'close',
          },
        },
        (answer) => {
          response = answer;
          const status = answer.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            // The body of a refusal is not read, and not copied anywhere.
            finish(fail(failureOfStatus(status)));
            return;
          }
          const declared = Number(answer.headers['content-length']);
          if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
            finish(fail('too-large'));
            return;
          }
          const type = answer.headers['content-type'];
          if (typeof type !== 'string' || !/json/i.test(type)) {
            finish(fail('malformed'));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          answer.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              finish(fail('too-large'));
              return;
            }
            chunks.push(chunk);
          });
          answer.once('end', () => {
            finish(parseTokenResponse(Buffer.concat(chunks)));
          });
          // A reset mid-body, or a socket closed before the end.
          answer.once('error', (error) => {
            finish(failed(error));
          });
          answer.once('close', () => {
            if (!answer.complete) finish(failed(undefined));
          });
        },
      );
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        reason ??= 'timeout';
        finish(failed(undefined));
      }, timeoutMs);
      // Not `once`: an error after the headers still arrives here, and an unhandled 'error' event
      // would end the process.
      req.on('error', (error) => {
        finish(failed(error));
      });
      req.end(body);
    });
  }

  return {
    async requestToken(request, signal) {
      try {
        return await exchange(request, signal);
      } catch {
        // Nothing thrown here is passed on: it could carry the request.
        return { ok: false, reason: 'unreachable' };
      }
    },
  };
}
