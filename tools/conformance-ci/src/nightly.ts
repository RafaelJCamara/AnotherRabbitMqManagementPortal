// The plan and the report of the `conformance-nightly` workflow (M0-42, invariant I-14, amendment
// A-23): every pinned lab broker on the pinned Node and on Node 26.12.0 (blocking), non-release
// builds (alpha; may fail), and the Electron runtime's Node (not built yet). Pure, so the unit
// tests pin it; `nightly-plan-cli.ts` and `report-cli.ts` are the thin CLIs the workflow runs.
//
// The report is honest by construction: a leg that did not run is never shown as a pass, a leg the
// plan expected but nobody reported is shown as "did not run", and nothing here reads or writes the
// registry or `testing/lab-evidence` (the nightly records no evidence; unverified cells stay so).
import { EXACT_VERSION } from './lab-versions.ts';
import type { JobResult } from './verdict.ts';

/** The two Node versions the nightly runs, exact (never a range). The first is `.nvmrc`. */
export const NIGHTLY_NODE_VERSIONS: readonly string[] = ['24.22.0', '26.12.0'];

/** A non-release build: a lab version, or a pre-release such as `4.4.0-alpha.1`. */
const ALPHA_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export type Runtime = 'node-24.22.0' | 'node-26.12.0' | 'electron-node';

export interface NightlyLeg {
  readonly runtime: Runtime;
  readonly channel: 'release' | 'alpha';
  readonly broker: string;
  readonly result: JobResult | 'not-available';
}

export interface NightlyEntry {
  readonly version: string;
  readonly node: string;
}

export interface NightlyPlan {
  /** Every lab version on every nightly Node. */
  readonly release: { readonly include: readonly NightlyEntry[] };
  /** Non-release builds, on the pinned Node; empty until the source is settled (OQ-81). */
  readonly alpha: { readonly include: readonly NightlyEntry[] };
  readonly hasAlpha: boolean;
}

export function planNightly(input: {
  readonly versions: readonly string[];
  readonly alphaVersions: readonly string[];
}): NightlyPlan {
  const { versions, alphaVersions } = input;
  if (versions.length === 0)
    throw new Error('no lab broker version to plan over');
  for (const version of versions) {
    if (!EXACT_VERSION.test(version)) {
      throw new Error(`"${version}" is not an exact broker version`);
    }
  }
  for (const version of alphaVersions) {
    if (!ALPHA_VERSION.test(version)) {
      throw new Error(`"${version}" is not an exact non-release build version`);
    }
  }
  const [pinned] = NIGHTLY_NODE_VERSIONS;
  if (pinned === undefined) throw new Error('no nightly Node version');
  return {
    release: {
      include: versions.flatMap((version) =>
        NIGHTLY_NODE_VERSIONS.map((node) => ({ version, node })),
      ),
    },
    alpha: {
      include: alphaVersions.map((version) => ({ version, node: pinned })),
    },
    hasAlpha: alphaVersions.length > 0,
  };
}

const runtimeOf = (node: string): Runtime => {
  if (node === '24.22.0') return 'node-24.22.0';
  if (node === '26.12.0') return 'node-26.12.0';
  throw new Error(`unexpected nightly Node version ${node}`);
};

export interface LegInputs {
  readonly planResult: JobResult;
  /** The plan's release and alpha matrices; undefined when the plan did not print them. */
  readonly plan: NightlyPlan | undefined;
  readonly releaseResult: JobResult;
  readonly alphaResult: JobResult;
  /** What each leg reported, by `leg-node-<node>-<channel>-<version>`. */
  readonly reported: ReadonlyMap<string, JobResult>;
}

/** The artifact name a leg uploads its result under (the workflow builds the same string). */
export const legName = (
  node: string,
  channel: 'release' | 'alpha',
  version: string,
): string => `leg-node-${node}-${channel}-${version}`;

/**
 * Every leg the nightly was meant to run, with what it reported. A planned leg nobody reported
 * is `skipped` (it did not run to its end). If a job's aggregate result says it failed or was
 * cancelled but no leg of it reported that, an extra row carries the aggregate, so a failure
 * cannot disappear between the job and the report.
 */
