// The M0-12 cells (settle matrix, counters, DLX carry-over, delayed retry; fact sheet b.1, b.2, b.4
// and b.5), checked against an oracle written here from the fact sheet rows. The oracle answers for
// EVERY possible key (era x queue type x protocol x action x limit x delayed retry): a key it
// declares settled must have exactly the cell it describes, and every other key must be a gap. A
// changed value, a dropped cell or an extra cell therefore fails a test.
import { EraSchema, QueueTypeSchema } from '@app/domain-model';
import { describe, expect, it } from 'vitest';
import { auditCells } from '../audit.ts';
import { createRegistry } from '../registry.ts';
import {
  cellKeyString,
  DelayedRetrySchema,
  LimitStateSchema,
  ProtocolSchema,
  SemanticsCellSchema,
  SemanticsGapError,
  SettleActionSchema,
  type CellKey,
  type LimitState,
  type SettleAction,
  type SettleEffect,
} from '../schema.ts';
import { counters } from './counters.data.ts';
import { delayedRetry } from './delayed-retry.data.ts';
import { dlxCarryover } from './dlx-carryover.data.ts';
import { registryData } from './index.ts';
import { settleMatrix } from './settle-matrix.data.ts';

const registry = createRegistry(registryData);
const cells = registryData.cells;

type Row = readonly [
  ac: 0 | 1,
  dc: 0 | 1,
  counts: SettleEffect['countsTowardLimit'],
  position: SettleEffect['position'],
];
const effect = ([ac, dc, counts, position]: Row): SettleEffect => ({
  deltaAC: ac,
  deltaDC: dc,
  countsTowardLimit: counts,
  position,
  destructive: position === 'dlx-or-drop' || position === 'removed',
});

// ---- the oracle: fact sheet b.1, b.2, b.4 and b.5 ---------------------------------------
const REQUEUE = new Set<SettleAction>([
  'amqp091.nack_requeue',
  'amqp091.reject_requeue',
  'amqp10.released',
  'amqp10.modified_df_true',
  'amqp10.modified_df_false',
  'http.ack_requeue_true',
]);
const MODIFIED = new Set<SettleAction>([
  'amqp10.modified_df_true',
  'amqp10.modified_df_false',
]);
/** On 4.3 these raise the failure counter (DC) as well as the acquired counter (AC). */
const FAILED_RETURN = new Set<SettleAction>([
  'amqp091.reject_requeue',
  'amqp10.modified_df_true',
]);
const DEAD_LETTER = new Set<SettleAction>([
  'amqp091.no_requeue',
  'amqp10.rejected',
]);
const NATURAL: Partial<Record<SettleAction, 'amqp091' | 'amqp10' | 'http'>> = {
  'amqp091.nack_requeue': 'amqp091',
  'amqp091.reject_requeue': 'amqp091',
  'amqp091.no_requeue': 'amqp091',
  'amqp10.released': 'amqp10',
  'amqp10.modified_df_false': 'amqp10',
  'amqp10.modified_df_true': 'amqp10',
  'amqp10.rejected': 'amqp10',
  'amqp10.detach_unsettled': 'amqp10',
  'http.ack_requeue_true': 'http',
};
/** A connection or channel loss is a failed delivery on 4.3; the other broker events are returns. */
const FAILED_EVENT = new Set<SettleAction>(['close_while_holding', 'tcp_loss']);

const E313: Record<LimitState, Row> = {
  unset: [0, 1, 'no', 'tail'],
  finite: [0, 1, 'yes', 'head'],
  minus1: [0, 1, 'yes', 'dlx-or-drop'],
};

function must<T>(value: T | null | undefined): T {
  if (value === undefined || value === null)
    throw new Error('the oracle has no row for this key');
  return value;
}

