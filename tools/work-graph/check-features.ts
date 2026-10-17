// Checks on docs/product/features.md: the catalogue is internally consistent and its feature
// dependency graph has no dangling ids, no cycles and no dependency on a later milestone.
import { findCycles, milestoneRank } from './graph.ts';
import { isFeatureId } from './parse.ts';
import type { FeatureCatalogue, Violation } from './types.ts';

export const FEATURE_RULES = [
  'features.unparsable-row',
  'features.duplicate-id',
  'features.count-mismatch',
  'features.row-without-detail',
  'features.detail-without-row',
  'features.row-detail-mismatch',
  'features.unknown-milestone',
  'features.missing-depends',
  'features.bad-dependency',
  'features.dangling-dependency',
  'features.self-dependency',
  'features.cycle',
  'features.forward-milestone',
] as const;

function v(rule: string, subject: string, message: string): Violation {
  return { rule, subject, message };
}

/** The earliest milestone a feature starts in (the first one its Milestone cell names). */
function earliest(milestones: readonly string[]): string {
  return (
    [...milestones].sort((a, b) => milestoneRank(a) - milestoneRank(b))[0] ?? ''
  );
}

export function checkFeatures(
  catalogue: FeatureCatalogue,
  milestoneKeys: ReadonlySet<string>,
  detailIdList: readonly string[],
): Violation[] {
  const out: Violation[] = [];
  const byId = new Map(catalogue.features.map((f) => [f.id, f]));

  if (
    catalogue.declaredCount !== null &&
    catalogue.declaredCount !== catalogue.features.length
  ) {
    out.push(
      v(
        'features.count-mismatch',
        'total',
        `The heading says ${String(catalogue.declaredCount)} features but the summary tables list ${String(catalogue.features.length)}.`,
      ),
    );
  }
  for (const area of catalogue.areas) {
    if (area.declared !== area.rows) {
      out.push(
        v(
          'features.count-mismatch',
          area.name,
          `Section "${area.name}" says ${String(area.declared)} features but lists ${String(area.rows)}.`,
        ),
      );
    }
  }
  for (const id of detailIdList) {
    if (!byId.has(id)) {
      out.push(
        v(
          'features.detail-without-row',
          id,
          `${id} has a detail section but no summary row.`,
        ),
      );
    }
  }

  const edges = new Map<string, string[]>();
  for (const feature of catalogue.features) {
    if (feature.detail === null) {
      out.push(
        v(
          'features.row-without-detail',
          feature.id,
          `${feature.id} has a summary row but no detail section.`,
        ),
      );
    } else {
      const d = feature.detail;
      const pairs: [string, string, string][] = [
        ['name', feature.name, d.heading],
        ['milestone', feature.milestoneText, d.milestoneText],
        ['size', feature.size, d.size],
        ['parity', feature.parity, d.parity],
        ['personas', feature.personas, d.personas],
      ];
      for (const [field, row, detail] of pairs) {
        if (row !== detail) {
          out.push(
            v(
              'features.row-detail-mismatch',
              `${feature.id}:${field}`,
              `${feature.id} ${field} is "${row}" in the summary table but "${detail}" in its detail section.`,
            ),
          );
        }
      }
    }
    if (feature.milestones.length === 0) {
      out.push(
        v(
          'features.unknown-milestone',
          feature.id,
          `${feature.id} milestone cell "${feature.milestoneText}" names no milestone.`,
        ),
      );
    }
    for (const m of feature.milestones) {
      if (!milestoneKeys.has(m)) {
        out.push(
          v(
            'features.unknown-milestone',
            feature.id,
            `${feature.id} names milestone ${m}, which is not declared in work-items.json.`,
          ),
        );
      }
    }

    if (feature.depends === null) {
      if (feature.detail !== null) {
        out.push(
          v(
            'features.missing-depends',
            feature.id,
            `${feature.id} has no "Depends on" line.`,
          ),
        );
      }
      edges.set(feature.id, []);
      continue;
    }
    edges.set(feature.id, feature.depends);
    for (const dep of feature.depends) {
      const subject = `${feature.id}->${dep}`;
      if (!isFeatureId(dep)) {
        out.push(
          v(
            'features.bad-dependency',
            subject,
            `${feature.id} lists "${dep}" under Depends on, which is not a feature id.`,
          ),
        );
        continue;
      }
      if (dep === feature.id) {
        out.push(
          v(
            'features.self-dependency',
            subject,
            `${feature.id} depends on itself.`,
          ),
        );
        continue;
      }
      const target = byId.get(dep);
      if (target === undefined) {
        out.push(
          v(
            'features.dangling-dependency',
            subject,
            `${feature.id} depends on ${dep}, which is not in the catalogue.`,
          ),
        );
        continue;
      }
      const mine = earliest(feature.milestones);
      const theirs = earliest(target.milestones);
      if (milestoneRank(theirs) > milestoneRank(mine)) {
        out.push(
          v(
            'features.forward-milestone',
            subject,
            `${feature.id} (${mine}) depends on ${dep}, which starts in the later milestone ${theirs}.`,
          ),
        );
      }
    }
  }
  for (const cycle of findCycles(edges)) {
    out.push(
      v(
        'features.cycle',
        cycle,
        `Feature dependency cycle: ${cycle.split('>').join(' -> ')}.`,
      ),
    );
  }
  return out;
}
