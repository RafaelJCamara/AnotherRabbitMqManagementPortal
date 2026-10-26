// The client-credentials provider (RFC 6749 4.4, CON-07): the profile stores a client secret sealed;
// each acquisition asks the configured token endpoint for an access token. The endpoint is reached
// only through `TokenEndpointPort` (this service imports no adapter and no socket library, I-9), and
// the secret crosses that port as the argument of the one call that needs it (I-10).
//
// A failure ends in a Problem whose text is fixed per reason: it holds no secret, no client id, no
// endpoint URL and no text from the issuer's answer. The wait is bounded here as well as in the
// adapter, so a port that never answers does not hold the TokenManager.
import { AppError, type Clock } from '@app/kernel';
import type {
  StoredLoginPort,
  TokenEndpointFailure,
  TokenEndpointPort,
  TokenResponse,
} from '@app/ports';

import { bearerCredential } from '../internal/bearer';
import type { CredentialProvider, ProviderConfig } from '../provider';

type ClientCredentialsConfig = Extract<
  ProviderConfig,
  { kind: 'client-credentials' }
>;

/** The longest this provider waits for the port (the adapter's own deadline is shorter). */
export const TOKEN_REQUEST_TIMEOUT_MS = 20_000;

const FAILURE: Readonly<
  Record<TokenEndpointFailure, { code: AppError['code']; detail: string }>
> = {
  refused: {
    code: 'UNAUTHENTICATED',
    detail: 'The identity provider refused the client credentials.',
  },
  unreachable: {
    code: 'BROKER_UNREACHABLE',
    detail: 'The token endpoint could not be reached.',
  },
  timeout: {
    code: 'BROKER_UNREACHABLE',
    detail: 'The token endpoint did not answer in time.',
  },
  'egress-denied': {
    code: 'EGRESS_DENIED',
    detail: 'The network policy does not allow a call to the token endpoint.',
  },
  'tls-untrusted': {
    code: 'TLS_UNTRUSTED',
    detail: 'The certificate of the token endpoint is not trusted.',
  },
  malformed: {
    code: 'BROKER_ERROR',
    detail:
      'The token endpoint answered with something that is not a token response.',
  },
  'too-large': {
    code: 'BROKER_ERROR',
    detail: 'The answer of the token endpoint is larger than allowed.',
  },
};

const fixed = (reason: TokenEndpointFailure): AppError =>
  new AppError(FAILURE[reason].code, { detail: FAILURE[reason].detail });

/**
 * Asks the port and gives up when `signal` aborts or `timeoutMs` pass, whatever the port does. A
 * port that rejects is reported as `unreachable` with nothing it said: its error could carry the
 * request.
 */
async function ask(
  port: TokenEndpointPort,
  request: Parameters<TokenEndpointPort['requestToken']>[0],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<TokenResponse> {
  const control = new AbortController();
  const joined = AbortSignal.any([signal, control.signal]);
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const ended = new Promise<TokenResponse>((resolve) => {
    onAbort = () => {
      resolve({
        ok: false,
        reason: signal.aborted ? 'unreachable' : 'timeout',
      });
    };
    joined.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      control.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => port.requestToken(request, joined))().catch(
        (): TokenResponse => ({ ok: false, reason: 'unreachable' }),
      ),
      ended,
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) joined.removeEventListener('abort', onAbort);
    control.abort();
  }
}

export function createClientCredentialsProvider(deps: {
  readonly config: ClientCredentialsConfig;
  readonly stored: StoredLoginPort;
  readonly endpoint: TokenEndpointPort;
  readonly clock: Clock;
  /** Default `TOKEN_REQUEST_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}): CredentialProvider {
  const { config } = deps;
  const timeoutMs = deps.timeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS;
  return {
    kind: 'client-credentials',
    async acquire({ connectionId, protocol }, signal) {
      let login: Awaited<ReturnType<StoredLoginPort['open']>>;
      try {
        login = await deps.stored.open(connectionId, protocol);
      } catch {
        // No `cause`: what the vault or the store said stays out of the error (I-10).
        throw new AppError('INTERNAL', {
          detail: 'The stored credential could not be read.',
        });
      }
      if (login.kind === 'locked') {
        throw new AppError('GATE_BLOCKED', {
          detail:
            'The stored client secret cannot be opened: the credential vault is locked, or the credential was stored under another key.',
        });
      }
      if (login.kind === 'absent') {
        throw new AppError('NOT_FOUND', {
          detail:
            'No client secret is stored for this connection and protocol.',
        });
      }
      const response = await ask(
        deps.endpoint,
        {
          endpoint: config.endpoint,
          clientId: config.clientId,
          clientSecret: login.secret,
          ...(config.scope === undefined ? {} : { scope: config.scope }),
          ...(config.audience === undefined
            ? {}
            : { audience: config.audience }),
        },
        signal,
        timeoutMs,
      );
      if (signal.aborted) {
        throw new AppError('BROKER_UNREACHABLE', {
          detail: 'The token request was cancelled.',
        });
      }
      if (!response.ok) throw fixed(response.reason);
      if (response.tokenType.toLowerCase() !== 'bearer') {
        throw new AppError('BROKER_ERROR', {
          detail:
            'The token endpoint issued a token that is not a bearer token.',
        });
      }
      return bearerCredential({
        token: response.accessToken,
        usernameClaims: config.usernameClaims,
        clock: deps.clock,
        expiresInSeconds: response.expiresInSeconds,
        requireExpiry: false,
      });
    },
  };
}
