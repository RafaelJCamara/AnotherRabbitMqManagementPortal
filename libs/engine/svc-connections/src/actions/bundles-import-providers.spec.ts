// M1-23 slice E3 (OQ-1455): the provider config of a profile lives in `credential_providers`, which is
// not part of the connection bundle. A bundle is a file a person can edit or receive, so it must not be
// a way to create a `token-command` config (a program the engine would run). The slice E7 review checks
// the rest of that path (the lookup and the delivery-mode gate).
import { ConnectionBundleSchema } from '@app/contracts';
import { createTestContext, createTestExecutor } from '@app/kernel';
import { describe, expect, it } from 'vitest';

import { createConnectionsFakeDeps } from '../testing';
import { createBundlesImportAction } from './bundles-import';
import { sampleBundle, sampleInput } from './bundles-import.fixture';

const KEY = 'slice-e3-bundle-key-0001';

describe('M1-23 slice E bundle: an import cannot create a provider config', () => {
  it.each([
    ['a top-level providers list', { providers: [] }],
    [
      'a top-level token command',
      { tokenCommand: { file: '/usr/bin/sh', args: ['-c', 'id'] } },
    ],
    ['a top-level credentialProviders table', { credentialProviders: {} }],
  ])('the bundle schema refuses %s', (_label, extra) => {
    const parsed = ConnectionBundleSchema.safeParse({
      ...sampleBundle,
      ...extra,
    });

    expect(parsed.success).toBe(false);
  });

  it.each([
    ['a provider on a profile', { provider: { kind: 'token-command' } }],
    ['a token command on a profile', { tokenCommand: '/usr/bin/sh' }],
    [
      'a provider on the AMQP half',
      {
        amqp: {
          ...(sampleBundle.profiles[0]?.amqp ?? {}),
          provider: { kind: 'token-command', file: '/usr/bin/sh' },
        },
      },
    ],
    [
      'a token command in the AMQP auth',
      {
        amqp: {
          ...(sampleBundle.profiles[0]?.amqp ?? {}),
          auth: { kind: 'plain', username: 'u', file: '/usr/bin/sh' },
        },
      },
    ],
  ])('the profile schema refuses %s', (_label, extra) => {
    const parsed = ConnectionBundleSchema.safeParse({
      ...sampleBundle,
      profiles: [{ ...sampleBundle.profiles[0], ...extra }],
    });

    expect(parsed.success).toBe(false);
  });

  it('an import stores the profile config with no provider settings, and its deps hold no provider store', async () => {
    const deps = createConnectionsFakeDeps({ empty: true });
    const engine = createTestExecutor();
    engine.executor.register(createBundlesImportAction(deps));
    const def = createBundlesImportAction(deps).def;
    const ctx = createTestContext({ idempotencyKey: KEY });

    const first = await engine.executor.run(def, sampleInput, ctx);
    const outcome =
      first.kind === 'planRequired'
        ? await engine.executor.execute(
            {
              planId: first.plan.id,
              consents: [...first.plan.consentsRequired],
              confirmation: first.plan.confirmationPhrase,
              idempotencyKey: KEY,
            },
            ctx,
          )
        : first;

    expect(outcome.kind).toBe('output');
    const page = await deps.store.list({
      visibleTo: ctx.principal.id,
      limit: 10,
    });
    expect(page.items).toHaveLength(1);
    const stored = JSON.stringify(page.items[0]?.config);
    expect(stored).not.toMatch(/provider|token-command|command/i);
    // The action's deps are the profile store and an id source: no provider store to write to.
    expect(Object.keys(deps).sort()).not.toContain('credentialProviders');
  });
});