function expected(key: CellKey): SettleEffect | undefined {
  const { era, queueType, protocol, action, limit, delayedRetry: dr } = key;
  if (queueType !== 'quorum' || era === '4.4') return undefined;
  const natural = NATURAL[action];
  if (natural !== undefined && protocol !== natural) return undefined;
  if (protocol === 'http' && natural === undefined) return undefined;

  // The dead-letter family: nothing depends on the limit or on delayed retry.
  if (
    DEAD_LETTER.has(action) ||
    (era === '3.13' && action === 'amqp10.modified_df_false')
  ) {
    if (limit !== undefined || dr !== undefined) return undefined;
    return effect(
      era === '3.13'
        ? [0, 0, 'no', 'dlx-or-drop']
        : [1, 1, 'no', 'dlx-or-drop'],
    );
  }

  if (REQUEUE.has(action)) {
    if (era === '3.13') {
      if (limit === undefined || dr !== undefined) return undefined;
      return effect(E313[limit]);
    }
    if (limit !== 'finite' && limit !== 'minus1') return undefined;
    if (era === '4.0-4.2') {
      if (dr !== undefined) return undefined;
      const finite = limit === 'finite';
      const counts = finite ? 'yes' : 'no';
      const tail = !finite && !MODIFIED.has(action);
      return effect([1, 0, counts, tail ? 'tail' : 'head']);
    }
    if (dr === undefined) return undefined;
    const failed = FAILED_RETURN.has(action);
    const delayed =
      dr === 'all' || (failed ? dr === 'failed' : dr === 'returned');
    const counts =
      limit === 'minus1' ? 'no' : failed ? 'yes' : 'if-dc-gt-limit';
    return effect([1, failed ? 1 : 0, counts, delayed ? 'delayed' : 'head']);
  }

  // The broker-side events.
  const timeout = action === 'consumer_timeout';
  const detach = action === 'amqp10.detach_unsettled';
  if (protocol === 'http') return undefined;
  if (timeout && protocol === 'amqp10' && era !== '4.3') return undefined;
  if (detach && era === '3.13') return undefined;
  if (limit === undefined) return undefined;
  if (era === '3.13') {
    return dr === undefined ? effect(E313[limit]) : undefined;
  }
  if (limit !== 'finite' && limit !== 'minus1') return undefined;
  const finite = limit === 'finite';
  if (era === '4.0-4.2') {
    if (dr !== undefined) return undefined;
    if (detach) return effect([1, 0, finite ? 'yes' : 'no', 'head']);
    return effect([1, 1, finite ? 'yes' : 'no', finite ? 'head' : 'tail']);
  }
  if (dr !== 'disabled') return undefined;
  if (FAILED_EVENT.has(action)) {
    return effect([1, 1, finite ? 'yes' : 'no', 'head']);
  }
  return effect([1, 0, finite ? 'if-dc-gt-limit' : 'no', 'head']);
}

const CF_SETTLE: Partial<Record<SettleAction, string>> = {
  'amqp091.nack_requeue': 'CF-SETTLE-01',
  'amqp091.reject_requeue': 'CF-SETTLE-02',
  'amqp10.released': 'CF-SETTLE-03',
  'amqp10.modified_df_true': 'CF-SETTLE-04',
  'http.ack_requeue_true': 'CF-SETTLE-05',
  'amqp10.modified_df_false': 'CF-SETTLE-06',
};
const CF_DOWN: Record<string, (protocol: string) => string> = {
  close_while_holding: (p) => (p === 'amqp091' ? 'CF-DOWN-01' : 'CF-DOWN-02'),
  tcp_loss: () => 'CF-DOWN-03',
  partition: () => 'CF-DOWN-04',
  'amqp10.detach_unsettled': () => 'CF-DOWN-05',
  consumer_timeout: () => 'CF-DOWN-06',
};

