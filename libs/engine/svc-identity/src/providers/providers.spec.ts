// M1-23 slice A: the four providers that need no network (AC-1 to AC-5). Every provider is driven
// through fakes of the ports it takes, with the kernel's manual clock.
import util from 'node:util';

import {
  AppError,
  createCanaryScanner,
  createLogger,
  createManualClock,
  toProblem,
} from '@app/kernel';
import type {
  CommandRunnerPort,
  CredentialProtocol,
  StoredLoginPort,
} from '@app/ports';
import { describe, expect, it } from 'vitest';

import { readTokenClaims } from '../internal/claims';
import { SecretValue } from '../internal/secret-value';
import {
  ProviderConfigSchema,
  type CredentialProvider,
  type IssuedCredential,
} from '../provider';

import { createPasswordProvider } from './password';
import { createStaticTokenProvider } from './static-token';
import { createTokenCommandProvider } from './token-command';
import { createX509ExternalProvider } from './x509-external';

const NOW = 1_700_000_000_000;
const clock = createManualClock(NOW);
const signal = new AbortController().signal;

const b64 = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/** A compact JWT. The signature segment is not checked by the code under test. */
const jwt = (claims: Record<string, unknown>, signature = 'c2ln'): string =>
  `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.${signature}`;

const seconds = (epochMs: number): number => Math.floor(epochMs / 1000);

const request = (protocol: CredentialProtocol = 'amqp') => ({
  connectionId: 'c1',
  protocol,
});

/** A stored login the fake vault opens, or refuses while locked. */
function fakeStored(entry: { username: string | null; secret: string }) {
  let locked = false;
  const stored: StoredLoginPort & { lock(): void } = {
    lock: () => {
      locked = true;
    },
    open: () =>
      Promise.resolve(
        locked
          ? { kind: 'locked' as const }
          : { kind: 'found' as const, ...entry },
      ),
  };
  return stored;
}

type RunnerResult = Awaited<ReturnType<CommandRunnerPort['run']>>;

function fakeRunner(result: RunnerResult | (() => Promise<RunnerResult>)) {
  const calls: {
    command: { file: string; args: readonly string[] };
    limits: { timeoutMs: number; maxStdoutBytes: number };
  }[] = [];
  const runner: CommandRunnerPort = {
    run: (command, limits) => {
      calls.push({ command, limits });
      return typeof result === 'function' ? result() : Promise.resolve(result);
    },
  };
  return { runner, calls };
}

const commandConfig = (
  overrides: Record<string, unknown> = {},
): Extract<
  ReturnType<typeof ProviderConfigSchema.parse>,
  { kind: 'token-command' }
> => {
  const parsed = ProviderConfigSchema.parse({
    kind: 'token-command',
    file: '/usr/bin/get-token',
    args: ['--audience', 'rabbitmq; echo hacked', '$(id)'],
    ...overrides,
  });
  if (parsed.kind !== 'token-command') throw new Error('unreachable');
  return parsed;
};

