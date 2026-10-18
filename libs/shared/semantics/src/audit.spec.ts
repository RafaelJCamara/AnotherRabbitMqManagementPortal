import { describe, expect, it } from 'vitest';
import { auditCells } from './audit.ts';
import type { SemanticsCell } from './schema.ts';

function cell(overrides: Partial<SemanticsCell> = {}): SemanticsCell {
  return {
    id: 'SEM-a',
    key: {
      era: '4.3',
      queueType: 'quorum',
      protocol: 'amqp091',
      action: 'amqp091.nack_requeue',
    },
    effect: null,
    citations: [],
    conformance: ['CF-SETTLE-01'],
    status: 'code-derived',
    evidence: [],
    ...overrides,
  };
}

const rules = (cells: SemanticsCell[], options = {}): string[] =>
  auditCells(cells, options).map((finding) => finding.rule);

describe('auditCells', () => {
  it('passes a generated, code-derived cell with a conformance id', () => {
    expect(rules([cell()])).toEqual([]);
    expect(rules([])).toEqual([]);
  });

  it('fails a cell without a conformance id, with or without the requirement flag', () => {
    expect(rules([cell({ conformance: [] })])).toEqual(['conformance']);
    expect(
      rules([cell({ conformance: [] })], { require: ['conformance'] }),
    ).toEqual(['conformance']);
  });

  it('checks citations and the derived effect only when required', () => {
    expect(rules([cell()], { require: ['citations'] })).toEqual(['citations']);
    expect(rules([cell()], { require: ['effect'] })).toEqual(['effect']);
    expect(
      rules([cell()], { require: ['citations', 'effect'] }).sort(),
    ).toEqual(['citations', 'effect']);
    const complete = cell({
      citations: [{ kind: 'S', ref: 'rabbit_fifo.erl@v4.3.6' }],
      effect: {
        deltaAC: 1,
        deltaDC: 0,
        countsTowardLimit: 'no',
        position: 'head',
        destructive: false,
      },
    });
    expect(
      rules([complete], { require: ['citations', 'effect', 'conformance'] }),
    ).toEqual([]);
  });

  it('reports duplicate ids and duplicate keys once per extra cell', () => {
    const same = cell();

    expect(rules([same, same]).sort()).toEqual([
      'duplicate-id',
      'duplicate-key',
    ]);
    expect(rules([same, cell({ id: 'SEM-b' })])).toEqual(['duplicate-key']);
  });

  it('fails a lab-verified or lab-contradicted cell that has no evidence', () => {
    expect(rules([cell({ status: 'lab-verified' })])).toEqual([
      'status-evidence',
    ]);
    expect(rules([cell({ status: 'lab-contradicted' })])).toEqual([
      'status-evidence',
    ]);
  });

  it("fails evidence that is not for one of the cell's conformance ids", () => {
    const wrong = cell({
      status: 'lab-verified',
      evidence: ['testing/lab-evidence/4.3.6/CF-OTHER-01.json'],
    });
    const right = cell({
      status: 'lab-verified',
      evidence: ['testing/lab-evidence/4.3.6/CF-SETTLE-01.json'],
    });

    expect(rules([wrong])).toEqual(['evidence-conformance']);
    expect(rules([right])).toEqual([]);
  });

  it('checks that evidence exists only when the caller can tell', () => {
    const verified = cell({
      status: 'lab-verified',
      evidence: ['testing/lab-evidence/4.3.6/CF-SETTLE-01.json'],
    });

    expect(rules([verified], { evidenceExists: () => false })).toEqual([
      'evidence-missing',
    ]);
    expect(rules([verified], { evidenceExists: () => true })).toEqual([]);
    expect(rules([verified])).toEqual([]);
  });

  it('names the offending cell', () => {
    const findings = auditCells([cell({ id: 'SEM-x', conformance: [] })]);

    expect(findings).toEqual([
      {
        cell: 'SEM-x',
        rule: 'conformance',
        message: 'names no conformance id',
      },
    ]);
  });
});
