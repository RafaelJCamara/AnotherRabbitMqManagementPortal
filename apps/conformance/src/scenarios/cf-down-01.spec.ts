// CF-DOWN-01 against the in-memory host (testing/lab.ts). The host holds no counter behaviour, so
// these tests prove the shape of the scenario and what the recorder writes; they say nothing about
// what RabbitMQ does (OQ-510).
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { runScenario, type LabScenario } from '../dsl.ts';
import {
  EvidenceError,
  sealArtefact,
  verifyEvidenceText,
} from '../record/evidence.ts';
import { recordCells } from '../record/record.ts';
import { findSecrets } from '../record/secrets.ts';
import {
  DIGEST,
  MemoryHost,
  localProvenance,
  mintEndpoint,
} from '../testing/lab.ts';
import { cfDown01 } from './cf-down-01.ts';

/** The same scenario with a one-poll wait, so the in-memory run does not sit through 19 x 5 polls. */
const quick: LabScenario = {
  ...cfDown01,
  steps: cfDown01.steps.map((step) =>
    step.op === 'awaitReady' ? { ...step, stableFor: 1 } : step,
  ),
};
const CANONICAL = join(import.meta.dirname, '../../../../testing/lab-evidence');
const listing = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : [];
const QUEUES =
  'unset-get unset-active unset-cancelled fin-get fin-active fin-cancelled minus1-get minus1-active minus1-cancelled fin-get-x fin-active-x fin-cancelled-x fin-conn';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('CF-DOWN-01 scenario', () => {
  it('AC-11 CF-DOWN-01 is well formed, covers every limit and path, and records no secret', async () => {
    const steps = cfDown01.steps;
    const declared = steps.flatMap((s) => (s.op === 'declareQueue' ? [s] : []));
    expect(declared.map((s) => s.queue).sort()).toEqual(
      QUEUES.split(' ').sort(),
    );
    expect(declared.every((s) => s.type === 'quorum')).toBe(true);
    expect(
      Object.fromEntries(declared.map((s) => [s.queue, s.arguments])),
    ).toMatchObject({
      'unset-get': {},
      'fin-get': { 'x-delivery-limit': 2 },
      'minus1-get': { 'x-delivery-limit': -1 },
    });
    expect(steps.filter((s) => s.op === 'publish')).toHaveLength(26);

    // The holder is never the observer: holds happen on `holder` or `doomed`, the drain on `main`.
    const on = new Map(
      steps.flatMap((s) =>
        s.op === 'openChannel' ? [[s.channel, s.connection] as const] : [],
      ),
    );
    for (const step of steps) {
      if (step.op === 'get' || step.op === 'consume') {
        expect(['holder', 'doomed']).toContain(on.get(step.channel));
      }
      if (step.op === 'observe') expect(step.channel).toBe('main');
      if (step.op === 'closeConnection') expect(step.connection).toBe('doomed');
    }

    const host = new MemoryHost();
    const run = await runScenario(host, quick, 'r1');
    // 7 consumers are left active (active path, 3 crossing rounds, the connection close); 6 are cancelled.
    expect(host.consumers.filter((c) => !c.cancelled)).toHaveLength(7);
    expect(host.consumers.filter((c) => c.cancelled)).toHaveLength(6);
    expect([...host.connections]).toEqual([
      ['main', true],
      ['holder', true],
      ['doomed', false],
    ]);
    const sealed = sealArtefact({
      schemaVersion: 1,
      cfId: cfDown01.cfId,
      title: cfDown01.title,
      protocol: 'amqp091',
      brokerVersion: '4.3.6',
      imageDigest: DIGEST,
      steps: run.steps,
      observations: run.observations,
      provenance: localProvenance,
    });
    expect(findSecrets(sealed, ['guest'])).toEqual([]);
    expect(JSON.stringify(sealed)).not.toMatch(
      /"(body|headers|url|password|username)"|https?:/i,
    );
  });

  it('AC-12 recording CF-DOWN-01 outside CI writes nothing into testing/lab-evidence', async () => {
    const before = listing(CANONICAL);
    const out = mkdtempSync(join(tmpdir(), 'conformance-down-'));
    roots.push(out);
    const options = {
      scenarios: [quick],
      endpoint: await mintEndpoint(),
      provenance: localProvenance,
      root: out,
      canonicalRoot: CANONICAL,
      runId: 'abcd1234',
      openHost: () => Promise.resolve(new MemoryHost()),
    };

    const [file = ''] = await recordCells(options);

    expect(file).toBe(join(out, '4.3.6', 'CF-DOWN-01.json'));
    const text = readFileSync(file, 'utf8');
    expect(
      verifyEvidenceText('4.3.6/CF-DOWN-01.json', text).provenance.kind,
    ).toBe('local');
    await expect(
      recordCells({ ...options, root: CANONICAL }),
    ).rejects.toSatisfy(
      (error) => error instanceof EvidenceError && error.code === 'refused',
    );
    expect(listing(CANONICAL)).toEqual(before);
  });
});