async function failure(provider: Promise<unknown>): Promise<AppError> {
  try {
    await provider;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected the provider to reject');
}

describe('credential providers', () => {
  it('M1-23 AC-1 password provider returns the stored login and fails closed when the vault is locked', async () => {
    const stored = fakeStored({ username: 'svc-orders', secret: 'pw-AC1-xyz' });
    const provider = createPasswordProvider({ stored });

    const issued = await provider.acquire(request(), signal);
    expect(issued.kind).toBe('password');
    if (issued.kind !== 'password') throw new Error('unreachable');
    expect(issued.username).toBe('svc-orders');
    expect(issued.password.reveal()).toBe('pw-AC1-xyz');

    stored.lock();
    const error = await failure(provider.acquire(request(), signal));
    expect(error.code).toBe('GATE_BLOCKED');
    expect(error.message).not.toContain('pw-AC1-xyz');
    expect(error.message).not.toContain('svc-orders');
    expect(error.cause).toBeUndefined();
    // A login with no user name is refused too, not sent as an empty name.
    const nameless = createPasswordProvider({
      stored: fakeStored({ username: null, secret: 'pw-AC1-xyz' }),
    });
    expect((await failure(nameless.acquire(request(), signal))).code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('M1-23 AC-2 static token provider reads exp and the username claim and refuses a token it cannot read', async () => {
    const iat = seconds(NOW) - 60;
    const exp = seconds(NOW) + 3600;
    const readable = jwt({ iat, exp, sub: 'alice', client_id: 'app' });
    const provider = (secret: string) =>
      createStaticTokenProvider({
        stored: fakeStored({ username: null, secret }),
        clock,
      });

    const issued = await provider(readable).acquire(request('http'), signal);
    expect(issued).toMatchObject({
      kind: 'bearer',
      issuedAt: iat * 1000,
      expiresAt: exp * 1000,
      username: 'alice',
    });
    if (issued.kind !== 'bearer') throw new Error('unreachable');
    expect(issued.token.reveal()).toBe(readable);

    const noExp = await failure(
      provider(jwt({ iat, sub: 'alice' })).acquire(request(), signal),
    );
    expect(noExp.code).toBe('VALIDATION_FAILED');
    const notJwt = await failure(
      provider('just-an-opaque-token-value').acquire(request(), signal),
    );
    expect(notJwt.code).toBe('VALIDATION_FAILED');
    // Already expired: a distinct, honest code (OQ-1458).
    const expired = await failure(
      provider(jwt({ exp: seconds(NOW) - 1, sub: 'alice' })).acquire(
        request(),
        signal,
      ),
    );
    expect(expired.code).toBe('TOKEN_EXPIRED');
    // The username claims fall back in order: sub, then client_id.
    expect(readTokenClaims(jwt({ client_id: 'app' }))?.username).toBe('app');
    expect(readTokenClaims(jwt({ sub: '', client_id: 'app' }))?.username).toBe(
      'app',
    );
    expect(readTokenClaims(jwt({ sub: 7 }))?.username).toBeNull();
  });

  it('M1-23 AC-3 token command provider runs without a shell, bounds time and output, and leaks nothing on failure', async () => {
    const exp = seconds(NOW) + 600;
    const bare = jwt({ exp, sub: 'cmd-user' });
    const config = commandConfig({ timeoutMs: 2500, maxStdoutBytes: 4096 });

    // 1. A bare JWT; the argv array is passed as given (no shell words are interpreted).
    const first = fakeRunner({ ok: true, stdout: `${bare}\n` });
    const issued = await createTokenCommandProvider({
      config,
      runner: first.runner,
      clock,
    }).acquire(request(), signal);
    expect(issued).toMatchObject({
      kind: 'bearer',
      expiresAt: exp * 1000,
      username: 'cmd-user',
    });
    expect(first.calls).toEqual([
      {
        command: {
          file: '/usr/bin/get-token',
          args: ['--audience', 'rabbitmq; echo hacked', '$(id)'],
        },
        limits: { timeoutMs: 2500, maxStdoutBytes: 4096 },
      },
    ]);

    // 2. JSON with access_token; the lifetime counts only when the token has no exp.
    const noExp = jwt({ sub: 'cmd-user' });
    const second = fakeRunner({
      ok: true,
      stdout: JSON.stringify({ access_token: noExp, expires_in: 120 }),
    });
    const fromJson = await createTokenCommandProvider({
      config,
      runner: second.runner,
      clock,
    }).acquire(request(), signal);
    expect(fromJson).toMatchObject({
      kind: 'bearer',
      expiresAt: NOW + 120_000,
    });
    const preferred = fakeRunner({
      ok: true,
      stdout: JSON.stringify({ access_token: bare, expires_in: 5 }),
    });
    expect(
      await createTokenCommandProvider({
        config,
        runner: preferred.runner,
        clock,
      }).acquire(request(), signal),
    ).toMatchObject({ expiresAt: exp * 1000 });

    // 3. The failures: a fixed Problem that carries no stdout, stderr or command line.
    const leaky = 'CANARY-stdout-should-never-appear';
    const cases: { name: string; result: RunnerResult }[] = [
      {
        name: 'exit-nonzero',
        result: { ok: false, reason: 'exit-nonzero', stdout: leaky } as never,
      },
      { name: 'too-large', result: { ok: false, reason: 'too-large' } },
      { name: 'timeout', result: { ok: false, reason: 'timeout' } },
      { name: 'spawn-failed', result: { ok: false, reason: 'spawn-failed' } },
      // A runner that ignores the cap is not trusted to enforce it.
      { name: 'oversize ok', result: { ok: true, stdout: bare.repeat(200) } },
      { name: 'not a token', result: { ok: true, stdout: `${leaky} here` } },
    ];
    const details = new Set<string>();
    for (const { result } of cases) {
      const provider = createTokenCommandProvider({
        config,
        runner: fakeRunner(result).runner,
        clock,
      });
      const error = await failure(provider.acquire(request(), signal));
      expect(['UNAUTHENTICATED', 'VALIDATION_FAILED']).toContain(error.code);
      for (const text of [error.message, JSON.stringify(toProblem(error))]) {
        expect(text).not.toContain(leaky);
        expect(text).not.toContain('/usr/bin/get-token');
        expect(text).not.toContain('echo hacked');
      }
      details.add(error.message);
    }
    // Five distinct fixed texts for the five distinct failures, never a shared echo.
    expect(details.size).toBe(5);

    // 4. No runner (a delivery mode without commands): fails closed.
    const absent = await failure(
      createTokenCommandProvider({
        config,
        runner: undefined,
        clock,
      }).acquire(request(), signal),
    );
    expect(absent.code).toBe('GATE_BLOCKED');

    // 5. The config itself is strict and bounded.
    expect(() =>
      ProviderConfigSchema.parse({
        kind: 'token-command',
        file: 'tok',
        shell: true,
      }),
    ).toThrow();
    expect(() =>
      ProviderConfigSchema.parse({
        kind: 'token-command',
        file: 'tok',
        timeoutMs: 600_000,
      }),
    ).toThrow();
    expect(() =>
      ProviderConfigSchema.parse({
        kind: 'token-command',
        file: 'tok\nrm',
      }),
    ).toThrow();
    const defaults = commandConfig();
    expect(defaults.timeoutMs).toBe(10_000);
    expect(defaults.maxStdoutBytes).toBe(16_384);
  });

  it('M1-23 AC-4 x509 external provider serves AMQP only', async () => {
    const provider = createX509ExternalProvider();

    expect(await provider.acquire(request('amqp'), signal)).toEqual({
      kind: 'external',
    });
    const error = await failure(provider.acquire(request('http'), signal));
    expect(error.code).toBe('VALIDATION_FAILED');
  });

  it('M1-23 AC-5 no provider leaks a secret into a Problem, a log, JSON or inspect output', async () => {
    const CANARY = {
      password: 'CANARY-password-Qm7vR2xT9p',
      staticToken: jwt(
        { exp: seconds(NOW) + 600, sub: 'u1' },
        'CANARY-sig-Hd4kN8wZ3c',
      ),
      commandToken: jwt(
        { exp: seconds(NOW) + 600, sub: 'u2' },
        'CANARY-cmd-Lp6yB1sV5e',
      ),
      badToken: 'CANARY-notajwt-Jf2gU7aK0m',
    };
    const scanner = createCanaryScanner(Object.values(CANARY));
    const lines: string[] = [];
    const logger = createLogger({
      level: 'trace',
      sink: { write: (line) => lines.push(line) },
    });
    const seen: string[] = [];

    const observe = (outcome: IssuedCredential | AppError) => {
      logger.info({ outcome }, 'identity outcome');
      seen.push(
        JSON.stringify(outcome),
        util.inspect(outcome, { depth: null, showHidden: true }),
        util.format('%s', outcome),
        JSON.stringify(Object.entries(outcome)),
      );
      if (outcome instanceof AppError) {
        seen.push(
          outcome.message,
          outcome.stack ?? '',
          JSON.stringify(toProblem(outcome)),
          util.inspect(outcome.cause),
        );
      } else if (outcome.kind === 'bearer') {
        seen.push(String(outcome.token), JSON.stringify(outcome.token));
      } else if (outcome.kind === 'password') {
        seen.push(String(outcome.password));
      }
    };
    const run = async (provider: CredentialProvider, expectOk: boolean) => {
      try {
        const issued = await provider.acquire(request(), signal);
        expect(expectOk).toBe(true);
        observe(issued);
        return issued;
      } catch (error) {
        expect(expectOk).toBe(false);
        observe(error as AppError);
        return undefined;
      }
    };
    const stored = (secret: string) => fakeStored({ username: 'svc', secret });
    const command = (result: RunnerResult) =>
      createTokenCommandProvider({
        config: commandConfig(),
        runner: fakeRunner(result).runner,
        clock,
      });

    // Successes: the secret is reachable by reveal() and by nothing else.
    const password = await run(
      createPasswordProvider({ stored: stored(CANARY.password) }),
      true,
    );
    const staticToken = await run(
      createStaticTokenProvider({ stored: stored(CANARY.staticToken), clock }),
      true,
    );
    const commandToken = await run(
      command({ ok: true, stdout: CANARY.commandToken }),
      true,
    );
    expect(password?.kind === 'password' && password.password.reveal()).toBe(
      CANARY.password,
    );
    expect(staticToken?.kind === 'bearer' && staticToken.token.reveal()).toBe(
      CANARY.staticToken,
    );
    expect(commandToken?.kind === 'bearer' && commandToken.token.reveal()).toBe(
      CANARY.commandToken,
    );
    // The scanner is not vacuous: it finds each canary in the revealed value.
    expect(scanner.scan(CANARY.password).length).toBeGreaterThan(0);
    expect(
      scanner.scan(
        JSON.stringify([
          CANARY.password,
          CANARY.staticToken,
          CANARY.commandToken,
          CANARY.badToken,
        ]),
      ).length,
    ).toBeGreaterThanOrEqual(4);

    // Failures: the canary is what the provider was fed, and no Problem repeats it.
    const lockedStore = stored(CANARY.password);
    lockedStore.lock();
    await run(createPasswordProvider({ stored: lockedStore }), false);
    await run(
      createStaticTokenProvider({ stored: stored(CANARY.badToken), clock }),
      false,
    );
    await run(command({ ok: true, stdout: `${CANARY.badToken} x` }), false);
    await run(
      command({
        ok: false,
        reason: 'exit-nonzero',
        stdout: CANARY.commandToken,
      } as never),
      false,
    );

    expect(seen.length).toBeGreaterThan(20);
    expect(scanner.scan(seen.join('\n'))).toEqual([]);
    expect(scanner.scan(lines.join('\n'))).toEqual([]);
    expect(lines.length).toBe(7);

    // The wrapper itself prints a marker everywhere and has one way to the value.
    const direct = new SecretValue('CANARY-direct-Xv3nQ9tR2k');
    expect(String(direct)).toBe('[secret]');
    expect(util.format('%s|%j', direct, direct)).toBe('[secret]|"[secret]"');
    expect(JSON.stringify({ direct })).toBe('{"direct":"[secret]"}');
    expect(util.inspect(direct, { showHidden: true, depth: null })).toBe(
      '[secret]',
    );
    expect(Object.getOwnPropertyNames(direct)).toEqual([]);
    expect(direct.reveal()).toBe('CANARY-direct-Xv3nQ9tR2k');
  });
});
