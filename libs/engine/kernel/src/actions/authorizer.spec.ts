import { describe, expect, it } from 'vitest';

import {
  allowUiPrincipals,
  createRoleAuthorizer,
  denyAllAuthorizer,
  type AuthorizationRequest,
} from './authorizer.ts';
import {
  chainOf,
  isPrincipal,
  isRequester,
  isUiPrincipal,
  mayActFor,
  snapshotPrincipal,
} from './principal.ts';
import { createTestPrincipal } from './testing.ts';

const request = (
  principal = createTestPrincipal(),
  permission = 'messages.purge',
): AuthorizationRequest => ({
  principal,
  permission: permission as AuthorizationRequest['permission'],
  actionId: 'queues.purge' as AuthorizationRequest['actionId'],
  target: {},
  mode: 'desktop',
  env: 'dev',
});

const allowed = async (
  authorizer: ReturnType<typeof createRoleAuthorizer>,
  r: AuthorizationRequest,
) => (await authorizer.authorize(r)).allowed;

describe('executor authorizer', () => {
  it('denies everything by default', async () => {
    expect((await denyAllAuthorizer.authorize(request())).allowed).toBe(false);
  });

  it('allow-all applies to the UI principal of a single-user engine only (A-11)', async () => {
    const authorizer = allowUiPrincipals();
    const ui = createTestPrincipal();
    const local = createTestPrincipal({ kind: 'local-token' });
    const cli = createTestPrincipal({ kind: 'api-token', surface: 'cli' });
    const team = createTestPrincipal({ kind: 'team-user' });
    const unattended = createTestPrincipal({ unattended: true });
    const delegate = createTestPrincipal({ onBehalfOf: ui });
    const mcp = createTestPrincipal({ kind: 'mcp-client', surface: 'mcp' });

    expect((await authorizer.authorize(request(ui))).allowed).toBe(true);
    expect((await authorizer.authorize(request(local))).allowed).toBe(true);
    for (const other of [cli, team, unattended, delegate, mcp]) {
      expect((await authorizer.authorize(request(other))).allowed).toBe(false);
    }
  });

  it('anything that is not a UI principal goes to the fallback', async () => {
    const authorizer = allowUiPrincipals(
      createRoleAuthorizer({ ops: ['messages.purge'] }),
    );
    const cli = createTestPrincipal({
      kind: 'api-token',
      surface: 'cli',
      roles: ['ops'],
    });

    expect((await authorizer.authorize(request(cli))).allowed).toBe(true);
    expect(
      (await authorizer.authorize(request(cli, 'messages.read'))).allowed,
    ).toBe(false);
  });

  it('matches grants by exact name and by * on either side of the dot', async () => {
    const authorizer = createRoleAuthorizer({
      exact: ['messages.purge'],
      area: ['messages.*'],
      verb: ['*.read'],
      all: ['*.*'],
      broken: ['messages', 'messages.purge.x', '*', '.', ''],
    });
    const holder = (role: string) => createTestPrincipal({ roles: [role] });

    expect(await allowed(authorizer, request(holder('exact')))).toBe(true);
    expect(
      await allowed(authorizer, request(holder('exact'), 'messages.read')),
    ).toBe(false);
    expect(
      await allowed(authorizer, request(holder('area'), 'messages.read')),
    ).toBe(true);
    expect(
      await allowed(authorizer, request(holder('area'), 'queues.read')),
    ).toBe(false);
    expect(
      await allowed(authorizer, request(holder('verb'), 'queues.read')),
    ).toBe(true);
    expect(await allowed(authorizer, request(holder('verb')))).toBe(false);
    expect(await allowed(authorizer, request(holder('all')))).toBe(true);
    for (const permission of ['messages.purge', 'messages']) {
      expect(
        await allowed(authorizer, request(holder('broken'), permission)),
      ).toBe(false);
    }
    expect(await allowed(authorizer, request(holder('unknown-role')))).toBe(
      false,
    );
    expect(
      await allowed(authorizer, request(createTestPrincipal({ roles: [] }))),
    ).toBe(false);
  });

  it('a delegate holds only what it and the one it acts for both hold', async () => {
    const authorizer = createRoleAuthorizer({
      admin: ['*.*'],
      reader: ['*.read'],
    });
    const person = createTestPrincipal({ roles: ['reader'] });
    const agent = createTestPrincipal({
      kind: 'mcp-client',
      surface: 'mcp',
      roles: ['admin'],
      onBehalfOf: person,
    });

    expect(await allowed(authorizer, request(agent, 'messages.read'))).toBe(
      true,
    );
    expect(await allowed(authorizer, request(agent, 'messages.purge'))).toBe(
      false,
    );
  });
});