/** The conformance ids the fact sheet rows call for, for a key whose effect is `eff`. */
function expectedConformance(key: CellKey, eff: SettleEffect): string[] {
  const ids: string[] = [];
  const { action } = key;
  if (DEAD_LETTER.has(action)) {
    ids.push(action === 'amqp091.no_requeue' ? 'CF-CARRY-01' : 'CF-CARRY-02');
  } else if (REQUEUE.has(action)) {
    const inDelayedRetry =
      key.delayedRetry !== undefined && key.delayedRetry !== 'disabled';
    if (inDelayedRetry) {
      ids.push(FAILED_RETURN.has(action) ? 'CF-DR-02' : 'CF-DR-01');
    } else {
      ids.push(must(CF_SETTLE[action]));
      if (action === 'amqp091.nack_requeue') ids.push('CF-STAMP-01');
    }
  } else {
    ids.push(must(CF_DOWN[action])(key.protocol));
  }
  // The delay-count carry-over rule is what makes a 4.3 return count only when DC is past L.
  if (eff.countsTowardLimit === 'if-dc-gt-limit') ids.push('CF-CARRY-03');
  return ids.sort();
}

// ---- every possible key -----------------------------------------------------------------
function* allKeys(): Generator<CellKey> {
  for (const era of EraSchema.options) {
    for (const queueType of QueueTypeSchema.options) {
      for (const protocol of ProtocolSchema.options) {
        for (const action of SettleActionSchema.options) {
          for (const limit of [undefined, ...LimitStateSchema.options]) {
            for (const dr of [undefined, ...DelayedRetrySchema.options]) {
              yield {
                era,
                queueType,
                protocol,
                action,
                ...(limit === undefined ? {} : { limit }),
                ...(dr === undefined ? {} : { delayedRetry: dr }),
              };
            }
          }
        }
      }
    }
  }
}

const byKey = new Map(cells.map((cell) => [cellKeyString(cell.key), cell]));

describe('M0-12 cells against the fact sheet oracle', () => {
  it('every settled key has exactly the cell the fact sheet rows describe, and every other key is a gap', () => {
    let settled = 0;
    for (const key of allKeys()) {
      const want = expected(key);
      const label = cellKeyString(key);
      if (want === undefined) {
        expect(() => registry.cell(key), label).toThrow(SemanticsGapError);
      } else {
        settled += 1;
        expect(registry.cell(key).effect, label).toEqual(want);
      }
    }
    expect(settled).toBe(cells.length);
  });

  it('every cell links the conformance ids the fact sheet rows call for', () => {
    for (const cell of cells) {
      const want = expected(cell.key);
      expect(want, cell.id).toBeDefined();
      expect([...cell.conformance].sort(), cell.id).toEqual(
        expectedConformance(cell.key, must(want)),
      );
    }
  });

  it('no cell is settled for a classic queue, a stream or the 4.4 era (fail closed)', () => {
    for (const cell of cells) {
      expect(cell.key.queueType).toBe('quorum');
      expect(cell.key.era).not.toBe('4.4');
    }
    expect(() =>
      registry.cell({
        era: '4.3',
        queueType: 'classic',
        protocol: 'amqp091',
        action: 'amqp091.nack_requeue',
        limit: 'finite',
        delayedRetry: 'disabled',
      }),
    ).toThrow(SemanticsGapError);
    expect(() =>
      registry.cell({
        era: '4.4',
        queueType: 'quorum',
        protocol: 'amqp091',
        action: 'amqp091.nack_requeue',
        limit: 'finite',
        delayedRetry: 'disabled',
      }),
    ).toThrow(SemanticsGapError);
  });
});

