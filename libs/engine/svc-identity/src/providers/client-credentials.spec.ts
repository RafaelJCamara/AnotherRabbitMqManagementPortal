// M1-23 slice B: the client-credentials provider (AC-6, AC-7), driven through a fake
// `TokenEndpointPort` and a fake vault, with the kernel's manual clock.
import { AppError, createManualClock, toProblem } from '@app/kernel';
import type {
  StoredLoginPort,
  TokenEndpointPort,
  TokenRequest,
  TokenResponse,
} from '@app/ports';
import { describe, expect, it } from 'vitest';

import { ProviderConfigSchema } from '../provider';

import { createClientCredentialsProvider } from './client-credentials';

const NOW = 1_700_000_000_000;
const clock = createManualClock(NOW);
const signal = new AbortController().signal;
const SECRET = 'cs-AC6-Vx8mK2pQ4wRt';
const ENDPOINT =
  'https://idp.example.test/realms/lab/protocol/openid-connect/token';

const b64 = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims: Record<string, unknown>): string =>
  `${b64({ alg: 'RS256' })}.${b64(claims)}.c2ln`;

const config = (overrides: Record<string, unknown> = {}) => {
  const parsed = ProviderConfigSchema.parse({
    kind: 'client-credentials',
    endpoint: ENDPOINT,
    clientId: 'engine-client',
    scope: 'rabbitmq.read',
    audience: 'rabbitmq',
    ...overrides,
  });
  if (parsed.kind !== 'client-credentials') throw new Error('unreachable');
  return parsed;
};

const stored = (
  result:
    | { kind: 'found'; username: string | null; secret: string }
    | { kind: 'locked' }
    | { kind: 'absent' } = { kind: 'found', username: null, secret: SECRET },
): StoredLoginPort => ({ open: () => Promise.resolve(result) });

/** A fake endpoint that records each request and answers with `respond`. */
function fakeEndpoint(
  respond: (
    request: TokenRequest,
    signal: AbortSignal,
  ) => Promise<TokenResponse> | TokenResponse,
) {
  const calls: { request: TokenRequest; signal: AbortSignal }[] = [];
  const port: TokenEndpointPort = {
    requestToken: (request, requestSignal) => {
      calls.push({ request, signal: requestSignal });
      return Promise.resolve(respond(request, requestSignal));
    },
  };
  return { port, calls };
}

const ok = (
  accessToken: string,
  expiresInSeconds: number | null = 300,
  tokenType = 'Bearer',
): TokenResponse => ({ ok: true, accessToken, expiresInSeconds, tokenType });

const acquire = (
  endpoint: TokenEndpointPort,
  options: { timeoutMs?: number; stored?: StoredLoginPort } = {},
  abort: AbortSignal = signal,
) =>
  createClientCredentialsProvider({
    config: config(),
    stored: options.stored ?? stored(),
    endpoint,
    clock,
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  }).acquire({ connectionId: 'c1', protocol: 'amqp' }, abort);