describe('executor principals', () => {
  it('accepts a well-formed principal and nothing else', () => {
    const good = createTestPrincipal({ onBehalfOf: createTestPrincipal() });

    expect(isPrincipal(good)).toBe(true);
    for (const bad of [
      null,
      undefined,
      'user',
      {},
      { ...good, kind: 'admin' },
      { ...good, surface: 'tty' },
      { ...good, id: '' },
      { ...good, id: 7 },
      { ...good, roles: 'admin' },
      { ...good, roles: [1] },
      { ...good, unattended: 'no' },
      { ...good, onBehalfOf: { kind: 'system' } },
    ]) {
      expect(isPrincipal(bad)).toBe(false);
    }
  });

  it('refuses a delegation chain longer than 4', () => {
    let chain = createTestPrincipal({ id: 'p0' });
    for (let i = 1; i < 6; i += 1) {
      chain = createTestPrincipal({ id: `p${String(i)}`, onBehalfOf: chain });
    }

    expect(isPrincipal(chain)).toBe(false);
  });

  it('a snapshot is deep, frozen and independent of the original', () => {
    const roles = ['a'];
    const original = createTestPrincipal({
      roles,
      onBehalfOf: createTestPrincipal({ id: 'boss', roles: ['b'] }),
    });

    const copy = snapshotPrincipal(original);
    roles.push('root');

    expect(copy.roles).toEqual(['a']);
    expect(Object.isFrozen(copy)).toBe(true);
    expect(Object.isFrozen(copy.roles)).toBe(true);
    expect(Object.isFrozen(copy.onBehalfOf)).toBe(true);
    expect(() => {
      copy.roles.push('x');
    }).toThrow(TypeError);
  });

  it('lists the chain from the principal to the person at the end', () => {
    const chain = createTestPrincipal({
      id: 'job',
      kind: 'job',
      onBehalfOf: createTestPrincipal({
        id: 'agent',
        onBehalfOf: createTestPrincipal({ id: 'boss' }),
      }),
    });

    expect(chainOf(chain).map((p) => p.id)).toEqual(['job', 'agent', 'boss']);
  });

  it('only a person at the UI is a UI principal', () => {
    expect(isUiPrincipal(createTestPrincipal())).toBe(true);
    expect(isUiPrincipal(createTestPrincipal({ surface: 'cli' }))).toBe(false);
    expect(isUiPrincipal(createTestPrincipal({ kind: 'team-user' }))).toBe(
      false,
    );
    expect(isUiPrincipal(createTestPrincipal({ unattended: true }))).toBe(
      false,
    );
  });

  it('may act for the requester, the person they acted for, and a job that runs for the requester', () => {
    const owner = { principalId: 'agent', onBehalfOfId: 'boss' };

    expect(mayActFor(createTestPrincipal({ id: 'agent' }), owner)).toBe(true);
    expect(mayActFor(createTestPrincipal({ id: 'boss' }), owner)).toBe(true);
    expect(mayActFor(createTestPrincipal({ id: 'other' }), owner)).toBe(false);
    expect(
      mayActFor(
        createTestPrincipal({
          id: 'job-1',
          kind: 'job',
          onBehalfOf: createTestPrincipal({ id: 'agent' }),
        }),
        owner,
      ),
    ).toBe(true);
    // A non-job that merely claims to act for the requester is not the requester.
    expect(
      mayActFor(
        createTestPrincipal({
          id: 'x',
          onBehalfOf: createTestPrincipal({ id: 'agent' }),
        }),
        owner,
      ),
    ).toBe(false);
  });

  it('an approver who is, or acts for, the requester is the requester', () => {
    const owner = { principalId: 'agent', onBehalfOfId: 'boss' };

    expect(isRequester(createTestPrincipal({ id: 'agent' }), owner)).toBe(true);
    expect(isRequester(createTestPrincipal({ id: 'boss' }), owner)).toBe(true);
    expect(
      isRequester(
        createTestPrincipal({
          id: 'z',
          onBehalfOf: createTestPrincipal({ id: 'boss' }),
        }),
        owner,
      ),
    ).toBe(true);
    expect(isRequester(createTestPrincipal({ id: 'z' }), owner)).toBe(false);
  });
});
