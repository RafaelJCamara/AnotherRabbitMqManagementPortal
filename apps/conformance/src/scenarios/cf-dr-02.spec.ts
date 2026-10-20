// CF-DR-02 against the era broker (testing/era-broker.ts). The era broker encodes the registry's
// own claims, so these tests prove the plumbing; they say nothing about what RabbitMQ does.
import { registryData } from '@app/semantics';
import { describe, expect, it } from 'vitest';

import {
  deliveredIds,
  firstVisible,
  projectDr02,
} from '../assert/projections-dr.ts';
import { recordOnEra, type Era } from '../testing/era-broker.ts';
import { cfDr02, DR2_TYPES, POINTS, ROUNDS, WAITS_MS } from './cf-dr-02.ts';

const ERA: Era = '4.3';

describe('CF-DR-02', () => {
  it('AC-7 a failed return is delayed by all and failed, grows with DC and stops at max', async () => {
    const artefact = await recordOnEra(ERA, cfDr02);
    // Three rounds of four reads, three fixed waits in each.
    expect(
      artefact.steps.filter((s) => s.op === 'wait').map((s) => s.args.ms),
    ).toEqual(Array.from({ length: ROUNDS }, () => [...WAITS_MS]).flat());
    for (const type of DR2_TYPES) {
      // all and failed hide a rejected message (the probe sees the message behind it first); the
      // others give it back at once.
      const hidden = type === 'all' || type === 'failed';
      const probe = `rej-${type}`;
      const ids = deliveredIds(
        artefact,
        POINTS.map((point) => `${probe}-r1-${point}`),
      );
      expect(ids, probe).toEqual(
        hidden
          ? [`${probe}-t`, null, `${probe}-m`, null]
          : [`${probe}-m`, `${probe}-t`, null, null],
      );
      // The first read that sees the grow message after each reject: delays of 3 s, 6 s, then 6 s
      // again (capped: uncapped it would be 9 s and not be seen by the last read, at 7.5 s).
      const grow = `grow-${type}`;
      const seen = Array.from({ length: ROUNDS }, (_, n) =>
        firstVisible(
          artefact,
          POINTS.map((point) => `${grow}-r${String(n + 1)}-${point}`),
          `${grow}-m`,
        ),
      );
      expect(seen, grow).toEqual(hidden ? [2, 3, 3] : [0, 0, 0]);
    }

    // The reject cells of a finite-limit queue under all, failed and returned are spoken for.
    const cells = registryData.cells.filter(
      (cell) => cell.conformance.includes('CF-DR-02') && cell.key.era === ERA,
    );
    const spoken = cells.filter((cell) => projectDr02(artefact, cell));
    expect(spoken).toHaveLength(3);
    for (const cell of spoken) {
      const { position, deltaAC, deltaDC } = cell.effect as Record<
        string,
        unknown
      >;
      expect(projectDr02(artefact, cell), cell.id).toEqual({
        position,
        deltaAC,
        deltaDC,
        destructive: false,
      });
    }
  });
});
