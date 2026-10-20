// CF-STAMP-01 against the era broker (testing/era-broker.ts). The era broker encodes the registry's
// own claims, so these tests prove the plumbing (the scenario records what the projection reads, and
// the projection reads only the control message); they say nothing about what RabbitMQ does.
import { registryData, type SemanticsCell } from '@app/semantics';
import { describe, expect, it } from 'vitest';

import { projectStamp01 } from '../assert/projections-stamp.ts';
import { runScenario } from '../dsl.ts';
import { sealArtefact, type EvidenceArtefact } from '../record/evidence.ts';
import {
  ERA_VERSION,
  EraBroker,
  type Era,
  type EraBrokerOptions,
} from '../testing/era-broker.ts';
import { DIGEST, localProvenance } from '../testing/lab.ts';
import { COPIED_DELIVERY_COUNT, cfStamp01 } from './cf-stamp-01.ts';

const ERAS: readonly Era[] = ['3.13', '4.0-4.2', '4.3'];

async function record(
  era: Era,
  options?: EraBrokerOptions,
): Promise<EvidenceArtefact> {
  const run = await runScenario(new EraBroker(era, options), cfStamp01, 'r1');
  return sealArtefact({
    schemaVersion: 1,
    cfId: cfStamp01.cfId,
    title: cfStamp01.title,
    protocol: 'amqp091',
    brokerVersion: ERA_VERSION[era],
    imageDigest: DIGEST,
    steps: run.steps,
    observations: run.observations,
    provenance: localProvenance,
  });
}

const cellsOf = (era: Era): SemanticsCell[] =>
  registryData.cells.filter(
    (cell) => cell.conformance.includes('CF-STAMP-01') && cell.key.era === era,
  );

/** The fields a cell claims that the era's headers cannot show, so the projection leaves them out (fact sheet b.1). */
const UNSHOWN: Readonly<Record<Era, readonly string[]>> = {
  '3.13': ['deltaAC'],
  '4.0-4.2': ['deltaDC'],
  '4.3': [],
};
const SPOKEN = ['deltaAC', 'deltaDC', 'position', 'destructive'] as const;

describe('CF-STAMP-01', () => {
  it("AC-3 the copied header is recorded on its own message and the cell's deltas come from the control message", async () => {
    let projected = 0;
    for (const era of ERAS) {
      const artefact = await record(era);
      const copy = artefact.steps.find(
        (step) => step.args.as === 'fin-first-copy',
      );
      // The copied value is recorded on the first delivery, on its own message only.
      expect(copy?.result['x-delivery-count']).toBe(COPIED_DELIVERY_COUNT);
      const first = artefact.steps.find(
        (step) => step.args.as === 'fin-first-control',
      );
      expect(first?.result['x-delivery-count']).toBeNull();

      expect(cellsOf(era).length).toBeGreaterThan(0);
      for (const cell of cellsOf(era)) {
        const observed = projectStamp01(artefact, cell);
        if (observed === null) {
          // Only a cell whose queue configuration the scenario did not run stays unspoken.
          expect(cell.key.limit).toBe('minus1');
          continue;
        }
        projected += 1;
        const effect = cell.effect as Record<string, unknown>;
        expect(observed, cell.id).toEqual(
          Object.fromEntries(
            SPOKEN.filter((field) => !UNSHOWN[era].includes(field)).map(
              (field) => [field, effect[field]],
            ),
          ),
        );
      }
    }
    // 3.13: the unset and finite cells; 4.0-4.2 and 4.3: the finite cell each (minus1 is not run).
    expect(projected).toBe(4);

    // A copied value that the broker keeps, or a broker that miscounts only the copy, moves nothing:
    // the projection reads the control message.
    const baseline = await record('4.3');
    for (const options of [
      { copiedAfterReturn: 'kept' },
      { skewed: 'fin-copy' },
      { skewed: 'none-copy' },
    ] as const) {
      const artefact = await record('4.3', options);
      for (const cell of cellsOf('4.3')) {
        expect(projectStamp01(artefact, cell)).toEqual(
          projectStamp01(baseline, cell),
        );
      }
    }
    // A miscounted control message does change a delta: that is a mismatch the assertion reports.
    const wrong = await record('4.3', { skewed: 'fin-control' });
    const cell = cellsOf('4.3').find((item) => item.key.limit === 'finite');
    if (cell === undefined) throw new Error('no finite 4.3 cell');
    expect(projectStamp01(wrong, cell)?.deltaAC).toBe(2);
    expect(projectStamp01(baseline, cell)?.deltaAC).toBe(1);
  });
});
