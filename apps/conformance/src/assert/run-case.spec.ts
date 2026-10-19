// The live leg and the glue of one lab cell: a fake Docker and an in-memory broker stand in for the
// lab; the evidence is a sealed fake in a temporary folder (never testing/lab-evidence).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SemanticsCell } from '@app/semantics';
import { afterAll, describe, expect, it } from 'vitest';
import { cfSmoke01 } from '../scenarios/cf-smoke-01.ts';
import { sealArtefact, type EvidenceProvenance } from '../record/evidence.ts';
import {
  brokerData,
  DIGEST,
  fakeDocker,
  mintEndpoint,
  MemoryHost,
  pinned,
  VERSION,
} from '../testing/lab.ts';
import { describeThreeWay } from './cell-spec.ts';
import type { LabVersion } from './lab-versions.ts';
import { openLiveFromEnv, runLive, type LiveBroker } from './live.ts';
import { evaluateCase, settleCase } from './run-case.ts';

const CI: EvidenceProvenance = {
  kind: 'ci',
  recorder: 'conformance:record',
  gitSha: 'a'.repeat(40),
  runUrl: 'https://github.com/acme/portal/actions/runs/1/attempts/1',
  workflow:
    'acme/portal/.github/workflows/conformance-record.yml@refs/heads/main',
  recordedAt: '2026-10-19T10:00:00.000Z',
};
const LAB: LabVersion = { version: VERSION, digest: DIGEST, era: '4.3' };
const CELL: SemanticsCell = {
  id: 'SEM-4.3-classic-amqp091-nack',
  key: {
    era: '4.3',
    queueType: 'classic',
    protocol: 'amqp091',
    action: 'amqp091.nack_requeue',
  },
  effect: {
    deltaAC: 1,
    deltaDC: 0,
    countsTowardLimit: 'no',
    position: 'head',
    destructive: false,
  },
  citations: [],
  conformance: ['CF-SMOKE-01'],
  status: 'code-derived',
  evidence: [],
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function broker(host = new MemoryHost()): Promise<LiveBroker> {
  return { endpoint: await mintEndpoint(), open: () => Promise.resolve(host) };
}

/** A temporary evidence tree holding the artefact of a real run of CF-SMOKE-01 on the in-memory broker. */
async function recorded(provenance: EvidenceProvenance = CI): Promise<string> {
  const live = await runLive(await broker(), cfSmoke01, 'rec1');
  const root = mkdtempSync(join(tmpdir(), 'conformance-case-'));
  roots.push(root);
  mkdirSync(join(root, VERSION), { recursive: true });
  const artefact = sealArtefact({
    schemaVersion: 1,
    cfId: live.cfId,
    title: live.title,
    protocol: 'amqp091',
    brokerVersion: live.brokerVersion,
    imageDigest: live.imageDigest,
    steps: [...live.steps],
    observations: [...live.observations],
    provenance,
  });
  writeFileSync(
    join(root, VERSION, 'CF-SMOKE-01.json'),
    JSON.stringify(artefact),
  );
  return root;
}

describe('live leg', () => {
  it('AC-2 runs the scenario and records what an artefact records, with the broker version and the pinned digest', async () => {
    const live = await runLive(await broker(), cfSmoke01, 'r1');

    expect(live).toMatchObject({
      cfId: 'CF-SMOKE-01',
      brokerVersion: VERSION,
      imageDigest: DIGEST,
      protocol: 'amqp091',
    });
    expect(live.steps.map((step) => step.op)).toEqual([
      'declareQueue',
      'publish',
      'publish',
      'get',
      'settle',
      'observe',
    ]);
    expect(
      live.observations.find((item) => item.messageId === 'm1'),
    ).toMatchObject({ position: 0, redelivered: true });
  });

  it('AC-2 refuses a live broker that serves another version than the lab pinned, and closes the connection', async () => {
    const wrong = new MemoryHost('4.2.9');
    const unreadable = new MemoryHost(null);

    await expect(runLive(await broker(wrong), cfSmoke01)).rejects.toThrow(
      'serves 4.2.9',
    );
    await expect(runLive(await broker(unreadable), cfSmoke01)).rejects.toThrow(
      'unreadable version',
    );
    expect([wrong.closedCount, unreadable.closedCount]).toEqual([1, 1]);
  });

  it('AC-2 runs every live run on a connection of its own, closed after it', async () => {
    const hosts: MemoryHost[] = [];
    const live = {
      endpoint: await mintEndpoint(),
      open: () => {
        const host = new MemoryHost();
        hosts.push(host);
        return Promise.resolve(host);
      },
    };

    const first = await runLive(live, cfSmoke01, 'r1');
    const second = await runLive(live, cfSmoke01, 'r2');

    expect(hosts.map((host) => host.closedCount)).toEqual([1, 1]);
    expect(second.steps).toEqual(first.steps);
  });

  it('opens no broker without LAB_BROKER, and one only after Docker confirms it is a lab broker', async () => {
    const opened: MemoryHost[] = [];
    const deps = {
      docker: fakeDocker(),
      pinnedDigests: pinned,
      openHost: () => {
        const host = new MemoryHost();
        opened.push(host);
        return Promise.resolve(host);
      },
    };

    expect(await openLiveFromEnv({}, deps)).toBeNull();
    expect(await openLiveFromEnv({ LAB_BROKER: '' }, deps)).toBeNull();
    const live = await openLiveFromEnv(
      { LAB_BROKER: JSON.stringify(brokerData()) },
      deps,
    );
    expect(live?.endpoint.version).toBe(VERSION);
    expect(opened).toHaveLength(0);
    await live?.open();
    await live?.open();
    expect(opened).toHaveLength(2);
    await expect(
      openLiveFromEnv(
        {
          LAB_BROKER: JSON.stringify(
            brokerData({ container: 'not-a-lab-container' }),
          ),
        },
        deps,
      ),
    ).rejects.toThrow('not named like a broker-lab');
  });
});
describe('one lab cell', () => {
  it('AC-2 passes when the live run, the recorded evidence and the registry cell agree', async () => {
    const root = await recorded();

    const results = await evaluateCase('CF-SMOKE-01', LAB, await broker(), {
      evidenceRoot: root,
      cells: [CELL],
    });

    expect(settleCase(results, true)).toBe('pass');
  });

  it('AC-2 fails with the diff when this broker answers differently from the recording', async () => {
    const root = await recorded();
    const host = new MemoryHost();
    const original = host.settle.bind(host);
    host.settle = async (...args) => {
      const outcome = await original(...args);
      for (const messages of host.queues.values())
        for (const message of messages) message.redelivered = false;
      return outcome;
    };

    const results = await evaluateCase('CF-SMOKE-01', LAB, await broker(host), {
      evidenceRoot: root,
      cells: [CELL],
    });

    expect(() => settleCase(results, false, () => undefined)).toThrow(
      '$.observations[0].redelivered: recorded true, live false',
    );
  });

  it('runs no live leg for another version, without a broker or without a scenario, and says so', async () => {
    const root = await recorded();
    const other: LabVersion = { ...LAB, version: '4.2.9', era: '4.0-4.2' };
    const logged: string[] = [];

    const forOther = await evaluateCase('CF-SMOKE-01', other, await broker(), {
      evidenceRoot: root,
      cells: [CELL],
    });
    const without = await evaluateCase('CF-SMOKE-01', LAB, null, {
      evidenceRoot: root,
      cells: [CELL],
    });
    const noScenario = await evaluateCase('CF-SMOKE-01', LAB, await broker(), {
      evidenceRoot: root,
      cells: [CELL],
      scenarios: [],
    });

    expect(forOther.map((r) => r.live.state)).toEqual(['not-run']);
    expect(without.map((r) => r.live.state)).toEqual(['not-run']);
    expect(noScenario.map((r) => r.live.state)).toEqual(['not-run']);
    expect(settleCase(without, false, (text) => logged.push(text))).toBe(
      'unverified',
    );
    expect(logged.join()).toContain('no live run');
    expect(() => settleCase(without, true, () => undefined)).toThrow(
      'unverified',
    );
  });

  it('AC-2 fails closed on local evidence even when the live run matches it', async () => {
    const local: EvidenceProvenance = {
      kind: 'local',
      recorder: 'conformance:record',
      gitSha: null,
      recordedAt: CI.recordedAt,
    };
    const root = await recorded(local);

    const results = await evaluateCase('CF-SMOKE-01', LAB, await broker(), {
      evidenceRoot: root,
      cells: [CELL],
    });

    expect(() => settleCase(results, false, () => undefined)).toThrow(
      'provenance is local',
    );
  });
});

// The helper every lab-cell spec calls registers one test per version. Here it registers one that
// must pass: a live broker Docker confirms, sealed evidence and a matching registry cell.
const passingRoot = await recorded();
describeThreeWay('CF-SMOKE-01', {
  env: {
    CONFORMANCE_VERSIONS: VERSION,
    LAB_BROKER: JSON.stringify(brokerData()),
    CONFORMANCE_STRICT: '1',
  },
  versions: [LAB],
  cells: [CELL],
  deps: {
    docker: fakeDocker(),
    pinnedDigests: pinned,
    openHost: () => Promise.resolve(new MemoryHost()),
  },
  evidenceRoot: passingRoot,
});
