// Feature and work-item graph validator (M0-77, amendment "Add a CI graph validator").
// Pure functions: documents in, violations out. `run-validate.ts` reads the files.
import { checkCoverage } from './check-coverage.ts';
import { checkFeatures } from './check-features.ts';
import { checkIndex } from './check-index.ts';
import { checkItems } from './check-items.ts';
import {
  detailIds,
  parseFeatures,
  parseWorkItems,
  parseWorkItemsIndex,
} from './parse.ts';
import type { GraphInputs, Violation } from './types.ts';

export { COVERAGE_RULES } from './check-coverage.ts';
export { FEATURE_RULES } from './check-features.ts';
export { INDEX_RULES } from './check-index.ts';
export { ITEM_RULES } from './check-items.ts';

export interface GraphSummary {
  items: number;
  dependencies: number;
  features: number;
  featureDependencies: number;
}

export interface GraphResult {
  violations: Violation[];
  summary: GraphSummary;
}

function byRuleThenSubject(a: Violation, b: Violation): number {
  return (
    a.rule.localeCompare(b.rule) ||
    a.subject.localeCompare(b.subject) ||
    a.message.localeCompare(b.message)
  );
}

export function validateGraph(inputs: GraphInputs): GraphResult {
  const items = parseWorkItems(inputs.workItemsJson);
  const index = parseWorkItemsIndex(inputs.workItemsMd);
  const features = parseFeatures(inputs.featuresMd);
  const milestoneKeys = new Set(items.value.milestones.map((m) => m.key));

  const violations = [
    ...items.violations,
    ...index.violations,
    ...features.violations,
    ...checkItems(items.value),
    ...checkIndex(items.value, index.value),
    ...checkFeatures(
      features.value,
      milestoneKeys,
      detailIds(inputs.featuresMd),
    ),
    ...checkCoverage(items.value, features.value),
  ].sort(byRuleThenSubject);

  return {
    violations,
    summary: {
      items: items.value.items.length,
      dependencies: items.value.items.reduce((n, i) => n + i.depends.length, 0),
      features: features.value.features.length,
      featureDependencies: features.value.features.reduce(
        (n, f) => n + (f.depends?.length ?? 0),
        0,
      ),
    },
  };
}

export function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map((x) => `  [${x.rule}] ${x.subject}: ${x.message}`)
    .join('\n');
}
