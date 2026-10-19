// Command line of `record-golden`: which recordings to make, and whether to write or compare.
import type { RecordTarget } from './record.ts';
import type { StatsMode } from './types.ts';

export interface GoldenArgs {
  readonly targets: RecordTarget[];
  /** Restrict to these statistics modes (default: every mode of the target). */
  readonly modes: readonly StatsMode[] | undefined;
  /** Compare with the committed fixtures and exit non-zero on a difference; write nothing. */
  readonly check: boolean;
  /** Fixtures root; default `testing/fixtures`. */
  readonly out: string | undefined;
}

const MODES: readonly StatsMode[] = ['stats-on', 'stats-off', 'default'];

/** `lavinmq` is shorthand for the one pinned LavinMQ target. */
function resolveTarget(
  name: string,
  known: readonly RecordTarget[],
): RecordTarget {
  const match = known.find(
    (target) =>
      target.id === name ||
      (target.product === 'lavinmq' && name === 'lavinmq'),
  );
  if (match === undefined) {
    throw new Error(
      `unknown version "${name}"; known: ${known.map((target) => target.id).join(', ')}`,
    );
  }
  return match;
}

export function parseGoldenArgs(
  argv: readonly string[],
  known: readonly RecordTarget[],
): GoldenArgs {
  let versions: string[] | undefined;
  let modes: StatsMode[] | undefined;
  let check = false;
  let out: string | undefined;
  for (const argument of argv) {
    if (argument === '--check' || argument === '--check=true') {
      check = true;
    } else if (argument === '--check=false') {
      check = false;
    } else if (argument.startsWith('--versions=')) {
      versions = argument
        .slice('--versions='.length)
        .split(',')
        .filter((part) => part !== '');
    } else if (argument.startsWith('--modes=')) {
      modes = argument
        .slice('--modes='.length)
        .split(',')
        .filter((part) => part !== '')
        .map((part) => {
          if (!MODES.includes(part as StatsMode)) {
            throw new Error(`unknown mode "${part}"; use ${MODES.join(', ')}`);
          }
          return part as StatsMode;
        });
    } else if (argument.startsWith('--out=')) {
      out = argument.slice('--out='.length);
    } else {
      throw new Error(
        `unknown argument "${argument}"; options: --versions=a,b --modes=stats-on,stats-off --check --out=dir`,
      );
    }
  }
  const targets =
    versions === undefined
      ? [...known]
      : versions.map((name) => resolveTarget(name, known));
  return { targets, modes, check, out };
}

/** The modes to record for a target: its own, narrowed by `--modes`. */
export function modesFor(
  target: RecordTarget,
  wanted: readonly StatsMode[] | undefined,
): StatsMode[] {
  return target.modes.filter(
    (mode) => wanted === undefined || wanted.includes(mode),
  );
}
