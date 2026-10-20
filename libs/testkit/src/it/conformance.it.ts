// Integration test of the evidence recorder against real lab brokers (M0-15).
// Run with `pnpm nx run conformance:it --versions=4.3.6`; it needs a Docker daemon.
//
// The recorder runs as a child process, exactly as `conformance:record` runs it, with the broker
// handed over in LAB_BROKER. It writes into a temporary folder only: this test never touches
// `testing/lab-evidence/**` (I-14, A-20).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startBroker } from '../broker-lab.ts';
import type { BrokerHandle } from '../lab/types.ts';

const versions = (process.env.IT_BROKER_VERSIONS ?? '4.3.6')
  .split(',')
  .filter((version) => version !== '');
const root = fileURLToPath(new URL('../../../../', import.meta.url));

const labBroker = (
  broker: BrokerHandle,
  change: Record<string, unknown> = {},
) =>
  JSON.stringify({
    version: broker.version,
    digest: broker.digest,
    amqp: broker.amqp,
    http: broker.http,
    container: broker.container,
    credentials: broker.credentials,
    ...change,
  });

const record = (cells: string, out: string, labBrokerJson: string) =>
  spawnSync(
    process.execPath,
    ['apps/conformance/src/record/cli.ts', `--cells=${cells}`, `--out=${out}`],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
      // Not the record workflow: the artefact is stamped `local`, whatever the CI service sets.
      env: {
        ...process.env,
        GITHUB_ACTIONS: '',
        GITHUB_WORKFLOW_REF: '',
        LAB_BROKER: labBrokerJson,
      },
    },
  );

describe.each(versions)('conformance:record against RabbitMQ %s', (version) => {
  let broker: BrokerHandle;
  let out: string;
  beforeAll(async () => {
    broker = await startBroker({ version });
    out = mkdtempSync(join(tmpdir(), 'conformance-it-'));
  });
  afterAll(async () => {
    await broker.stop();
    rmSync(out, { recursive: true, force: true });
  });

  it('AC-1 CF-SMOKE-01 (classic queue, get, nack with requeue) shows redelivered=true at position 0', () => {
    const result = record('CF-SMOKE-01', out, labBroker(broker));

    expect(result.status, result.stderr).toBe(0);
    const artefact = JSON.parse(
      readFileSync(join(out, version, 'CF-SMOKE-01.json'), 'utf8'),
    ) as {
      brokerVersion: string;
      imageDigest: string;
      provenance: { kind: string };
      observations: {
        messageId: string;
        position: number | null;
        redelivered: boolean | null;
      }[];
      integrity: { algorithm: string; digest: string };
    };
    expect(artefact.brokerVersion).toBe(version);
    expect(artefact.imageDigest).toBe(broker.digest);
    expect(artefact.provenance.kind).toBe('local');
    expect(artefact.integrity.algorithm).toBe('sha256');
    expect(
      artefact.observations.find((item) => item.messageId === 'm1'),
    ).toMatchObject({
      position: 0,
      redelivered: true,
    });
    expect(result.stdout + result.stderr).not.toContain(
      broker.credentials.password,
    );
  });

  it('the raw drivers report forbidden settles, settle with every AMQP 1.0 outcome and read the management API', () => {
    const result = spawnSync(
      process.execPath,
      ['apps/conformance/src/it/drivers-smoke.ts'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, LAB_BROKER: labBroker(broker) },
      },
    );

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`drivers-smoke ok on ${version}`);
  });

  it('AC-2 the three-way live leg tells a run that matches its recorded evidence from one that differs, on a real broker', () => {
    const result = spawnSync(
      process.execPath,
      ['apps/conformance/src/it/three-way-smoke.ts'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, LAB_BROKER: labBroker(broker) },
      },
    );

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`three-way-smoke ok on ${version}`);
  });

  it('AC-13 CF-DOWN-01 is deterministic across two live runs', () => {
    const result = spawnSync(
      process.execPath,
      ['apps/conformance/src/it/down-determinism.ts'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 300_000,
        env: { ...process.env, LAB_BROKER: labBroker(broker) },
      },
    );

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`down-determinism ok on ${version}`);
  }, 330_000);

  it('AC-5 (M0-FIX-1) CF-DR-01 and CF-DR-02 are deterministic across two live runs', () => {
    // Each scenario waits about 6 to 22 s on the broker's own clock, four times in all.
    const result = spawnSync(
      process.execPath,
      ['apps/conformance/src/it/dr-determinism.ts'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 420_000,
        env: { ...process.env, LAB_BROKER: labBroker(broker) },
      },
    );

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`dr-determinism ok on ${version}`);
  }, 450_000);

  it('AC-2 refuses a listener that broker-lab did not create, even on the loopback address, and records nothing', async () => {
    const stranger: Server = createServer();
    await new Promise<void>((resolve) =>
      stranger.listen(0, '127.0.0.1', resolve),
    );
    const address = stranger.address();
    const port =
      typeof address === 'object' && address !== null ? address.port : 0;
    const target = mkdtempSync(join(tmpdir(), 'conformance-it-refused-'));
    try {
      const result = record(
        'CF-SMOKE-01',
        target,
        labBroker(broker, { amqp: `amqp://127.0.0.1:${String(port)}` }),
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(
        /AMQP port is not the one broker-lab published/,
      );
      expect(readdirSync(target)).toEqual([]);
    } finally {
      stranger.close();
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('AC-2 refuses an address that is not on the loopback interface, and a container that is not the lab broker', () => {
    const target = mkdtempSync(join(tmpdir(), 'conformance-it-refused-'));
    try {
      const remote = record(
        'CF-SMOKE-01',
        target,
        labBroker(broker, { http: 'http://203.0.113.9:15672' }),
      );
      const other = record(
        'CF-SMOKE-01',
        target,
        labBroker(broker, { container: 'not-a-lab-container' }),
      );

      expect(remote.status).toBe(1);
      expect(remote.stderr).toMatch(/must be http:\/\/127\.0\.0\.1:<port>/);
      expect(other.status).toBe(1);
      expect(other.stderr).toMatch(/not named like a broker-lab/);
      expect(readdirSync(target)).toEqual([]);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
