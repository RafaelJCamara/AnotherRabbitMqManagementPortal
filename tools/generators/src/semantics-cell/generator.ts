// A code-derived semantics cell (blueprint 5.2, ADR-007) in libs/shared/semantics, linked to a
// conformance id. The library is created on first use. The cell is `code-derived` with no effect
// and no evidence: filling in the effect needs citations, and flipping the status needs a lab
// evidence artefact plus CODEOWNERS sign-off (I-14). Run `conformance-cell <CF-id>` next to
// create the lab-cell stub the cell points at.
import type { Tree } from '@nx/devkit';

import { ensureLibrary, type LibrarySpec } from '../shared/library.ts';
import { quote } from '../shared/names.ts';
import { appendToArray } from '../shared/source-edit.ts';
import { Writer } from '../shared/writer.ts';
import type { SemanticsCellOptions } from './schema.ts';

export const ERAS = ['3.13', '4.0-4.2', '4.3', '4.4'] as const;
export const QUEUE_TYPES = ['classic', 'quorum', 'stream'] as const;
export const PROTOCOLS = ['amqp091', 'amqp10', 'http'] as const;
export const SETTLE_ACTIONS = [
  'amqp091.nack_requeue',
  'amqp091.reject_requeue',
  'amqp091.no_requeue',
  'amqp10.released',
  'amqp10.modified_df_false',
  'amqp10.modified_df_true',
  'amqp10.rejected',
  'close_while_holding',
  'tcp_loss',
  'partition',
  'amqp10.detach_unsettled',
  'consumer_timeout',
  'http.ack_requeue_true',
] as const;
export const LIMIT_STATES = ['unset', 'finite', 'minus1'] as const;
export const DELAYED_RETRIES = [
  'disabled',
  'all',
  'failed',
  'returned',
] as const;

const ROOT = 'libs/shared/semantics';
const DATA = `${ROOT}/src/data/settle-matrix.data.ts`;
const CF_ID = /^CF-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

const union = (values: readonly string[]): string =>
  values.map(quote).join(' | ');

// Mirrors docs/architecture/core-interfaces.md, "@app/semantics". Keep the two in step.
const TYPES = `export type Era = ${union(ERAS)};
export type QueueType = ${union(QUEUE_TYPES)};
export type Protocol = ${union(PROTOCOLS)};
export type SettleAction =
${SETTLE_ACTIONS.map((action) => `  | ${quote(action)}`).join('\n')};
export type LimitState = ${union(LIMIT_STATES)};
export type DelayedRetry = ${union(DELAYED_RETRIES)};
export type CellId = \`SEM-\${string}\`;
export type ConformanceId = \`CF-\${string}\`;

export interface SettleEffect {
  deltaAC: 0 | 1;
  deltaDC: 0 | 1;
  countsTowardLimit: 'yes' | 'no' | 'if-dc-gt-limit' | 'if-limit-set';
  position:
    | 'head'
    | 'tail'
    | 'original'
    | 'delayed'
    | 'dlx-or-drop'
    | 'removed';
  destructive: boolean;
}

export interface SemanticsCell {
  id: CellId;
  key: {
    era: Era;
    queueType: QueueType;
    protocol: Protocol;
    action: SettleAction;
    limit?: LimitState;
    delayedRetry?: DelayedRetry;
  };
  /**
   * Null until the effect is derived from the cited sources. A lookup must treat a null effect as
   * a gap and fail closed (SemanticsGapError), exactly like a missing cell.
   */
  effect: SettleEffect | null;
  citations: { kind: 'S' | 'D' | 'RN' | 'GH' | 'M3' | 'LAB'; ref: string }[];
  conformance: ConformanceId[];
  status: 'code-derived' | 'lab-verified' | 'lab-contradicted';
  /** Paths testing/lab-evidence/<broker-version>/<CF-id>.json, recorded independently. */
  evidence: string[];
}
`;

