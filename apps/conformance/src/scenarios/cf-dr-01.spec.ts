// CF-DR-01 against the era broker (testing/era-broker.ts). The era broker encodes the registry's
// own claims, so these tests prove the plumbing (what the scenario records, what the projection
// reads); they say nothing about what RabbitMQ does.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registryData } from '@app/semantics';
import { afterAll, describe, expect, it } from 'vitest';

import { deliveredIds, projectDr01 } from '../assert/projections-dr.ts';
import { evaluateCase } from '../assert/run-case.ts';
import { runScenario } from '../dsl.ts';
import type { EvidenceArtefact } from '../record/evidence.ts';
import {
  CI_PROVENANCE,
  ERA_VERSION,
  EraBroker,
  recordOnEra,
  type Era,
} from '../testing/era-broker.ts';
import { DIGEST } from '../testing/lab.ts';
import { cfDr01, DR_LEGS, DR_TYPES, SLOTS, WAITS_MS } from './cf-dr-01.ts';
import { cfDr02 } from './cf-dr-02.ts';

const reads = (artefact: EvidenceArtefact, queue: string) =>
  deliveredIds(
    artefact,
    SLOTS.map((slot) => `${queue}-${slot}`),
  );
const stat = (artefact: EvidenceArtefact, queue: string, slot: string) =>
  artefact.steps.find(
    (step) =>
      step.op === 'mgmtQueue' && step.args.as === `${queue}-stats-${slot}`,
  )?.result;
const waits = (artefact: EvidenceArtefact) =>
  artefact.steps.filter((s) => s.op === 'wait').map((s) => s.args.ms);

const ERA: Era = '4.3';

