// Parsers for what `plan-cli.ts` reads from the environment, git and Nx. Pure, so a hostile or
// broken value is tested here; every one answers "unknown" (null) rather than guessing, and the
// plan then fails closed.
import type { Plan } from './plan.ts';

const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/~-]*$/;
const ALL_ZERO = /^0+$/;

/** A git revision that is safe to pass as an argument, or null (empty, odd characters, the all-zero "no commit"). */
export function parseRevision(value: string | undefined): string | null {
  const text = (value ?? '').trim();
  if (text === '' || ALL_ZERO.test(text) || !REVISION.test(text)) return null;
  return text;
}

/** The number of shards: a whole number from 1 to 16; throws on anything else. */
export function parseShards(value: string | undefined): number {
  const text = (value ?? '').trim();
  if (text === '') return 2;
  const shards = /^[1-9]\d*$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(shards) || shards > 16) {
    throw new Error(
      `SHARDS must be a whole number from 1 to 16, not "${text}"`,
    );
  }
  return shards;
}

/** `nx show projects --affected --json` output: a JSON array of names; null for anything else. */
export function parseProjectList(stdout: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    return Array.isArray(parsed) &&
      parsed.every((name): name is string => typeof name === 'string')
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** `git diff --name-only -z` output. */
export function parseChangedFiles(stdout: string): string[] {
  return stdout.split('\0').filter((file) => file !== '');
}

/** The lines the workflow appends to `$GITHUB_OUTPUT`. */
export function renderOutputs(plan: Plan): string {
  return `affected=${String(plan.affected)}\nmatrix=${JSON.stringify(plan.matrix)}\n`;
}