function hostLibrary(): LibrarySpec {
  return {
    name: 'semantics',
    type: 'pure',
    runtime: 'isomorphic',
    root: ROOT,
    trustCritical: true,
    importPath: '@app/semantics',
    projectType: 'library',
    readme: {
      purpose:
        'The broker semantics registry (DC-01/02, ADR-007): typed data cells keyed by era, queue type, protocol and action, each linked to lab evidence recorded outside the registry.',
      publicApi: [
        '`settleMatrix`: the settle-matrix cells.',
        '`SemanticsCell` and its key types.',
      ],
      invariants: [
        'Version-dependent broker behaviour is data here and nowhere else (I-3, `@app/no-broker-version-compare`).',
        'A missing cell, or a cell with a null effect, is a gap: lookups fail closed.',
        'A cell leaves `code-derived` only with an evidence artefact in the same change and CODEOWNERS approval (I-14).',
        'Cell ids and keys are unique, and every cell names at least one conformance id.',
      ],
      proof: ['pnpm nx test semantics'],
    },
    files: {
      'src/index.ts': `export type {
  CellId,
  ConformanceId,
  DelayedRetry,
  Era,
  LimitState,
  Protocol,
  QueueType,
  SemanticsCell,
  SettleAction,
  SettleEffect,
} from './types';
export { settleMatrix } from './data/settle-matrix.data';
`,
      'src/types.ts': TYPES,
      'src/data/settle-matrix.data.ts': `import type { SemanticsCell } from '../types';

export const settleMatrix: readonly SemanticsCell[] = [];
`,
      'src/index.spec.ts': `import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('semantics public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual(['settleMatrix']);
  });
});
`,
      'src/data/settle-matrix.data.spec.ts': `import { describe, expect, it } from 'vitest';

import { settleMatrix } from './settle-matrix.data';

describe('settleMatrix', () => {
  it('has unique ids', () => {
    const ids = settleMatrix.map((cell) => cell.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has unique keys', () => {
    const keys = settleMatrix.map((cell) => JSON.stringify(cell.key));

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('links every cell to a conformance id', () => {
    for (const cell of settleMatrix) {
      expect(cell.conformance.length, cell.id).toBeGreaterThan(0);
    }
  });

  it('requires evidence for every cell that is not code-derived', () => {
    for (const cell of settleMatrix) {
      if (cell.status !== 'code-derived') {
        expect(cell.evidence.length, cell.id).toBeGreaterThan(0);
      }
    }
  });
});
`,
    },
  };
}

/** The options after the CLI quirk is undone: `--era=4.3` arrives as a number. */
type Cell = Omit<SemanticsCellOptions, 'era'> & { era: string };

export function cellId(options: Cell): string {
  const parts = [
    options.era,
    options.queueType,
    options.protocol,
    options.action,
    ...(options.limit ? [`limit-${options.limit}`] : []),
    ...(options.delayedRetry ? [`delayed-${options.delayedRetry}`] : []),
  ];
  return `SEM-${parts.join('-')}`;
}

export function cellSource(options: Cell): string {
  const key = [
    `era: ${quote(options.era)}`,
    `queueType: ${quote(options.queueType)}`,
    `protocol: ${quote(options.protocol)}`,
    `action: ${quote(options.action)}`,
    ...(options.limit ? [`limit: ${quote(options.limit)}`] : []),
    ...(options.delayedRetry
      ? [`delayedRetry: ${quote(options.delayedRetry)}`]
      : []),
  ].join(', ');
  return `{
    id: ${quote(cellId(options))},
    key: { ${key} },
    effect: null,
    citations: [],
    conformance: [${quote(options.cf)}],
    status: 'code-derived',
    evidence: [],
  }`;
}

function oneOf<T extends string>(
  values: readonly T[],
  value: string,
  flag: string,
): T {
  const found = values.find((candidate) => candidate === value);
  if (!found) {
    throw new Error(
      `--${flag} must be one of ${values.join(', ')}; got "${value}".`,
    );
  }
  return found;
}

export async function semanticsCellGenerator(
  tree: Tree,
  raw: SemanticsCellOptions,
): Promise<void> {
  const writer = new Writer(tree);
  const options: Cell = { ...raw, era: String(raw.era) };
  oneOf(ERAS, options.era, 'era');
  oneOf(QUEUE_TYPES, options.queueType, 'queue-type');
  oneOf(PROTOCOLS, options.protocol, 'protocol');
  oneOf(SETTLE_ACTIONS, options.action, 'action');
  if (options.limit) oneOf(LIMIT_STATES, options.limit, 'limit');
  if (options.delayedRetry) {
    oneOf(DELAYED_RETRIES, options.delayedRetry, 'delayed-retry');
  }
  if (!CF_ID.test(options.cf)) {
    throw new Error(
      `--cf "${options.cf}" must be a conformance id such as CF-QQ-42-GUARD-01.`,
    );
  }

  ensureLibrary(writer, hostLibrary());
  const data = writer.require(
    DATA,
    `${ROOT} exists but has no settle matrix; restore src/data/settle-matrix.data.ts.`,
  );
  if (data.includes(quote(cellId(options)))) {
    throw new Error(`${DATA} already has the cell ${cellId(options)}.`);
  }
  writer.write(
    DATA,
    appendToArray(data, DATA, 'settleMatrix', cellSource(options)),
  );

  await writer.flush();
}

export default semanticsCellGenerator;