describe('CF-DR-01', () => {
  it('AC-6 a nack-peek on delayed-retry all hides the message for about min', async () => {
    const artefact = await recordOnEra(ERA, cfDr01);
    expect(waits(artefact)).toEqual([...WAITS_MS]);
    for (const leg of DR_LEGS) {
      for (const type of DR_TYPES) {
        const queue = `${leg}-${type}`;
        // all and returned hide the message from a non-failed return until the last read; failed
        // and the control give it back at once, in front of the message behind it.
        const hidden = type === 'all' || type === 'returned';
        expect(reads(artefact, queue), queue).toEqual(
          hidden
            ? [`${queue}-t`, null, `${queue}-m`]
            : [`${queue}-m`, `${queue}-t`, null],
        );
        // The stats are read at each slot and only the status of the read is recorded.
        for (const slot of SLOTS) {
          expect(stat(artefact, queue, slot), `${queue} ${slot}`).toEqual({
            status: 200,
          });
        }
      }
    }
    // The projection speaks for the 0-9-1 nack and the HTTP read of a finite-limit queue under
    // all, failed and returned (six cells), with each cell's own position and counter deltas.
    const cells = registryData.cells.filter(
      (cell) => cell.conformance.includes('CF-DR-01') && cell.key.era === ERA,
    );
    const spoken = cells.filter((cell) => projectDr01(artefact, cell));
    expect(spoken).toHaveLength(6);
    for (const cell of spoken) {
      const { position, deltaAC, deltaDC } = cell.effect as Record<
        string,
        unknown
      >;
      expect(projectDr01(artefact, cell), cell.id).toEqual({
        position,
        deltaAC,
        deltaDC,
        destructive: false,
      });
    }
  });

  it('AC-2 (M0-FIX-1) CF-DR-01 records the same artefact whatever the statistics said at the moment of the read', async () => {
    // The statistics refresh on their own interval and may not be emitted yet, so what a read at a
    // fixed moment shows differs between two runs of one broker. Here the stats a broker answers
    // are replaced by another value, another class, or nothing at all.
    class Stats extends EraBroker {
      constructor(
        private readonly change: (
          stats: Record<string, unknown>,
        ) => Record<string, unknown>,
      ) {
        super(ERA);
      }
      override async management(call: { method: string; path: string }) {
        const answer = await super.management(call);
        const json = answer.json;
        if (typeof json !== 'object' || json === null || Array.isArray(json)) {
          return answer;
        }
        return {
          ...answer,
          json: this.change(json as Record<string, unknown>),
        };
      }
    }
    const recorded = async (broker: EraBroker) => {
      const run = await runScenario(
        broker,
        cfDr01,
        'r1',
        undefined,
        broker.clock,
      );
      return JSON.stringify({
        steps: run.steps,
        observations: run.observations,
      });
    };

    const plain = await recorded(new EraBroker(ERA));
    const scaled = (stats: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(stats).map(([key, value]) => [
          key,
          typeof value === 'number' ? value * 3 + 1 : value,
        ]),
      );
    for (const change of [
      scaled, // another value, and for a zero another class
      () => ({}), // before the first emission: no statistic at all
      () => ({ messages_delayed: 0, next_delayed_at: 1 }), // a stale zero
    ]) {
      expect(await recorded(new Stats(change))).toBe(plain);
    }
    // The stats steps are in the record (one per queue and slot), with the status alone.
    const stats = (
      JSON.parse(plain) as {
        steps: { op: string; result: Record<string, unknown> }[];
      }
    ).steps.filter((step) => step.op === 'mgmtQueue');
    expect(stats.length).toBe(DR_LEGS.length * DR_TYPES.length * SLOTS.length);
    for (const step of stats) expect(step.result).toEqual({ status: 200 });
  });
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it.each<Era>(['3.13', '4.0-4.2'])(
    'AC-8 on an era without delayed retry the message is visible at once and no cell is claimed (%s)',
    async (era) => {
      for (const scenario of [cfDr01, cfDr02]) {
        const artefact = await recordOnEra(era, scenario, {}, CI_PROVENANCE);
        // The arguments are accepted as declared; every queue gives its message back at once.
        for (const step of artefact.steps.filter(
          (s) => s.op === 'declareQueue',
        )) {
          expect(step.result, era).toEqual({ ok: true });
        }
        // The first read after the return (`now`, or `r1-p0` in CF-DR-02) delivers the message.
        const aliases = artefact.steps
          .filter((s) => s.op === 'get')
          .map((s) => s.args.as)
          .filter((as): as is string => typeof as === 'string')
          .filter((as) => /-(now|r1-p0)$/.test(as));
        const firsts = deliveredIds(artefact, aliases);
        expect(firsts.length, era).toBeGreaterThan(0);
        expect(
          firsts.every((id) => id?.endsWith('-m')),
          era,
        ).toBe(true);
        // CF-DR-01 reads the stats at every slot, on every era; none of what they say is recorded.
        if (scenario === cfDr01) {
          expect(stat(artefact, 'nack-all', 'now'), era).toEqual({
            status: 200,
          });
        }

        // No registry cell of these eras names the id, so even CI-stamped evidence is `unverified`.
        expect(
          registryData.cells.filter(
            (cell) =>
              cell.conformance.some((id) => id === scenario.cfId) &&
              cell.key.era === era,
          ),
          era,
        ).toEqual([]);
        const root = mkdtempSync(join(tmpdir(), 'conformance-dr-'));
        roots.push(root);
        mkdirSync(join(root, ERA_VERSION[era]), { recursive: true });
        writeFileSync(
          join(root, ERA_VERSION[era], `${scenario.cfId}.json`),
          JSON.stringify(artefact),
        );
        const lab = { version: ERA_VERSION[era], digest: DIGEST, era };
        const results = await evaluateCase(scenario.cfId, lab, null, {
          evidenceRoot: root,
        });
        expect(results.length, era).toBeGreaterThan(0);
        for (const result of results) {
          expect([result.verdict, result.reasons.length > 0], era).toEqual([
            'unverified',
            true,
          ]);
        }
      }
    },
  );
});
