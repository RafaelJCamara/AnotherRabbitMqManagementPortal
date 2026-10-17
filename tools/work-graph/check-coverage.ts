// Cross-document checks: every feature in docs/product/features.md maps to at least one work
// item in docs/plan/work-items.json, and no work item cites a feature that does not exist.
//
// A work item "cites" a feature when the feature id appears in its title or body, including the
// shorthands the plan uses (`ADM-04/05/06`, `PUB-03..07`). See citedFeatureIds.
import { milestoneRank } from './graph.ts';
import { citedFeatureIds } from './parse.ts';
import type { FeatureCatalogue, Violation, WorkItemsFile } from './types.ts';

export const COVERAGE_RULES = [
  'coverage.unmapped-feature',
  'coverage.late-feature',
  'coverage.unknown-feature',
] as const;

function v(rule: string, subject: string, message: string): Violation {
  return { rule, subject, message };
}

export function checkCoverage(
  file: WorkItemsFile,
  catalogue: FeatureCatalogue,
): Violation[] {
  const out: Violation[] = [];
  const known = new Set(catalogue.features.map((f) => f.id));
  const prefixes = new Set(
    [...known].map((id) => id.slice(0, id.indexOf('-'))),
  );
  const citedBy = new Map<string, string[]>();

  for (const item of file.items) {
    const cited = citedFeatureIds(`${item.title}\n${item.body}`);
    for (const id of cited) {
      if (known.has(id)) {
        const list = citedBy.get(id) ?? [];
        list.push(item.id);
        citedBy.set(id, list);
      } else if (prefixes.has(id.slice(0, id.indexOf('-')))) {
        out.push(
          v(
            'coverage.unknown-feature',
            `${item.id}->${id}`,
            `${item.id} cites ${id}, which is not in the feature catalogue.`,
          ),
        );
      }
    }
  }

  const byId = new Map(file.items.map((i) => [i.id, i]));
  for (const feature of catalogue.features) {
    const items = citedBy.get(feature.id) ?? [];
    if (items.length === 0) {
      out.push(
        v(
          'coverage.unmapped-feature',
          feature.id,
          `${feature.id} (${feature.name}) is cited by no work item.`,
        ),
      );
      continue;
    }
    const start = Math.min(...feature.milestones.map(milestoneRank));
    const first = Math.min(
      ...items.map((id) => milestoneRank(byId.get(id)?.milestone ?? '')),
    );
    if (Number.isFinite(start) && Number.isFinite(first) && first > start) {
      out.push(
        v(
          'coverage.late-feature',
          feature.id,
          `${feature.id} starts in M${String(start)} but the earliest work item citing it (${items.join(', ')}) is in M${String(first)}.`,
        ),
      );
    }
  }
  return out;
}
