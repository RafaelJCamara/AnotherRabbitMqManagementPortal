// Checks that docs/plan/work-items.md (the issue index with GitHub numbers) and
// docs/plan/work-items.json describe the same work items.
import type { Violation, WorkItemsFile, WorkItemsIndex } from './types.ts';

export const INDEX_RULES = [
  'index.unparsable-row',
  'index.unknown-item',
  'index.missing-item',
  'index.duplicate-item',
  'index.duplicate-issue',
  'index.mismatch',
  'index.count-mismatch',
] as const;

function v(rule: string, subject: string, message: string): Violation {
  return { rule, subject, message };
}

export function checkIndex(
  file: WorkItemsFile,
  index: WorkItemsIndex,
): Violation[] {
  const out: Violation[] = [];
  const byId = new Map(file.items.map((i) => [i.id, i]));
  const rowIds = new Set<string>();
  const issues = new Map<number, string>();

  for (const row of index.rows) {
    const where = `docs/plan/work-items.md:${String(row.line)}`;
    if (rowIds.has(row.id)) {
      out.push(
        v(
          'index.duplicate-item',
          row.id,
          `${where}: ${row.id} is listed more than once.`,
        ),
      );
    }
    rowIds.add(row.id);
    const owner = issues.get(row.issue);
    if (owner !== undefined) {
      out.push(
        v(
          'index.duplicate-issue',
          `#${String(row.issue)}`,
          `${where}: issue #${String(row.issue)} is used by ${owner} and ${row.id}.`,
        ),
      );
    } else issues.set(row.issue, row.id);

    const item = byId.get(row.id);
    if (item === undefined) {
      out.push(
        v(
          'index.unknown-item',
          row.id,
          `${where}: ${row.id} is not in work-items.json.`,
        ),
      );
      continue;
    }
    const mismatch = (field: string, index_: string, json: string): void => {
      out.push(
        v(
          'index.mismatch',
          `${row.id}:${field}`,
          `${where}: ${row.id} ${field} is "${index_}" in work-items.md but "${json}" in work-items.json.`,
        ),
      );
    };
    if (row.milestone !== item.milestone)
      mismatch('milestone', row.milestone, item.milestone);
    if (`[${row.id}] ${row.title}` !== item.title)
      mismatch('title', row.title, item.title.replace(/^\[[^\]]*\]\s*/, ''));
    if (row.type !== item.kind) mismatch('type', row.type, item.kind);
    if (row.lane !== item.lane) mismatch('lane', row.lane, item.lane);
    const url = `https://github.com/${file.repo}/issues/${String(row.issue)}`;
    if (row.url !== url) mismatch('url', row.url, url);
  }

  for (const item of file.items) {
    if (!rowIds.has(item.id)) {
      out.push(
        v(
          'index.missing-item',
          item.id,
          `${item.id} has no row (and so no issue number) in work-items.md.`,
        ),
      );
    }
  }
  if (
    index.declaredIssues !== null &&
    index.declaredIssues !== file.items.length
  ) {
    out.push(
      v(
        'index.count-mismatch',
        'issues',
        `work-items.md says ${String(index.declaredIssues)} issues but work-items.json has ${String(file.items.length)}.`,
      ),
    );
  }
  if (
    index.declaredIssues !== null &&
    index.declaredIssues !== index.rows.length
  ) {
    out.push(
      v(
        'index.count-mismatch',
        'rows',
        `work-items.md says ${String(index.declaredIssues)} issues but lists ${String(index.rows.length)} rows.`,
      ),
    );
  }
  if (
    index.declaredMilestones !== null &&
    index.declaredMilestones !== file.milestones.length
  ) {
    out.push(
      v(
        'index.count-mismatch',
        'milestones',
        `work-items.md says ${String(index.declaredMilestones)} milestones but work-items.json declares ${String(file.milestones.length)}.`,
      ),
    );
  }
  return out;
}
