// The acceptance criteria of M0-44 through the real ActionExecutor (with the hash-chained audit and
// the receipt store over memory) and the module's fakes, plus the rules that keep secrets write-only:
// a canary secret is typed in, and the specs look for it, in six encodings, in everything the engine
// produced (I-10).
import {
  CONNECTIONS_PER_PRINCIPAL_MAX,
  bundlesExport,
  bundlesImport,
  connectionsCreate,
  connectionsDelete,
  connectionsGet,
  connectionsList,
  connectionsTestAmqp,
  connectionsTestHttp,
  connectionsUpdate,
  type ActionDef,
  type ConnectionBundle,
  type InputOf,
  type OutputOf,
} from '@app/contracts';
import {
  createCanaryScanner,
  createLogger,
  createTestContext,
  createTestPrincipal,
  createWiredExecutor,
  type ExecutorContext,
} from '@app/kernel';
import { describe, expect, it } from 'vitest';

import { findSecretsInBundle } from './internal/bundle';
import { createConnectionsModule } from './module';
import { createConnectionsFakeDeps } from './testing';

/** Values that no real text contains; each is typed in somewhere a secret goes. */
const CANARY = {
  uriPassword: 'CANARY-uri-Qn6dY3bC0e',
  httpPassword: 'CANARY-http-7Hq2xv9Lm',
  token: 'CANARY-token-Zk4rT8wP1s',
  amqpPassword: 'CANARY-amqp-Vb5nM2jX8d',
};
const canaries = Object.values(CANARY);

function createEngine(options: { empty?: boolean } = { empty: true }) {
  const deps = createConnectionsFakeDeps(options);
  const lines: string[] = [];
  const logger = createLogger({
    level: 'trace',
    sink: { write: (line) => lines.push(line) },
  });
  const engine = createWiredExecutor({ executor: { logger } });
  for (const action of createConnectionsModule(deps).actions) {
    engine.executor.register(action as never);
  }
  let calls = 0;
  const context = (owner: string): ExecutorContext => {
    calls += 1;
    return createTestContext({
      principal: createTestPrincipal({ id: owner }),
      idempotencyKey: `connections-spec-${String(calls)}`,
    });
  };
  /** Runs one action as `owner` and returns its output. */
  const call = async <A extends ActionDef>(
    def: A,
    input: InputOf<A>,
    owner = 'user-1',
  ): Promise<OutputOf<A>> => {
    const outcome = await engine.executor.run(def, input, context(owner));
    if (outcome.kind !== 'output') {
      throw new Error(`expected an output, got ${outcome.kind}`);
    }
    return outcome.output;
  };
  /** Everything the engine wrote down: audit rows, receipts, plans' public parts, log lines. */
  const records = () =>
    JSON.stringify({
      audit: engine.auditRows.rows,
      receipts: [...engine.receiptRows.rows.values()],
      logs: lines,
    });
  return { deps, engine, call, lines, records };
}

const draftUri = 'amqps://u:p@host:5671/%2Fprod';

