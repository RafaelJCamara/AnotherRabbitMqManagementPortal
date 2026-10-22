// The interaction plan of the browser run (AC-27): a fixed pseudo-random sequence of scroll jumps, text filters,
// facet changes and sorts, each with the rows the page must show once it has answered. The rows come from an
// ORACLE (a second deterministic fake data port), so the page is checked by content and a step that would change
// nothing on screen is never planned (it would time no work). Pure and browser-free: it is unit-tested.
import {
  createFakeExplorerData,
  type FakeExplorerData,
} from '@app/explorer-model/testing';

export const QUEUES = 20_000;
export const VHOSTS = ['/', 'vhost-1', 'vhost-2', 'vhost-3'] as const;
export const SORT_COLUMNS_DEFAULT = ['name', 'vhost', 'type', 'state'] as const;
const CID = 'perf';

/** The same sequence on every run: an LCG, so a figure can be compared with the last one. */
export function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export type SortMark = 'ascending' | 'descending' | 'none';

export interface Expect {
  readonly matched: number;
  /** The rows that must be on screen, by index and name; empty means "no row matches" (the notice shows). */
  readonly rows: readonly { readonly index: number; readonly name: string }[];
  /** The sort mark the header of this column must carry; null when no sort was ever chosen. */
  readonly sort: { readonly column: string; readonly aria: SortMark } | null;
  /** The viewport's scroll position in rows: the index of the first row at its top (0 after any filter or sort). */
  readonly scrolledRows: number;
}

export type StepKind = 'scroll' | 'text-filter' | 'facet' | 'sort';

export type Step =
  | { readonly kind: 'scroll'; readonly index: number; readonly expect: Expect }
  | {
      readonly kind: 'text-filter';
      readonly text: string;
      readonly expect: Expect;
    }
  | {
      readonly kind: 'facet';
      readonly facet: 'types' | 'vhosts';
      readonly value: string;
      readonly checked: boolean;
      readonly expect: Expect;
    }
  | { readonly kind: 'sort'; readonly column: string; readonly expect: Expect };

/** A step without its expectation (which is read from the oracle once the step is applied to the model). */
type StepBody = Step extends infer S
  ? S extends Step
    ? Omit<S, 'expect'>
    : never
  : never;

/** What the page holds between steps. */
interface Model {
  text: string;
  types: string[];
  vhosts: string[];
  sort: { column: string; aria: 'ascending' | 'descending' } | null;
  /** The first row on screen. */
  index: number;
  matched: number;
}

const TEXTS = [
  'queue-00',
  '7',
  'QUEUE-1',
  'queue-0012',
  'queue-1',
  'queue-19',
  '99',
  'no-such-queue',
] as const;
const TYPES = ['classic', 'quorum', 'stream'] as const;
const VHOST_VALUES = ['vhost-1', 'vhost-2', 'vhost-3', '/'] as const;
const KINDS: readonly StepKind[] = [
  'scroll',
  'scroll',
  'text-filter',
  'facet',
  'sort',
];

/** The oracle: a fresh fake of the same 20,000 queues, answering from memory. */
export function createOracle(): FakeExplorerData {
  const fake = createFakeExplorerData({
    rows: { queues: QUEUES },
    vhosts: [...VHOSTS],
  });
  return fake;
}

/** The data port the page talks to (the same rows, answered over the network by the harness). */
export function createPageData(): FakeExplorerData {
  return createOracle();
}

type Filter = NonNullable<Parameters<FakeExplorerData['query']>[0]['filter']>;

function filterOf(model: Model): Filter | undefined {
  const filter: {
    text?: string;
    types?: string[];
    vhosts?: string[];
  } = {};
  if (model.text !== '') filter.text = model.text;
  if (model.types.length > 0) filter.types = [...model.types];
  if (model.vhosts.length > 0) filter.vhosts = [...model.vhosts];
  return Object.keys(filter).length === 0 ? undefined : filter;
}

async function look(
  oracle: FakeExplorerData,
  model: Model,
  index: number,
  count: number,
): Promise<{ matched: number; names: string[] }> {
  const filter = filterOf(model);
  const answer = await oracle.query(
    {
      cid: CID,
      kind: 'queues',
      ...(filter === undefined ? {} : { filter }),
      ...(model.sort === null
        ? {}
        : {
            sort: {
              column: model.sort.column,
              dir: model.sort.aria === 'ascending' ? 'asc' : 'desc',
            },
          }),
      window: { offset: index, limit: count },
    } as Parameters<FakeExplorerData['query']>[0],
    new AbortController().signal,
  );
  return {
    matched: answer.matched,
    names: answer.rows.map((row) => (row as { name: string }).name),
  };
}

