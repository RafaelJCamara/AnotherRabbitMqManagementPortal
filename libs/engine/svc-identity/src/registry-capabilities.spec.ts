// M1-23 slice D: the TokenManager's `capabilities` callback fed from the semantics registry. The
// real registry answers the three auth rules; a stand-in registry shows which rule each flag asks
// for and what a missing rule does. The end-to-end cases run the manager on top of the feed.
import { parseSemVer } from '@app/domain-model';
import { AppError, createManualClock, createManualTimers } from '@app/kernel';
import type { ConnectionAuthPort } from '@app/ports';
import {
  SemanticsGapError,
  semanticsRegistry,
  type CapabilityProfile,
} from '@app/semantics';
import { describe, expect, it } from 'vitest';

import { SecretValue } from './internal/secret-value';
import type { CredentialProvider, IssuedCredential } from './provider';
import {
  createRegistryCapabilities,
  type CapabilitySource,
} from './registry-capabilities';
import { createTokenManager } from './token-manager';

const signal = new AbortController().signal;
const SECOND = 1000;
const LIFETIME = 1_000 * SECOND;

/** A profile whose nodes run the given versions (null: a node whose version cannot be read). */
function profileOf(...nodes: (string | null)[]): CapabilityProfile {
  const perNode: Record<string, ReturnType<typeof parseSemVer>> = {};
  nodes.forEach((text, index) => {
    perNode[`rabbit@n${String(index)}`] =
      text === null ? null : parseSemVer(text);
  });
  const known = Object.values(perNode).filter((value) => value !== null);
  return {
    product: 'rabbitmq',
    stats: { disabled: false, queueTotals: true },
    versions: {
      min: known.length === nodes.length ? (known[0] ?? null) : null,
      perNode,
      mixed: new Set(nodes).size > 1,
      build: 'oss',
    },
  };
}

const feed = (...nodes: (string | null)[]) =>
  createRegistryCapabilities({
    registry: semanticsRegistry,
    profileFor: () => profileOf(...nodes),
  })('c1');

describe('the capabilities callback fed from the registry (M1-23, slice D)', () => {
  it('M1-23 slice D the feed answers each flag from its own rule at the version boundaries', () => {
    expect(feed('4.0.9')).toEqual({
      amqp10TokenRenewalEndpoint: false,
      amqp091ClosesAtCredentialExpiry: false,
      amqp091PreAuthFrame8192: false,
    });
    expect(feed('4.1.0')).toEqual({
      amqp10TokenRenewalEndpoint: true,
      amqp091ClosesAtCredentialExpiry: false,
      amqp091PreAuthFrame8192: true,
    });
    expect(feed('4.2.5')).toMatchObject({
      amqp091ClosesAtCredentialExpiry: false,
    });
    expect(feed('4.2.6')).toEqual({
      amqp10TokenRenewalEndpoint: true,
      amqp091ClosesAtCredentialExpiry: true,
      amqp091PreAuthFrame8192: true,
    });
    // A node below the line, or one whose version cannot be read, takes the conservative side.
    expect(feed('4.3.6', '4.2.5')).toMatchObject({
      amqp091ClosesAtCredentialExpiry: false,
      amqp10TokenRenewalEndpoint: true,
    });
    expect(feed('4.3.6', null)).toEqual({
      amqp10TokenRenewalEndpoint: false,
      amqp091ClosesAtCredentialExpiry: false,
      amqp091PreAuthFrame8192: false,
    });
  });

  it('M1-23 slice D each flag asks for the rule of its own name, and for that profile only', () => {
    const asked: { id: string; profile: CapabilityProfile }[] = [];
    const profile = profileOf('4.3.6');
    const only = (id: string): CapabilitySource => ({
      capability: (asking, given) => {
        asked.push({ id: asking, profile: given });
        return asking === id;
      },
    });
    const callbackFor = (id: string) =>
      createRegistryCapabilities({
        registry: only(id),
        profileFor: (connectionId) =>
          connectionId === 'c9' ? profile : undefined,
      });
    expect(callbackFor('amqp10TokenRenewalEndpoint')('c9')).toEqual({
      amqp10TokenRenewalEndpoint: true,
      amqp091ClosesAtCredentialExpiry: false,
      amqp091PreAuthFrame8192: false,
    });
    expect(callbackFor('amqp091ClosesAtCredentialExpiry')('c9')).toEqual({
      amqp10TokenRenewalEndpoint: false,
      amqp091ClosesAtCredentialExpiry: true,
      amqp091PreAuthFrame8192: false,
    });
    expect(callbackFor('amqp091PreAuthFrame8192')('c9')).toEqual({
      amqp10TokenRenewalEndpoint: false,
      amqp091ClosesAtCredentialExpiry: false,
      amqp091PreAuthFrame8192: true,
    });
    expect(asked.every((call) => call.profile === profile)).toBe(true);
    expect(asked.map((call) => call.id).sort()).toEqual([
      'amqp091ClosesAtCredentialExpiry',
      'amqp091ClosesAtCredentialExpiry',
      'amqp091ClosesAtCredentialExpiry',
      'amqp091PreAuthFrame8192',
      'amqp091PreAuthFrame8192',
      'amqp091PreAuthFrame8192',
      'amqp10TokenRenewalEndpoint',
      'amqp10TokenRenewalEndpoint',
      'amqp10TokenRenewalEndpoint',
    ]);
    // A connection with no profile proves nothing and asks the registry nothing.
    asked.length = 0;
    expect(callbackFor('amqp10TokenRenewalEndpoint')('unknown')).toEqual({
      amqp10TokenRenewalEndpoint: false,
      amqp091ClosesAtCredentialExpiry: false,
      amqp091PreAuthFrame8192: false,
    });
    expect(asked).toEqual([]);
  });

  it('M1-23 slice D a rule the registry lacks reaches the caller as a SemanticsGapError, uncaught', () => {
    const gap: CapabilitySource = {
      capability: (id) => {
        throw new SemanticsGapError({ table: 'capability', id });
      },
    };
    const callback = createRegistryCapabilities({
      registry: gap,
      profileFor: () => profileOf('4.3.6'),
    });
    expect(() => callback('c1')).toThrow(SemanticsGapError);
    // Each rule alone: a registry that lacks any one of the three is a gap, never a default.
    for (const missing of [
      'amqp10TokenRenewalEndpoint',
      'amqp091ClosesAtCredentialExpiry',
      'amqp091PreAuthFrame8192',
    ]) {
      const partial = createRegistryCapabilities({
        registry: {
          capability: (id) => {
            if (id === missing) {
              throw new SemanticsGapError({ table: 'capability', id });
            }
            return true;
          },
        },
        profileFor: () => profileOf('4.3.6'),
      });
      expect(() => partial('c1'), missing).toThrow(SemanticsGapError);
    }
  });
});