describe('svc-connections', () => {
  it('AC-1 a pasted amqps URI is saved with host, vhost, TLS and the derived management URL filled, and HTTP and AMQP are tested separately with specific errors', async () => {
    const { deps, call } = createEngine();

    const { profile } = await call(connectionsCreate, {
      name: 'Prod',
      envClass: 'prod',
      uri: draftUri,
    });

    expect(profile).toMatchObject({
      name: 'Prod',
      amqp: { host: 'host', port: 5671, tls: true, vhost: '/prod' },
      http: {
        host: 'host',
        port: 15671,
        tls: true,
        // The management API's TLS port, derived: nobody typed it.
        url: 'https://host:15671',
      },
    });

    // The two endpoints are tested by two separate calls, and each fails on its own.
    deps.prober.httpResult = {
      ok: false,
      failure: { reason: 'auth-refused' },
    };
    const http = await call(connectionsTestHttp, { cid: profile.id });
    const amqp = await call(connectionsTestAmqp, { cid: profile.id });

    expect(http).toMatchObject({
      ok: false,
      failure: { code: 'HTTP_AUTH_REFUSED' },
    });
    expect(http.failure?.message).toMatch(/refused the login/);
    expect(amqp.ok).toBe(true);
    expect(amqp.failure).toBeUndefined();
    // One probe per call, each to its own endpoint, each with its own login (the URI's, here).
    expect(deps.prober.httpCalls).toMatchObject([
      {
        host: 'host',
        port: 15671,
        tls: true,
        auth: { kind: 'basic', username: 'u', password: 'p' },
      },
    ]);
    expect(deps.prober.amqpCalls).toMatchObject([
      {
        host: 'host',
        port: 5671,
        tls: true,
        vhost: '/prod',
        auth: { kind: 'plain', username: 'u', password: 'p' },
      },
    ]);
  });

  it('AC-2 with HTTP ok and the AMQP port blocked, test-amqp says "AMQP port blocked" and the AMQP gates are disabled with that reason', async () => {
    const { deps, call } = createEngine();
    const { profile } = await call(connectionsCreate, {
      name: 'Prod',
      envClass: 'prod',
      uri: draftUri,
    });
    deps.prober.amqpResult = { ok: false, failure: { reason: 'unreachable' } };

    const http = await call(connectionsTestHttp, { cid: profile.id });
    const amqp = await call(connectionsTestAmqp, { cid: profile.id });

    expect(http.ok).toBe(true);
    expect(amqp).toMatchObject({
      ok: false,
      failure: { code: 'AMQP_PORT_BLOCKED' },
    });
    expect(amqp.failure?.message).toMatch(/^AMQP port blocked/);
    expect(amqp.failure?.message).toContain('host:5671');
    const gates = Object.entries(amqp.gates);
    expect(gates.length).toBeGreaterThan(0);
    for (const [, gate] of gates) {
      expect(gate).toEqual({
        enabled: false,
        reason: amqp.failure?.message,
        source: 'connections.test-amqp',
      });
    }
  });

  it('AC-2 a timeout on the AMQP port is the same blocked port, and a refused login is not', async () => {
    const { deps, call } = createEngine();
    const draft = { uri: draftUri };

    deps.prober.amqpResult = { ok: false, failure: { reason: 'timeout' } };
    expect((await call(connectionsTestAmqp, { draft })).failure?.code).toBe(
      'AMQP_PORT_BLOCKED',
    );

    deps.prober.amqpResult = { ok: false, failure: { reason: 'auth-refused' } };
    expect((await call(connectionsTestAmqp, { draft })).failure?.code).toBe(
      'AMQP_AUTH_REFUSED',
    );

    deps.prober.amqpResult = {
      ok: false,
      failure: { reason: 'vhost-refused' },
    };
    expect((await call(connectionsTestAmqp, { draft })).failure?.code).toBe(
      'AMQP_VHOST_REFUSED',
    );

    deps.prober.amqpResult = { ok: true };
    const ok = await call(connectionsTestAmqp, { draft });
    expect(ok.ok).toBe(true);
    expect(Object.values(ok.gates).every((gate) => gate.enabled)).toBe(true);
  });

  it('AC-2 a bundle exported without secrets has no password, token or URI credentials in it, in any encoding', async () => {
    const { call } = createEngine();
    // Every kind of secret goes in: a URI with a password, a basic password, a bearer token.
    await call(connectionsCreate, {
      name: 'From a URI',
      envClass: 'prod',
      uri: `amqps://svc-user:${CANARY.uriPassword}@mq.example:5671/%2Fprod`,
    });
    await call(connectionsCreate, {
      name: 'Explicit',
      envClass: 'staging',
      uri: 'amqps://mq2.example',
      http: {
        auth: {
          kind: 'basic',
          username: 'admin',
          password: CANARY.httpPassword,
        },
      },
      amqp: {
        auth: { kind: 'plain', username: 'app', password: CANARY.amqpPassword },
      },
    });
    await call(connectionsCreate, {
      name: 'Token',
      envClass: 'dev',
      http: {
        host: 'mq3.example',
        auth: { kind: 'bearer', token: CANARY.token },
      },
    });

    const { bundle } = await call(bundlesExport, {});

    expect(bundle.profiles.map((profile) => profile.name)).toEqual([
      'From a URI',
      'Explicit',
      'Token',
    ]);
    const text = JSON.stringify(bundle);
    expect(createCanaryScanner(canaries).scan(text)).toEqual([]);
    expect(findSecretsInBundle(bundle)).toEqual([]);
    // User names travel (they are addresses of a login, not secrets): OQ-447.
    expect(bundle.profiles[0]?.amqp.auth).toEqual({
      kind: 'plain',
      username: 'svc-user',
    });
  });

  it('AC-2 the scanner is not vacuous: it finds each canary in the input and a secret planted in a bundle', async () => {
    const input = {
      name: 'Prod',
      envClass: 'prod' as const,
      uri: `amqps://svc-user:${CANARY.uriPassword}@mq.example/`,
      http: {
        auth: {
          kind: 'basic' as const,
          username: 'a',
          password: CANARY.httpPassword,
        },
      },
    };
    expect(
      createCanaryScanner(canaries)
        .scan(JSON.stringify(input))
        .map((hit) => hit.index),
    ).toEqual(expect.arrayContaining([0, 1]));

    const { call } = createEngine();
    const { bundle } = await call(bundlesExport, {});
    const planted: unknown = {
      ...bundle,
      profiles: [
        {
          http: { auth: { password: 'x' } },
          uri: 'amqps://user:pass@host/',
        },
      ],
    };
    expect(findSecretsInBundle(planted).sort()).toEqual([
      '$.profiles[0].http.auth.password',
      '$.profiles[0].uri',
    ]);
  });

  it('I-10 a canary typed in as a password, a token and a URI password is in no response, audit row, receipt, log line, error or stored byte', async () => {
    const { deps, call, records, engine } = createEngine();
    const scanner = createCanaryScanner(canaries);
    const seen: string[] = [];
    const see = (value: unknown) => seen.push(JSON.stringify(value));

    const created = await call(connectionsCreate, {
      name: 'Orders',
      envClass: 'staging',
      uri: `amqps://svc:${CANARY.uriPassword}@mq.example:5671/orders`,
      http: {
        auth: { kind: 'bearer', token: CANARY.token },
      },
    });
    see(created);
    const cid = created.profile.id;
    see(await call(connectionsGet, { cid }));
    see(await call(connectionsList, {}));
    see(
      await call(connectionsUpdate, {
        cid,
        amqp: { auth: { kind: 'plain', password: CANARY.amqpPassword } },
      }),
    );
    see(await call(connectionsTestHttp, { cid }));
    see(await call(connectionsTestAmqp, { cid }));
    see(
      await call(connectionsTestAmqp, {
        draft: { uri: `amqp://u:${CANARY.httpPassword}@h/` },
      }),
    );
    see(await call(bundlesExport, {}));
    see(await call(connectionsDelete, { cid }));

    // The secrets reached the prober, which is the one place that needs them...
    expect(JSON.stringify(deps.prober.httpCalls)).toContain(CANARY.token);
    expect(JSON.stringify(deps.prober.amqpCalls)).toContain(
      CANARY.amqpPassword,
    );
    // ...and nothing the engine returned or wrote down has any.
    expect(scanner.scan(seen.join('\n'))).toEqual([]);
    expect(scanner.scan(records())).toEqual([]);
    expect(engine.auditRows.rows.length).toBeGreaterThan(0);
    expect(engine.receiptRows.rows.size).toBeGreaterThan(0);
  });

  it('I-10 errors never repeat the input: a broken URI, a refused save and a probe that blows up carry no canary', async () => {
    const { deps, call, records, engine, lines } = createEngine();
    const scanner = createCanaryScanner(canaries);
    const errors: unknown[] = [];
    const fail = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        errors.push(error);
        return;
      }
      throw new Error('expected a failure');
    };

    // Not a URI, and a URI whose password breaks the % escapes: both name the password in the input.
    await fail(() =>
      call(connectionsCreate, {
        name: 'x',
        envClass: 'dev',
        uri: `amqps://u:${CANARY.uriPassword}%zz@host/`,
      }),
    );
    await fail(() =>
      call(connectionsCreate, {
        name: 'x',
        envClass: 'dev',
        uri: `ftp://u:${CANARY.uriPassword}@host/`,
      }),
    );
    // A port that is not one: the failure names the field, never the value.
    await fail(() =>
      call(connectionsCreate, {
        name: 'x',
        envClass: 'dev',
        uri: `amqps://u:${CANARY.uriPassword}@host:99999999/`,
      }),
    );
    // A locked vault refuses to store the secret.
    deps.sealer.lock();
    await fail(() =>
      call(connectionsCreate, {
        name: 'x',
        envClass: 'dev',
        uri: `amqps://u:${CANARY.uriPassword}@host/`,
      }),
    );
    deps.sealer.unlock();
    // A prober that throws with the login in its message.
    deps.prober.http = () =>
      Promise.reject(new Error(`boom ${CANARY.httpPassword}`));
    const result = await call(connectionsTestHttp, {
      draft: {
        uri: 'http://mq.example',
        http: {
          auth: { kind: 'basic', username: 'u', password: CANARY.httpPassword },
        },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'HTTP_UNEXPECTED' },
    });
    expect(errors).toHaveLength(4);
    expect(errors.map((e) => (e as { code?: string }).code)).toEqual([
      'VALIDATION_FAILED',
      'VALIDATION_FAILED',
      'VALIDATION_FAILED',
      'GATE_BLOCKED',
    ]);
    const text = errors
      .map((e) => `${(e as Error).message}\n${(e as Error).stack ?? ''}`)
      .join('\n');
    expect(scanner.scan(text)).toEqual([]);
    expect(scanner.scan(JSON.stringify(result))).toEqual([]);
    expect(scanner.scan(records())).toEqual([]);
    expect(lines.length).toBeGreaterThan(0);
    // Nothing was saved by a failed create.
    expect(await deps.store.count('user-1')).toBe(0);
    expect(engine.auditRows.rows.length).toBeGreaterThan(0);
  });

  it('I-10 a secret is stored sealed: the bytes hold no canary, and a ciphertext moved to another profile or protocol does not open', async () => {
    const { deps, call } = createEngine();
    const a = await call(connectionsCreate, {
      name: 'A',
      envClass: 'dev',
      uri: `amqp://u:${CANARY.uriPassword}@a.example/`,
    });
    const b = await call(connectionsCreate, {
      name: 'B',
      envClass: 'dev',
      uri: 'amqp://u:other-password@b.example/',
    });

    const stored = await deps.store.credentials(a.profile.id);
    expect(stored.map((row) => row.protocol)).toEqual(['amqp', 'http']);
    for (const row of stored) {
      expect(createCanaryScanner(canaries).scan(row.ciphertext)).toEqual([]);
    }
    // Move A's AMQP ciphertext onto B, and A's AMQP ciphertext onto B's HTTP slot.
    const moved = stored.find((row) => row.protocol === 'amqp');
    const record = await deps.store.get(b.profile.id);
    if (moved === undefined || record === undefined) throw new Error('setup');
    await deps.store.save(record, {
      put: { amqp: moved.ciphertext, http: moved.ciphertext },
    });

    const amqp = await call(connectionsTestAmqp, { cid: b.profile.id });
    const http = await call(connectionsTestHttp, { cid: b.profile.id });

    expect(amqp.failure?.code).toBe('SECRET_UNAVAILABLE');
    expect(http.failure?.code).toBe('SECRET_UNAVAILABLE');
    expect(amqp.failure?.message).toMatch(/cannot be opened/);
    // Nothing was dialled with a wrong or missing secret.
    expect(deps.prober.amqpCalls).toEqual([]);
    expect(deps.prober.httpCalls).toEqual([]);
  });

  it('I-10 reads report only whether a secret is set, and the contract says so: no output schema has a write-only field', async () => {
    const { call } = createEngine();
    const { profile } = await call(connectionsCreate, {
      name: 'Orders',
      envClass: 'dev',
      uri: `amqps://svc:${CANARY.uriPassword}@mq.example/`,
    });

    expect(profile.http.auth).toEqual({
      kind: 'basic',
      username: 'svc',
      secret: { isSet: true, updatedAt: expect.any(Number) as number },
    });
    expect(profile.amqp.auth.secret.isSet).toBe(true);
    expect(JSON.stringify(profile)).not.toMatch(/password"|token"/);
    const { profile: bare } = await call(connectionsCreate, {
      name: 'Bare',
      envClass: 'dev',
      http: { host: 'mq.example' },
    });
    expect(bare.http.auth).toEqual({
      kind: 'none',
      username: null,
      secret: { isSet: false, updatedAt: null },
    });
  });

  it('a secret is kept when an update does not send one, replaced when it does, and removed with kind none', async () => {
    const { deps, call } = createEngine();
    const { profile } = await call(connectionsCreate, {
      name: 'Orders',
      envClass: 'dev',
      uri: 'amqp://svc:first-password@mq.example/',
    });
    const cid = profile.id;
    const before = await deps.store.credentials(cid);

    // A rename keeps both credentials, byte for byte.
    await call(connectionsUpdate, { cid, name: 'Orders 2' });
    const kept = await deps.store.credentials(cid);
    expect(kept).toEqual(before);

    // A new AMQP password replaces the AMQP secret only: the HTTP secret is its own.
    await call(connectionsUpdate, {
      cid,
      amqp: { auth: { kind: 'plain', password: 'second-password' } },
    });
    const replaced = await deps.store.credentials(cid);
    expect(replaced.find((r) => r.protocol === 'http')).toEqual(
      before.find((r) => r.protocol === 'http'),
    );
    expect(
      Buffer.from(
        replaced.find((r) => r.protocol === 'amqp')?.ciphertext ?? [],
      ).equals(
        Buffer.from(
          before.find((r) => r.protocol === 'amqp')?.ciphertext ?? [],
        ),
      ),
    ).toBe(false);
    await call(connectionsTestAmqp, { cid });
    expect(deps.prober.amqpCalls.at(-1)?.auth).toEqual({
      kind: 'plain',
      username: 'svc',
      password: 'second-password',
    });

    // kind none removes the secret.
    const { profile: cleared } = await call(connectionsUpdate, {
      cid,
      http: { auth: { kind: 'none' } },
    });
    expect(cleared.http.auth).toMatchObject({
      kind: 'none',
      secret: { isSet: false },
    });
    expect(
      (await deps.store.credentials(cid)).map((row) => row.protocol),
    ).toEqual(['amqp']);
  });

  it('changing the address of an endpoint needs its secret again, so a stored password cannot be sent to a new host', async () => {
    const { deps, call } = createEngine();
    const { profile } = await call(connectionsCreate, {
      name: 'Orders',
      envClass: 'dev',
      uri: 'amqp://svc:first-password@mq.example/',
    });
    const cid = profile.id;

    await expect(
      call(connectionsUpdate, { cid, amqp: { host: 'attacker.example' } }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: expect.stringContaining('enter') as string,
    });
    await expect(
      call(connectionsUpdate, { cid, http: { port: 8443 } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // With the secret sent again, the move is allowed.
    const { profile: moved } = await call(connectionsUpdate, {
      cid,
      amqp: {
        host: 'new.example',
        auth: { kind: 'plain', password: 'new-password' },
      },
    });
    expect(moved.amqp.host).toBe('new.example');
    expect(deps.prober.amqpCalls).toEqual([]);
  });

  it('a draft is tested with the secrets in it and a saved profile with its stored ones, and giving both or neither is refused', async () => {
    const { deps, call } = createEngine();

    await call(connectionsTestHttp, {
      draft: {
        uri: 'https://mq.example/rabbitmq',
        http: { auth: { kind: 'bearer', token: 'draft-token-value' } },
      },
    });
    expect(deps.prober.httpCalls).toEqual([
      {
        host: 'mq.example',
        port: 443,
        tls: true,
        pathPrefix: '/rabbitmq',
        auth: { kind: 'bearer', token: 'draft-token-value' },
      },
    ]);

    await expect(call(connectionsTestHttp, {})).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      call(connectionsTestAmqp, {
        cid: 'x' as never,
        draft: { uri: 'amqp://h' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      call(connectionsTestAmqp, { cid: 'nope' as never }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('test-http reports what the broker says, the AMQP ports it listens on, and the specific cause of each failure', async () => {
    const { deps, call } = createEngine();
    const draft = { uri: 'http://mq.example:15672' };

    const ok = await call(connectionsTestHttp, { draft });
    expect(ok).toMatchObject({
      ok: true,
      target: { url: 'http://mq.example:15672' },
      broker: {
        product: 'RabbitMQ',
        version: '4.3.6',
        tags: ['administrator'],
      },
      amqpPorts: { plain: 5672, tls: 5671 },
    });

    const expectations = {
      unreachable: 'HTTP_UNREACHABLE',
      timeout: 'HTTP_TIMEOUT',
      'egress-denied': 'HTTP_EGRESS_DENIED',
      'tls-untrusted': 'HTTP_TLS_UNTRUSTED',
      'auth-refused': 'HTTP_AUTH_REFUSED',
      'missing-tag': 'HTTP_MISSING_TAG',
      'not-management': 'HTTP_NOT_MANAGEMENT',
      unexpected: 'HTTP_UNEXPECTED',
    } as const;
    const messages = new Set<string>();
    for (const [reason, code] of Object.entries(expectations)) {
      deps.prober.httpResult = {
        ok: false,
        failure: { reason: reason as keyof typeof expectations },
      };
      const failed = await call(connectionsTestHttp, { draft });
      expect(failed.failure?.code).toBe(code);
      messages.add(failed.failure?.message ?? '');
      expect(failed.broker).toBeUndefined();
    }
    // Eight causes, eight different messages.
    expect(messages.size).toBe(8);
  });

  it('a profile that needs a secret it does not have is not dialled: the test says so', async () => {
    const { deps, call } = createEngine();
    const imported = await call(bundlesImport, {
      bundle: {
        format: 'connection-bundle',
        version: 1,
        exportedAt: 1,
        secretsIncluded: false,
        profiles: [
          {
            name: 'From a bundle',
            envClass: 'dev',
            color: null,
            http: {
              host: 'mq.example',
              port: 15672,
              tls: false,
              pathPrefix: null,
              auth: { kind: 'basic', username: 'admin' },
            },
            amqp: {
              host: 'mq.example',
              port: 5672,
              tls: false,
              vhost: '/',
              auth: { kind: 'plain', username: 'app' },
            },
          },
        ],
      },
    });
    const cid = imported.created[0]?.id;
    if (cid === undefined) throw new Error('setup');

    const http = await call(connectionsTestHttp, { cid });
    const amqp = await call(connectionsTestAmqp, { cid });

    expect(http.failure).toMatchObject({ code: 'SECRET_UNAVAILABLE' });
    expect(http.failure?.message).toMatch(/No secret is stored/);
    expect(amqp.failure?.code).toBe('SECRET_UNAVAILABLE');
    expect(Object.values(amqp.gates).every((gate) => !gate.enabled)).toBe(true);
    expect(deps.prober.httpCalls).toEqual([]);
    expect(deps.prober.amqpCalls).toEqual([]);
    const { profile } = await call(connectionsGet, { cid });
    expect(profile.http.auth).toMatchObject({
      kind: 'basic',
      username: 'admin',
      secret: { isSet: false },
    });
  });

  it('a person sees their own profiles and the shared ones, only the owner changes a profile, and a private one of someone else is not found', async () => {
    const { call } = createEngine();
    const mine = await call(connectionsCreate, {
      name: 'Mine',
      envClass: 'dev',
      http: { host: 'a.example' },
    });
    const shared = await call(
      connectionsCreate,
      {
        name: 'Shared',
        envClass: 'dev',
        visibility: 'team',
        http: { host: 'b.example' },
      },
      'user-2',
    );
    await call(
      connectionsCreate,
      { name: 'Theirs', envClass: 'dev', http: { host: 'c.example' } },
      'user-2',
    );

    const listed = await call(connectionsList, {}, 'user-1');
    expect(listed.items.map((item) => [item.name, item.canEdit])).toEqual([
      ['Mine', true],
      ['Shared', false],
    ]);

    await expect(
      call(connectionsGet, { cid: shared.profile.id }, 'user-1'),
    ).resolves.toMatchObject({ profile: { canEdit: false } });
    await expect(
      call(connectionsUpdate, { cid: shared.profile.id, name: 'Mine now' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_RBAC' });
    await expect(
      call(connectionsDelete, { cid: shared.profile.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_RBAC' });
    await expect(
      call(connectionsGet, { cid: mine.profile.id }, 'user-2'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      call(connectionsUpdate, { cid: mine.profile.id, name: 'x' }, 'user-2'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a list comes in windows, in id order, and a delete removes the profile and its credentials', async () => {
    const { deps, call } = createEngine();
    const ids: string[] = [];
    for (const name of ['one', 'two', 'three']) {
      const { profile } = await call(connectionsCreate, {
        name,
        envClass: 'dev',
        uri: 'amqp://u:p@mq.example/',
      });
      ids.push(profile.id);
    }

    const first = await call(connectionsList, { limit: 2 });
    const second = await call(connectionsList, {
      limit: 2,
      ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
    });

    expect(first.items.map((item) => item.id)).toEqual(ids.slice(0, 2));
    expect(first.nextCursor).toBe(ids[1]);
    expect(second.items.map((item) => item.id)).toEqual(ids.slice(2));
    expect(second.nextCursor).toBeUndefined();

    const target = ids[0] ?? '';
    expect(await call(connectionsDelete, { cid: target as never })).toEqual({
      deleted: true,
    });
    expect(await deps.store.get(target)).toBeUndefined();
    expect(await deps.store.credentials(target)).toEqual([]);
    expect((await deps.store.credentials(ids[1] ?? '')).length).toBe(2);
  });

  it('a person keeps at most the budgeted number of profiles', async () => {
    const { deps, call } = createEngine();
    for (let n = 0; n < CONNECTIONS_PER_PRINCIPAL_MAX; n += 1) {
      await deps.store.save({
        id: `seed-${String(n).padStart(4, '0')}`,
        name: `seed ${String(n)}`,
        envClass: 'dev',
        color: null,
        config: {},
        ownerId: 'user-1',
        visibility: 'private',
      });
    }

    await expect(
      call(connectionsCreate, {
        name: 'one too many',
        envClass: 'dev',
        http: { host: 'mq.example' },
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
  });

  it('a bundle round-trips between people: the profiles come back with their addresses and no secret, and a name that exists is skipped or renamed', async () => {
    const { call } = createEngine();
    await call(connectionsCreate, {
      name: 'Orders',
      envClass: 'staging',
      color: '#aa00bb',
      uri: `amqps://svc:${CANARY.uriPassword}@mq.example:5671/%2Forders`,
    });
    const { bundle } = await call(bundlesExport, {});
    const imported: ConnectionBundle = bundle;

    const onUser2 = await call(bundlesImport, { bundle: imported }, 'user-2');
    expect(onUser2.created.map((entry) => entry.name)).toEqual(['Orders']);
    const list = await call(connectionsList, {}, 'user-2');
    expect(list.items[0]).toMatchObject({
      name: 'Orders',
      envClass: 'staging',
      color: '#aa00bb',
      visibility: 'private',
      canEdit: true,
      amqp: {
        host: 'mq.example',
        port: 5671,
        tls: true,
        vhost: '/orders',
        auth: { kind: 'plain', username: 'svc', secret: { isSet: false } },
      },
      http: { url: 'https://mq.example:15671' },
    });
    expect(createCanaryScanner(canaries).scan(JSON.stringify(list))).toEqual(
      [],
    );

    // The same bundle again: skipped by default, renamed on request.
    const skipped = await call(bundlesImport, { bundle: imported }, 'user-2');
    expect(skipped).toEqual({
      created: [],
      skipped: [{ name: 'Orders', reason: 'name-exists' }],
    });
    const renamed = await call(
      bundlesImport,
      { bundle: imported, onConflict: 'rename' },
      'user-2',
    );
    expect(renamed.created.map((entry) => entry.name)).toEqual(['Orders (2)']);
    const again = await call(
      bundlesImport,
      { bundle: imported, onConflict: 'rename' },
      'user-2',
    );
    expect(again.created.map((entry) => entry.name)).toEqual(['Orders (3)']);
  });

  it('an export can name profiles, refuses one the caller cannot see, and the import budget is checked before anything is created', async () => {
    const { deps, call } = createEngine();
    const a = await call(connectionsCreate, {
      name: 'A',
      envClass: 'dev',
      http: { host: 'a.example' },
    });
    await call(connectionsCreate, {
      name: 'B',
      envClass: 'dev',
      http: { host: 'b.example' },
    });
    const theirs = await call(
      connectionsCreate,
      { name: 'C', envClass: 'dev', http: { host: 'c.example' } },
      'user-2',
    );

    const one = await call(bundlesExport, { connectionIds: [a.profile.id] });
    expect(one.bundle.profiles.map((profile) => profile.name)).toEqual(['A']);
    await expect(
      call(bundlesExport, { connectionIds: [theirs.profile.id] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    for (let n = 0; n < CONNECTIONS_PER_PRINCIPAL_MAX - 2; n += 1) {
      await deps.store.save({
        id: `seed-${String(n).padStart(4, '0')}`,
        name: `seed ${String(n)}`,
        envClass: 'dev',
        color: null,
        config: {},
        ownerId: 'user-1',
        visibility: 'private',
      });
    }
    const { bundle } = await call(bundlesExport, {
      connectionIds: [a.profile.id],
    });
    const profile = bundle.profiles[0];
    if (profile === undefined) throw new Error('setup');
    const tooMany = {
      ...bundle,
      profiles: [1, 2].map((n) => ({ ...profile, name: `new ${String(n)}` })),
    };
    await expect(
      call(bundlesImport, { bundle: tooMany }),
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(await deps.store.count('user-1')).toBe(
      CONNECTIONS_PER_PRINCIPAL_MAX,
    );
  });

  it('a create is audited with an attempt and an outcome, and the receipt names no secret', async () => {
    const { call, engine } = createEngine();

    await call(connectionsCreate, {
      name: 'Orders',
      envClass: 'dev',
      uri: `amqps://svc:${CANARY.uriPassword}@mq.example/`,
    });

    expect(
      engine.auditRows.rows.map((row) => [row.phase, row.actionId]),
    ).toEqual([
      ['attempt', 'connections.create'],
      ['outcome', 'connections.create'],
    ]);
    expect([...engine.receiptRows.rows.values()]).toMatchObject([
      { actionId: 'connections.create', result: 'ok' },
    ]);
  });
});