describe('M0-12 cells: structural rules', () => {
  it('every cell is code-derived without evidence (I-14: only CI and a human move a status)', () => {
    for (const cell of cells) {
      expect(cell.status, cell.id).toBe('code-derived');
      expect(cell.evidence, cell.id).toEqual([]);
    }
  });

  it('passes the audit with citations, conformance and effect required, and every cell parses', () => {
    expect(
      auditCells(cells, { require: ['citations', 'conformance', 'effect'] }),
    ).toEqual([]);
    for (const cell of cells) {
      expect(SemanticsCellSchema.safeParse(cell).success, cell.id).toBe(true);
    }
  });

  it('the four files hold disjoint cells that add up to the registry', () => {
    const files = [settleMatrix, delayedRetry, dlxCarryover, counters];
    expect(files.map((file) => file.length)).toEqual([39, 36, 7, 55]);
    const ids = files.flatMap((file) => file.map((cell) => cell.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(cells.length);
    expect(registryData.cells.map((cell) => cell.id)).toEqual(ids);
  });

  it('each file keeps to its own family of conformance ids and key dimensions', () => {
    for (const cell of settleMatrix) {
      expect(
        cell.conformance.every((id) => /^CF-(SETTLE|STAMP|CARRY-03)/.test(id)),
        cell.id,
      ).toBe(true);
      expect(
        cell.key.delayedRetry === undefined ||
          cell.key.delayedRetry === 'disabled',
        cell.id,
      ).toBe(true);
    }
    for (const cell of delayedRetry) {
      expect(
        cell.conformance.every((id) => /^CF-(DR|CARRY-03)/.test(id)),
        cell.id,
      ).toBe(true);
      expect(cell.key.era, cell.id).toBe('4.3');
      expect(['all', 'failed', 'returned']).toContain(cell.key.delayedRetry);
    }
    for (const cell of dlxCarryover) {
      expect(
        cell.conformance.every((id) => /^CF-(CARRY|SETTLE-06)/.test(id)),
        cell.id,
      ).toBe(true);
    }
    for (const cell of counters) {
      expect(
        cell.conformance.every((id) => /^CF-(DOWN|CARRY-03)/.test(id)),
        cell.id,
      ).toBe(true);
    }
  });

  it('an effect is consistent: destructive means the message can leave the queue, delays exist only on 4.3, a conditional count only on 4.3', () => {
    for (const cell of cells) {
      const eff = must(cell.effect);
      expect(eff.destructive, cell.id).toBe(
        eff.position === 'dlx-or-drop' || eff.position === 'removed',
      );
      if (eff.position === 'delayed') {
        expect(cell.key.era, cell.id).toBe('4.3');
        expect(['all', 'failed', 'returned']).toContain(cell.key.delayedRetry);
      }
      if (eff.countsTowardLimit === 'if-dc-gt-limit') {
        expect(cell.key.era, cell.id).toBe('4.3');
        expect(cell.key.limit, cell.id).toBe('finite');
      }
      // 3.13 has no acquired counter; 4.0 and later always raise it when a message comes back.
      if (cell.key.era === '3.13') expect(eff.deltaAC, cell.id).toBe(0);
      if (cell.key.era !== '3.13' && eff.position !== 'dlx-or-drop') {
        expect(eff.deltaAC, cell.id).toBe(1);
      }
      // A message that is thrown away cannot also count toward a limit it can no longer reach.
      if (eff.position === 'dlx-or-drop' && cell.key.limit === undefined) {
        expect(eff.countsTowardLimit, cell.id).toBe('no');
      }
    }
  });

  it('every cell cites broker source of its own era at an exact tag, and never calls a read harmless', () => {
    const tags: Record<string, RegExp> = {
      '3.13': /^RS@v3\.13\.7:/,
      '4.0-4.2': /^RS@v4\.(0|1|2)\.\d+:/,
      '4.3': /^RS@v4\.3\.\d+:/,
    };
    for (const cell of cells) {
      const sources = cell.citations.filter((c) => c.kind === 'S');
      expect(sources.length, cell.id).toBeGreaterThan(0);
      for (const source of sources) {
        expect(source.ref, cell.id).toMatch(must(tags[cell.key.era]));
      }
      for (const citation of cell.citations) {
        expect(citation.ref, cell.id).not.toMatch(/non-destructive|read-only/i);
      }
    }
  });

  it('a cell lookup finds its own cell and no neighbour (the key is exact)', () => {
    for (const cell of cells) {
      expect(registry.cell(cell.key), cell.id).toEqual(
        byKey.get(cellKeyString(cell.key)),
      );
    }
  });
});