// -- the manager on top of the feed ---------------------------------------------------------

interface Rig {
  readonly calls: { method: string; arg?: unknown }[];
  readonly manager: ReturnType<typeof createTokenManager>;
  readonly timers: ReturnType<typeof createManualTimers>;
  readonly clock: ReturnType<typeof createManualClock>;
}

/** Tokens: the first lives LIFETIME for alice, every renewal fails (so the token runs out). */
function rig(
  capabilities: (
    connectionId: string,
  ) => ReturnType<ReturnType<typeof createRegistryCapabilities>>,
  tokenBytes = 10,
): Rig {
  const clock = createManualClock(0);
  const timers = createManualTimers(clock);
  const calls: Rig['calls'] = [];
  let first = true;
  const provider: CredentialProvider = {
    kind: 'client-credentials',
    acquire: () => {
      if (!first) {
        return Promise.reject(
          new AppError('BROKER_UNREACHABLE', { detail: 'down' }),
        );
      }
      first = false;
      const credential: IssuedCredential = {
        kind: 'bearer',
        token: new SecretValue('a'.repeat(tokenBytes)),
        issuedAt: 0,
        expiresAt: LIFETIME,
        username: 'alice',
      };
      return Promise.resolve(credential);
    },
  };
  const auth: ConnectionAuthPort = {
    updateSecret: () => {
      calls.push({ method: 'updateSecret' });
      return Promise.resolve();
    },
    putAuthToken: () => {
      calls.push({ method: 'putAuthToken' });
      return Promise.resolve();
    },
    reconnect: (_id, protocol) => {
      calls.push({ method: 'reconnect', arg: protocol });
      return Promise.resolve();
    },
    cancelOwnConsumers: () => {
      calls.push({ method: 'cancelOwnConsumers' });
      return Promise.resolve({ cancelled: 2 });
    },
    onCredentialExpiredClose: () => () => undefined,
  };
  const manager = createTokenManager({
    providers: { providerFor: () => Promise.resolve(provider) },
    auth,
    capabilities,
    clock,
    timers,
  });
  return { calls, manager, timers, clock };
}

const registryRig = (version: string, tokenBytes?: number): Rig =>
  rig(
    createRegistryCapabilities({
      registry: semanticsRegistry,
      profileFor: () => profileOf(version),
    }),
    tokenBytes,
  );

const count = (r: Rig, method: string): number =>
  r.calls.filter((call) => call.method === method).length;