async function failure(attempt: Promise<unknown>): Promise<AppError> {
  try {
    await attempt;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected the provider to reject');
}

describe('client credentials provider', () => {
  it('M1-23 AC-6 client credentials provider requests one token and keeps the secret out of the URL', async () => {
    const token = jwt({ sub: 'engine-client', iat: NOW / 1000 });
    const endpoint = fakeEndpoint(() => ok(token, 300));

    const issued = await acquire(endpoint.port);

    // One request, the RFC 6749 4.4 fields, the secret as `clientSecret` and nowhere else.
    expect(endpoint.calls).toHaveLength(1);
    const { request } = endpoint.calls[0] ?? { request: undefined };
    expect(request).toEqual({
      endpoint: ENDPOINT,
      clientId: 'engine-client',
      clientSecret: SECRET,
      scope: 'rabbitmq.read',
      audience: 'rabbitmq',
    });
    expect(request?.endpoint).not.toContain(SECRET);
    expect(request?.endpoint).not.toContain('engine-client');
    // The lifetime is issued time + expires_in, and the user name is read from the access token.
    expect(issued.kind).toBe('bearer');
    if (issued.kind !== 'bearer') throw new Error('unreachable');
    expect(issued.token.reveal()).toBe(token);
    expect(issued.issuedAt).toBe(NOW);
    expect(issued.expiresAt).toBe(NOW + 300_000);
    expect(issued.username).toBe('engine-client');
    expect(String(issued.token)).toBe('[secret]');
  });

  it('M1-23 AC-7 client credentials failures are bounded Problems that never echo the endpoint body', async () => {
    const BODY = 'ECHO-issuer-body-Hq3tY7nB1c';
    const reasons = [
      ['refused', 'UNAUTHENTICATED'],
      ['unreachable', 'BROKER_UNREACHABLE'],
      ['timeout', 'BROKER_UNREACHABLE'],
      ['egress-denied', 'EGRESS_DENIED'],
      ['tls-untrusted', 'TLS_UNTRUSTED'],
      ['malformed', 'BROKER_ERROR'],
      ['too-large', 'BROKER_ERROR'],
    ] as const;
    const seen: AppError[] = [];
    for (const [reason, code] of reasons) {
      // The fake carries a "body" in every shape a port could leak it in.
      const endpoint = fakeEndpoint(
        () => ({ ok: false, reason, body: BODY }) as TokenResponse,
      );
      const error = await failure(acquire(endpoint.port));
      expect(error.code, reason).toBe(code);
      seen.push(error);
    }
    // Answers that are ok but unusable: not a bearer token, no readable token.
    const wrongType = await failure(
      acquire(fakeEndpoint(() => ok(jwt({ sub: 'a' }), 300, 'MAC')).port),
    );
    expect(wrongType.code).toBe('BROKER_ERROR');
    const noToken = await failure(
      acquire(fakeEndpoint(() => ok('', 300)).port),
    );
    expect(noToken.code).toBe('VALIDATION_FAILED');
    seen.push(wrongType, noToken);
    // A port that rejects with the body, throws at once, or hands back an error with a cause.
    const rejects = fakeEndpoint(() => {
      throw new Error(`${BODY} ${SECRET}`, { cause: new Error(SECRET) });
    });
    const rejected = await failure(acquire(rejects.port));
    expect(rejected.code).toBe('BROKER_UNREACHABLE');
    const sync = await failure(
      acquire({
        requestToken: () => {
          throw new Error(`${BODY} ${SECRET}`);
        },
      }),
    );
    expect(sync.code).toBe('BROKER_UNREACHABLE');
    seen.push(rejected, sync);
    // The vault: a locked or empty store never reaches the endpoint.
    const idle = fakeEndpoint(() => ok(jwt({ sub: 'a' })));
    const locked = await failure(
      acquire(idle.port, { stored: stored({ kind: 'locked' }) }),
    );
    const absent = await failure(
      acquire(idle.port, { stored: stored({ kind: 'absent' }) }),
    );
    expect([locked.code, absent.code]).toEqual(['GATE_BLOCKED', 'NOT_FOUND']);
    expect(idle.calls).toHaveLength(0);
    seen.push(locked, absent);

    // Never answers: the wait is bounded, the port's signal is aborted, and the Problem is fixed.
    const silent = fakeEndpoint(
      () => new Promise<TokenResponse>(() => undefined),
    );
    const started = Date.now();
    const slow = await failure(acquire(silent.port, { timeoutMs: 30 }));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(slow.code).toBe('BROKER_UNREACHABLE');
    expect(silent.calls[0]?.signal.aborted).toBe(true);
    // A caller that cancels ends the wait too.
    const control = new AbortController();
    const pending = failure(
      acquire(silent.port, { timeoutMs: 60_000 }, control.signal),
    );
    setTimeout(() => {
      control.abort();
    }, 10);
    const cancelled = await pending;
    expect(cancelled.code).toBe('BROKER_UNREACHABLE');
    expect(cancelled.message).toContain('cancelled');
    expect(slow.message).toContain('in time');
    seen.push(slow, cancelled);

    // No Problem carries the body, the secret, the client id, the endpoint or a cause.
    for (const error of seen) {
      const text = [
        error.message,
        error.stack ?? '',
        JSON.stringify(toProblem(error)),
      ].join('\n');
      for (const secret of [
        BODY,
        SECRET,
        'engine-client',
        'idp.example.test',
      ]) {
        expect(text, error.code).not.toContain(secret);
      }
      expect(error.cause).toBeUndefined();
    }
  });
});

describe('client credentials config', () => {
  it('M1-23 strength the config accepts https and a loopback http issuer and nothing else', () => {
    const parse = (overrides: Record<string, unknown>) =>
      ProviderConfigSchema.safeParse({
        kind: 'client-credentials',
        endpoint: ENDPOINT,
        clientId: 'engine-client',
        ...overrides,
      }).success;
    expect(parse({})).toBe(true);
    for (const endpoint of [
      'http://localhost:8080/token',
      'http://127.0.0.1:8080/token',
      'http://127.1.2.3/token',
      'http://[::1]:8080/token',
    ]) {
      expect(parse({ endpoint }), endpoint).toBe(true);
    }
    for (const endpoint of [
      'http://idp.example.test/token',
      'http://127.0.0.1.evil.test/token',
      'http://localhost.evil.test/token',
      'ftp://idp.example.test/token',
      'https://user:pw@idp.example.test/token',
      'https://idp.example.test/token#frag',
      'idp.example.test/token',
      '',
    ]) {
      expect(parse({ endpoint }), endpoint).toBe(false);
    }
    expect(parse({ clientId: '' })).toBe(false);
    expect(parse({ clientId: 'a\nb' })).toBe(false);
    expect(parse({ scope: '' })).toBe(false);
    expect(parse({ clientSecret: 'must not be in the config' })).toBe(false);
    expect(parse({ usernameClaims: [] })).toBe(false);
    expect(config().usernameClaims).toEqual(['sub', 'client_id']);
  });

  it('M1-23 strength the lifetime comes from exp when the token has one, and a token past a year is refused', async () => {
    const withExp = jwt({
      sub: 'a',
      iat: NOW / 1000,
      exp: NOW / 1000 + 900,
    });
    const issued = await acquire(fakeEndpoint(() => ok(withExp, 300)).port);
    expect(issued.kind === 'bearer' && issued.expiresAt).toBe(NOW + 900_000);
    const noLifetime = await acquire(
      fakeEndpoint(() => ok(jwt({ sub: 'a' }), null)).port,
    );
    expect(noLifetime.kind === 'bearer' && noLifetime.expiresAt).toBeNull();
    const tooLong = await failure(
      acquire(fakeEndpoint(() => ok(jwt({ sub: 'a' }), 400 * 86_400)).port),
    );
    expect(tooLong.code).toBe('VALIDATION_FAILED');
    // A config without scope or audience sends neither.
    const bare = fakeEndpoint(() => ok(jwt({ sub: 'a' })));
    await createClientCredentialsProvider({
      config: config({ scope: undefined, audience: undefined }),
      stored: stored(),
      endpoint: bare.port,
      clock,
    }).acquire({ connectionId: 'c1', protocol: 'http' }, signal);
    expect(bare.calls[0]?.request).toEqual({
      endpoint: ENDPOINT,
      clientId: 'engine-client',
      clientSecret: SECRET,
    });
  });
});
