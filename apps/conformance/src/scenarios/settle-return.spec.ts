// CF-SETTLE-01 on the in-memory host: its shape, and that it records no secret. The memory host proves the plumbing only.
import { describe, expect, it } from 'vitest';

import { defineScenario, runScenario } from '../dsl.ts';
import { sealArtefact } from '../record/evidence.ts';
import { findSecrets } from '../record/secrets.ts';
import {
  DIGEST,
  MemoryHost,
  VERSION,
  localProvenance,
} from '../testing/lab.ts';
import { cfSettle01 } from './cf-settle-01.ts';
import { FIN_LIMIT, UNSET_ROUNDS } from './settle-return.ts';

const LIMITS = { unset: undefined, fin: FIN_LIMIT, minus1: -1 };
const SINGLE = Object.keys(LIMITS).flatMap((l) => [`${l}-get`, `${l}-consume`]);

describe('CF-SETTLE-01', () => {
  it('AC-10 CF-SETTLE-01 is well formed, covers every limit and path, and records no secret', async () => {
    const steps = defineScenario(cfSettle01).steps;
    const declared = steps.filter((s) => s.op === 'declareQueue');
    const queues = declared.map((s) => s.queue);
    expect(queues).toEqual([...SINGLE, 'unset-rounds', 'fin-rounds']);
    // Quorum queues with no limit, a limit of 2 and -1.
    const limit = (q: string) => LIMITS[q.split('-')[0] as keyof typeof LIMITS];
    expect(
      declared.map((s) => [s.type, s.arguments['x-delivery-limit']]),
    ).toEqual(queues.map((q) => ['quorum', limit(q)]));
    // One return per single queue; the crossing queues return limit + 1 times; all are nacks with requeue.
    const taken = (q: string) =>
      steps.filter(
        (s) => (s.op === 'get' || s.op === 'consume') && s.queue === q,
      );
    expect(steps.filter((s) => s.op === 'consume')).toHaveLength(3);
    const expected = [1, 1, 1, 1, 1, 1, UNSET_ROUNDS, FIN_LIMIT + 1].join();
    expect(queues.map((q) => taken(q).length).join()).toBe(expected);
    const nacks = steps.filter((s) => s.op === 'settle');
    expect(nacks).toHaveLength(SINGLE.length + UNSET_ROUNDS + FIN_LIMIT + 1);
    expect(
      nacks.every((s) => s.action.kind === 'nack' && s.action.requeue),
    ).toBe(true);
    expect(nacks.every((s) => s.channel === undefined)).toBe(true);
    // A wait follows the last settle of every queue and comes before its drain.
    for (const q of queues) {
      const last = steps
        .map(
          (s) =>
            s.op === 'settle' &&
            'ref' in s.target &&
            s.target.ref.startsWith(`${q}-`),
        )
        .lastIndexOf(true);
      const at = (op: string) =>
        steps.findIndex((s) => s.op === op && 'queue' in s && s.queue === q);
      expect(last, q).toBeLessThan(at('awaitReady'));
      expect(at('awaitReady'), q).toBeLessThan(at('observe'));
    }

    const run = await runScenario(new MemoryHost(), cfSettle01, 'r1');
    const artefact = sealArtefact({
      ...{ schemaVersion: 1, cfId: 'CF-SETTLE-01', title: cfSettle01.title },
      ...{
        protocol: cfSettle01.protocol,
        brokerVersion: VERSION,
        imageDigest: DIGEST,
      },
      ...run,
      provenance: localProvenance,
    });
    expect(findSecrets(artefact, ['guest'])).toEqual([]);
    expect(JSON.stringify(artefact)).not.toMatch(/body|amqp:|http:|password/i);
    expect(artefact.observations).toHaveLength(2 * queues.length);
  }, 60_000);
});
