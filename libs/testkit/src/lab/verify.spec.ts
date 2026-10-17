import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { generateOAuthMaterial } from './material.ts';
import { startFakeBroker, type FakeBroker } from './fake-broker.ts';
import { exchangeTypes, extensionNames, verifyBroker } from './verify.ts';

let fake: FakeBroker | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const failed = (checks: { ok: boolean; name: string }[]): string[] =>
  checks.filter((check) => !check.ok).map((check) => check.name);

describe('verifyBroker', () => {
  it('AC-1 passes when 5672, 15672, 5552 and 15692 answer and the version equals the tag', async () => {
    fake = await startFakeBroker({ version: '4.3.6' });
    const checks = await verifyBroker({
      ...fake.handle,
      version: '4.3.6',
    });
    expect(failed(checks)).toEqual([]);
    expect(checks.map((check) => check.name)).toEqual([
      expect.stringMatching(/^amqp /),
      expect.stringMatching(/^stream /),
      expect.stringMatching(/^management /),
      'rabbitmq_version equals the tag',
      expect.stringMatching(/^prometheus /),
      '/api/extensions lists the plugins',
      'consistent-hash and event exchanges exist',
    ]);
  });

  it('AC-1 fails when /api/overview reports another version than the tag', async () => {
    fake = await startFakeBroker({ version: '4.3.5' });
    const checks = await verifyBroker({ ...fake.handle, version: '4.3.6' });
    expect(failed(checks)).toEqual(['rabbitmq_version equals the tag']);
  });

  it('AC-1 fails when the stream port does not answer', async () => {
    fake = await startFakeBroker({ version: '4.3.6', noStream: true });
    const checks = await verifyBroker(fake.handle);
    expect(failed(checks)).toEqual([expect.stringMatching(/^stream /)]);
  });

  it('AC-1 fails when Prometheus answers without rabbitmq metrics', async () => {
    fake = await startFakeBroker({
      version: '4.3.6',
      metrics: 'some_other_exporter 1\n',
    });
    const checks = await verifyBroker(fake.handle);
    expect(failed(checks)).toEqual([expect.stringMatching(/^prometheus /)]);
  });

  it('AC-1 fails with a reason when the management API refuses the credentials', async () => {
    fake = await startFakeBroker({ version: '4.3.6' });
    const checks = await verifyBroker({
      ...fake.handle,
      credentials: { username: 'guest', password: 'wrong' },
    });
    const management = checks.find((check) =>
      check.name.startsWith('management'),
    );
    expect(management).toMatchObject({ ok: false });
    expect(management?.detail).toContain('401');
  });

  it.each(['shovel', 'federation', 'stream', 'tracing'])(
    'AC-2 fails when /api/extensions does not list %s',
    async (plugin) => {
      fake = await startFakeBroker({
        version: '4.3.6',
        extensions: [
          'dispatcher',
          'shovel',
          'federation',
          'tracing',
          'stream',
        ].filter((name) => name !== plugin),
      });
      const checks = await verifyBroker(fake.handle);
      expect(failed(checks)).toEqual(['/api/extensions lists the plugins']);
      expect(checks.find((check) => !check.ok)?.detail).toContain(
        `missing ${plugin}`,
      );
    },
  );

  it('AC-2 fails when the consistent-hash exchange type is missing', async () => {
    fake = await startFakeBroker({
      version: '4.3.6',
      exchangeTypes: ['direct', 'fanout'],
    });
    const checks = await verifyBroker(fake.handle);
    expect(failed(checks)).toEqual([
      'consistent-hash and event exchanges exist',
    ]);
  });

  it('AC-2 fails when the event exchange is missing', async () => {
    fake = await startFakeBroker({ version: '4.3.6', eventExchange: false });
    const checks = await verifyBroker(fake.handle);
    expect(failed(checks)).toEqual([
      'consistent-hash and event exchanges exist',
    ]);
  });

  it('checks that a lab-signed token logs in on the OAuth variant', async () => {
    const oauth = generateOAuthMaterial(
      mkdtempSync(join(tmpdir(), 'broker-lab-verify-')),
    );
    const handle = { oauth, variant: 'oauth' as const };
    fake = await startFakeBroker({ version: '4.3.6', acceptTokens: true });
    expect(failed(await verifyBroker({ ...fake.handle, ...handle }))).toEqual(
      [],
    );
    await fake.close();
    fake = await startFakeBroker({ version: '4.3.6' });
    expect(failed(await verifyBroker({ ...fake.handle, ...handle }))).toEqual([
      'a lab-signed token logs in as administrator',
    ]);
  });

  it('checks three running nodes for the cluster', async () => {
    fake = await startFakeBroker({ version: '4.3.6', nodesRunning: 2 });
    const checks = await verifyBroker(
      { ...fake.handle, nodes: 3 },
      { clusterWaitMs: 50 },
    );
    expect(failed(checks)).toEqual(['three nodes are running']);
  });
});

describe('response readers', () => {
  it('extensionNames strips .js and ignores anything but javascript strings', () => {
    expect(
      extensionNames([
        { javascript: 'shovel.js' },
        { javascript: 3 },
        'x',
        { other: 'y' },
      ]),
    ).toEqual(['shovel']);
    expect(extensionNames({ javascript: 'shovel.js' })).toEqual([]);
  });

  it('extensionNames reads the list form and the empty entries of 4.3', () => {
    expect(
      extensionNames([
        { javascript: 'dispatcher.js' },
        { javascript: ['federation_management-ejs.js', 'federation.js'] },
        [],
        { javascript: ['tracing-ejs.js', 'tracing.js'] },
      ]),
    ).toEqual([
      'dispatcher',
      'federation_management-ejs',
      'federation',
      'tracing-ejs',
      'tracing',
    ]);
  });

  it('exchangeTypes reads the names from the overview', () => {
    expect(
      exchangeTypes({ exchange_types: [{ name: 'direct' }, { name: 1 }] }),
    ).toEqual(['direct']);
    expect(exchangeTypes(null)).toEqual([]);
  });
});