describe('the TokenManager fed by the registry, end to end (M1-23, slice D)', () => {
  it('M1-23 slice D at expiry the engine cancels its own consumers on 4.2.5 and waits for the 320 close on 4.2.6', async () => {
    const old = registryRig('4.2.5');
    await old.manager.credentialFor('c1', 'amqp', signal);
    old.manager.track({ connectionId: 'c1', protocol: 'amqp091' });
    await old.timers.advance(LIFETIME);
    expect(old.manager.state('c1', 'amqp')?.state).toBe('expired');
    expect(count(old, 'cancelOwnConsumers')).toBe(1);
    expect(old.manager.state('c1', 'amqp')?.consumersCancelled).toBe(2);

    const current = registryRig('4.2.6');
    await current.manager.credentialFor('c1', 'amqp', signal);
    current.manager.track({ connectionId: 'c1', protocol: 'amqp091' });
    await current.timers.advance(LIFETIME);
    expect(current.manager.state('c1', 'amqp')?.state).toBe('expired');
    expect(count(current, 'cancelOwnConsumers')).toBe(0);
    expect(current.manager.stats().capabilityErrors).toBe(0);
  });

  it('M1-23 slice D a registry without the rule counts the gap and takes the conservative branches (F1)', async () => {
    const gap: CapabilitySource = {
      capability: (id) => {
        throw new SemanticsGapError({ table: 'capability', id });
      },
    };
    const r = rig(
      createRegistryCapabilities({
        registry: gap,
        profileFor: () => profileOf('4.3.6'),
      }),
    );
    await r.manager.credentialFor('c1', 'amqp', signal);
    r.manager.track({ connectionId: 'c1', protocol: 'amqp091' });
    // The expiry timer callback must not throw; the engine cancels its own consumers.
    await r.timers.advance(LIFETIME);
    expect(r.manager.stats().capabilityErrors).toBeGreaterThan(0);
    expect(count(r, 'cancelOwnConsumers')).toBe(1);
    expect(r.manager.state('c1', 'amqp')?.state).toBe('expired');

    // A login is measured against the smaller frame when the rule cannot be read: 3,100 token
    // bytes are 3,102 + 1,024 = 4,126 bytes, over 4,096, though the new limit would allow it.
    const small = rig(
      createRegistryCapabilities({
        registry: gap,
        profileFor: () => profileOf('4.3.6'),
      }),
      3100,
    );
    const before = small.manager.stats().capabilityErrors;
    const resolved = await small.manager.credentialFor('c1', 'amqp', signal);
    expect(resolved.warnings.map((w) => w.code)).toEqual([
      'PLAIN_RESPONSE_LARGE',
    ]);
    expect(resolved.warnings[0]?.limit).toBe(4096);
    expect(small.manager.stats().capabilityErrors).toBe(before + 1);
    // An HTTP header does not depend on the broker, so the registry is not asked for it.
    const header = rig(
      createRegistryCapabilities({
        registry: gap,
        profileFor: () => profileOf('4.3.6'),
      }),
      4100,
    );
    const viaHttp = await header.manager.credentialFor('c1', 'http', signal);
    expect(viaHttp.warnings.map((w) => w.code)).toEqual([
      'BEARER_HEADER_LARGE',
    ]);
    expect(header.manager.stats().capabilityErrors).toBe(0);
  });

  it('M1-23 slice D the pre-auth frame limit follows the broker era', async () => {
    // 3,100 token bytes: over the 4,096 limit with the headroom, under the 8,192 one.
    const legacy = await registryRig('4.0.9', 3100).manager.credentialFor(
      'c1',
      'amqp',
      signal,
    );
    expect(legacy.warnings).toHaveLength(1);
    expect(legacy.warnings[0]?.limit).toBe(4096);
    const current = await registryRig('4.1.0', 3100).manager.credentialFor(
      'c1',
      'amqp',
      signal,
    );
    expect(current.warnings).toEqual([]);
  });

  it('M1-23 slice D a failing registry does not stop an AMQP 1.0 renewal: it reconnects', async () => {
    const gap: CapabilitySource = {
      capability: (id) => {
        throw new SemanticsGapError({ table: 'capability', id });
      },
    };
    // A renewal that succeeds: the provider here keeps giving fresh tokens.
    const clock = createManualClock(0);
    const timers = createManualTimers(clock);
    const calls: string[] = [];
    let n = 0;
    const provider: CredentialProvider = {
      kind: 'client-credentials',
      acquire: () => {
        n += 1;
        const now = clock.now();
        return Promise.resolve({
          kind: 'bearer',
          token: new SecretValue(`token-${String(n)}`),
          issuedAt: now,
          expiresAt: now + LIFETIME,
          username: 'alice',
        } satisfies IssuedCredential);
      },
    };
    const auth: ConnectionAuthPort = {
      updateSecret: () => Promise.resolve(),
      putAuthToken: () => {
        calls.push('putAuthToken');
        return Promise.resolve();
      },
      reconnect: () => {
        calls.push('reconnect');
        return Promise.resolve();
      },
      cancelOwnConsumers: () => Promise.resolve({ cancelled: 0 }),
      onCredentialExpiredClose: () => () => undefined,
    };
    const manager = createTokenManager({
      providers: { providerFor: () => Promise.resolve(provider) },
      auth,
      capabilities: createRegistryCapabilities({
        registry: gap,
        profileFor: () => profileOf('4.3.6'),
      }),
      clock,
      timers,
    });
    await manager.credentialFor('c1', 'amqp', signal);
    manager.track({ connectionId: 'c1', protocol: 'amqp10' });
    await timers.advance((LIFETIME * 3) / 4);
    expect(calls).toEqual(['reconnect']);
    // one for the size preflight of the first login, one for the push
    expect(manager.stats().capabilityErrors).toBe(2);
  });
});