async function expectOf(
  oracle: FakeExplorerData,
  model: Model,
  visible: number,
): Promise<Expect> {
  const seen = await look(oracle, model, model.index, visible);
  return {
    matched: seen.matched,
    rows: seen.names.map((name, offset) => ({
      index: model.index + offset,
      name,
    })),
    sort: model.sort === null ? null : { ...model.sort },
    scrolledRows: model.index,
  };
}

/** What the page shows, as one string: two steps with the same signature are the same screen. */
export function signature(expect: Expect): string {
  return JSON.stringify(expect);
}

export interface PlanOptions {
  readonly steps: number;
  readonly seed: number;
  /** Rows that are fully on screen below the header (the check covers this many from the top). */
  readonly visibleRows: number;
  /** A scroll jump never aims at the last this-many rows, where the list cannot scroll that far. */
  readonly tailRows: number;
  /** The sort columns whose header is on screen at the page size. */
  readonly sortColumns: readonly string[];
  readonly oracle?: FakeExplorerData;
}

/**
 * Plans `steps` interactions. Every step changes what is on screen (a different signature from the step before),
 * and every expectation was read from the oracle after applying the step to the model.
 */
export async function planInteractions(options: PlanOptions): Promise<Step[]> {
  const oracle = options.oracle ?? createOracle();
  const random = lcg(options.seed);
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)] as T;
  const model: Model = {
    text: '',
    types: [],
    vhosts: [],
    sort: null,
    index: 0,
    matched: QUEUES,
  };
  let previous = signature(await expectOf(oracle, model, options.visibleRows));
  const plan: Step[] = [];
  let guard = 0;
  while (plan.length < options.steps) {
    if (++guard > options.steps * 100) {
      throw new Error('the plan could not find a step that changes the screen');
    }
    const kind = pick(KINDS);
    const trial: Model = {
      ...model,
      types: [...model.types],
      vhosts: [...model.vhosts],
    };
    let step: StepBody | undefined;
    switch (kind) {
      case 'scroll': {
        const last = trial.matched - options.tailRows;
        if (last < 1) continue;
        const index = Math.floor(random() * (last + 1));
        if (index === trial.index) continue;
        trial.index = index;
        step = { kind, index };
        break;
      }
      case 'text-filter': {
        const text = pick(TEXTS);
        if (text === trial.text) continue;
        trial.text = text;
        trial.index = 0;
        step = { kind, text };
        break;
      }
      case 'facet': {
        const facet = random() < 0.6 ? 'types' : 'vhosts';
        const list = facet === 'types' ? trial.types : trial.vhosts;
        const value = facet === 'types' ? pick(TYPES) : pick(VHOST_VALUES);
        const checked = !list.includes(value);
        if (checked && list.length >= 2) continue;
        if (checked) list.push(value);
        else list.splice(list.indexOf(value), 1);
        trial.index = 0;
        step = { kind, facet, value, checked };
        break;
      }
      case 'sort': {
        const column = pick(options.sortColumns);
        const current = trial.sort;
        trial.sort =
          current?.column !== column
            ? { column, aria: 'ascending' }
            : current.aria === 'ascending'
              ? { column, aria: 'descending' }
              : null;
        // A third click on a column clears the sort, and the header then reads 'none'.
        trial.index = 0;
        step = { kind, column };
        break;
      }
    }
    const expect = await expectOf(oracle, trial, options.visibleRows);
    trial.matched = expect.matched;
    // The header of a column whose sort was just cleared must read 'none'.
    const adjusted: Expect =
      kind === 'sort' && trial.sort === null
        ? {
            ...expect,
            sort: {
              column: (step as { column: string }).column,
              aria: 'none',
            },
          }
        : expect;
    const sig = signature(adjusted);
    // A filter starts from the top of the list (the harness returns there first), so it is compared with the
    // screen it will really leave; any other step is compared with the screen the step before left.
    const before =
      kind === 'text-filter' || kind === 'facet'
        ? signature(
            await expectOf(oracle, { ...model, index: 0 }, options.visibleRows),
          )
        : previous;
    if (sig === before) continue;
    previous = sig;
    Object.assign(model, trial);
    plan.push({ ...step, expect: adjusted });
  }
  return plan;
}
