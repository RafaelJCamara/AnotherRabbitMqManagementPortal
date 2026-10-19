// The scenarios `conformance:record` can run, by conformance id. A cell with no scenario here is
// an error, not a skipped cell: a missing recording must not look like a green one.
import type { LabScenario } from '../dsl.ts';
import { cfSmoke01 } from './cf-smoke-01.ts';

export const SCENARIOS: readonly LabScenario[] = [cfSmoke01];

/** The scenarios whose ids match the patterns (`CF-SMOKE-01`, or `CF-SETTLE-*`). Unmatched patterns throw. */
export function selectScenarios(
  patterns: readonly string[],
  scenarios: readonly LabScenario[] = SCENARIOS,
): LabScenario[] {
  if (patterns.length === 0) throw new Error('--cells names no cell');
  const selected = new Set<LabScenario>();
  for (const pattern of patterns) {
    if (!/^CF-[A-Z0-9*-]+$/.test(pattern)) {
      throw new Error(
        `"${pattern}" is not a conformance id or a pattern such as CF-SETTLE-*`,
      );
    }
    const expression = new RegExp(`^${pattern.split('*').join('[A-Z0-9-]*')}$`);
    const matches = scenarios.filter((scenario) =>
      expression.test(scenario.cfId),
    );
    if (matches.length === 0) {
      throw new Error(
        `no scenario matches ${pattern}; known: ${scenarios.map((scenario) => scenario.cfId).join(', ')}`,
      );
    }
    for (const match of matches) selected.add(match);
  }
  return [...selected];
}