export function nightlyLegs(input: LegInputs): NightlyLeg[] {
  const legs: NightlyLeg[] = [];
  if (input.planResult !== 'success' || input.plan === undefined) {
    legs.push({
      runtime: 'node-24.22.0',
      channel: 'release',
      broker: 'plan (no leg was planned)',
      result: input.planResult === 'success' ? 'failure' : input.planResult,
    });
  } else {
    for (const entry of input.plan.release.include) {
      legs.push({
        runtime: runtimeOf(entry.node),
        channel: 'release',
        broker: entry.version,
        result:
          input.reported.get(legName(entry.node, 'release', entry.version)) ??
          'skipped',
      });
    }
    for (const entry of input.plan.alpha.include) {
      legs.push({
        runtime: runtimeOf(entry.node),
        channel: 'alpha',
        broker: entry.version,
        result:
          input.reported.get(legName(entry.node, 'alpha', entry.version)) ??
          'skipped',
      });
    }
    if (!input.plan.hasAlpha) {
      legs.push({
        runtime: 'node-24.22.0',
        channel: 'alpha',
        broker: 'none planned (no alpha source yet)',
        result: 'not-available',
      });
    }
    const aggregate = (
      channel: 'release' | 'alpha',
      result: JobResult,
    ): void => {
      if (result !== 'failure' && result !== 'cancelled') return;
      const mine = legs.filter((leg) => leg.channel === channel);
      if (
        !mine.some(
          (leg) => leg.result === 'failure' || leg.result === 'cancelled',
        )
      ) {
        legs.push({
          runtime: 'node-24.22.0',
          channel,
          broker: `${channel} job (its legs reported no failure)`,
          result,
        });
      }
    };
    aggregate('release', input.releaseResult);
    aggregate('alpha', input.alphaResult);
  }
  legs.push({
    runtime: 'electron-node',
    channel: 'release',
    broker: 'all (no test-fused Electron binary before M2)',
    result: 'not-available',
  });
  return legs;
}

/** A leg blocks the nightly when it is a release leg that is neither a success nor a leg that cannot exist yet. */
const blocks = (leg: NightlyLeg): boolean => {
  if (leg.channel === 'alpha') return false;
  if (leg.result === 'success') return false;
  return !(leg.runtime === 'electron-node' && leg.result === 'not-available');
};

const CELL: Record<NightlyLeg['result'], string> = {
  success: 'pass',
  failure: 'FAIL',
  cancelled: 'cancelled',
  skipped: 'did not run',
  'not-available': 'not available',
};

export function nightlyReport(legs: readonly NightlyLeg[]): {
  readonly markdown: string;
  readonly exitCode: 0 | 1;
} {
  const rank = (leg: NightlyLeg): string =>
    `${leg.channel === 'release' ? '0' : '1'}|${leg.runtime === 'electron-node' ? '2' : '1'}|${leg.runtime}|${leg.broker}`;
  const sorted = [...legs].sort((a, b) => rank(a).localeCompare(rank(b)));
  const failed = sorted.filter(blocks);
  const lines = [
    '## Conformance nightly',
    '',
    '| Runtime | Channel | Broker | Result |',
    '| --- | --- | --- | --- |',
    ...sorted.map(
      (leg) =>
        `| ${leg.runtime} | ${leg.channel}${leg.channel === 'alpha' ? ' (may fail)' : ''} | ${leg.broker} | ${CELL[leg.result]} |`,
    ),
    '',
    failed.length === 0
      ? 'Every blocking leg succeeded.'
      : `${String(failed.length)} blocking leg(s) did not succeed: ${failed.map((leg) => `${leg.runtime} ${leg.broker} (${CELL[leg.result]})`).join('; ')}.`,
    '',
    'A leg that did not run is never a pass. This run records no lab evidence; a cell with no recorded evidence stays unverified (it is shown, never green).',
    '',
  ];
  return { markdown: lines.join('\n'), exitCode: failed.length === 0 ? 0 : 1 };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseEntries(text: string): NightlyEntry[] | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || !Array.isArray(parsed.include)) return undefined;
    const entries: NightlyEntry[] = [];
    for (const item of parsed.include as unknown[]) {
      if (
        !isRecord(item) ||
        typeof item.version !== 'string' ||
        !ALPHA_VERSION.test(item.version) ||
        typeof item.node !== 'string' ||
        !NIGHTLY_NODE_VERSIONS.includes(item.node)
      ) {
        return undefined;
      }
      entries.push({ version: item.version, node: item.node });
    }
    return entries;
  } catch {
    return undefined;
  }
}

/** The plan job's two matrix outputs, or undefined when either cannot be read. */
export function parseNightlyPlan(
  release: string,
  alpha: string,
): NightlyPlan | undefined {
  const releaseEntries = parseEntries(release);
  const alphaEntries = parseEntries(alpha);
  if (releaseEntries === undefined || alphaEntries === undefined)
    return undefined;
  return {
    release: { include: releaseEntries },
    alpha: { include: alphaEntries },
    hasAlpha: alphaEntries.length > 0,
  };
}

/** What a leg's artifact says: its job status word; anything else is not a report. */
export function parseLegResult(text: string): JobResult | undefined {
  const word = text.trim();
  return word === 'success' ||
    word === 'failure' ||
    word === 'cancelled' ||
    word === 'skipped'
    ? word
    : undefined;
}
