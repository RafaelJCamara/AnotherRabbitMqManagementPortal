// Builders for the specs: fake evidence artefacts (sealed with the same digest rule the recorder
// uses), cell snapshots and a recorded-by-CI stamp. Nothing here is evidence: the specs keep it in
// memory or in temporary folders and never write testing/lab-evidence.
import { digestOf, type CiProvenance } from './evidence-format.ts';
import type { CellSnapshot } from './snapshot.ts';

export const SHA = 'a'.repeat(40);
export const DIGEST = `sha256:${'b'.repeat(64)}`;
export const REPOSITORY = 'acme/portal';

export const ciStamp = (change: Partial<CiProvenance> = {}): CiProvenance => ({
  kind: 'ci',
  recorder: 'conformance:record',
  gitSha: SHA,
  runUrl: `https://github.com/${REPOSITORY}/actions/runs/777/attempts/1`,
  workflow: `${REPOSITORY}/.github/workflows/conformance-record.yml@refs/heads/main`,
  recordedAt: '2026-10-19T10:00:00.000Z',
  ...change,
});

export interface Fake {
  readonly path: string;
  readonly text: string;
}

/** The text of a sealed artefact. `change` edits the body before it is sealed. */
export function fakeEvidence(
  options: {
    version?: string;
    cfId?: string;
    digest?: string;
    provenance?: Record<string, unknown>;
    body?: Record<string, unknown>;
  } = {},
): Fake {
  const version = options.version ?? '4.3.6';
  const cfId = options.cfId ?? 'CF-SMOKE-01';
  const body = {
    schemaVersion: 1,
    cfId,
    title: 'a fake scenario',
    protocol: 'amqp091',
    brokerVersion: version,
    imageDigest: options.digest ?? DIGEST,
    steps: [
      {
        index: 0,
        op: 'openChannel',
        args: { channel: 'main' },
        result: { ok: true },
      },
    ],
    observations: [],
    provenance: options.provenance ?? ciStamp(),
    ...options.body,
  };
  return {
    path: `${version}/${cfId}.json`,
    text: JSON.stringify({
      ...body,
      integrity: { algorithm: 'sha256', digest: digestOf(body) },
    }),
  };
}

export const cell = (change: Partial<CellSnapshot> = {}): CellSnapshot => ({
  id: 'SEM-4.3-quorum-amqp091-nack',
  keyString: '4.3|quorum|amqp091|amqp091.nack_requeue|-|-',
  era: '4.3',
  effect: { deltaAC: 1, deltaDC: 0, position: 'head' },
  status: 'code-derived',
  conformance: ['CF-SMOKE-01'],
  evidence: [],
  ...change,
});

export const evidencePath = (fake: Fake): string =>
  `testing/lab-evidence/${fake.path}`;
