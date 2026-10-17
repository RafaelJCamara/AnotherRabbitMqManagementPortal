// Checks on docs/plan/work-items.json: the dependency graph, waves, and field/label/body
// consistency. Pure functions over the parsed file so the self-test can plant violations.
import { findCycles, isNumericWave, milestoneRank, waveRank } from './graph.ts';
import { KINDS, LANES, SIZES } from './types.ts';
import type { Violation, WorkItem, WorkItemsFile } from './types.ts';

export const ITEM_RULES = [
  'items.duplicate-id',
  'items.title-prefix',
  'items.duplicate-title',
  'items.unknown-milestone',
  'items.unknown-kind',
  'items.unknown-lane',
  'items.unknown-size',
  'items.dangling-dependency',
  'items.self-dependency',
  'items.duplicate-dependency',
  'items.forward-milestone',
  'items.wave-order',
  'items.cycle',
  'items.invalid-parent',
  'items.wave-milestone',
  'items.wave-missing',
  'items.label-mismatch',
  'items.label-undeclared',
  'items.area-missing',
  'items.header-mismatch',
  'items.duplicate-formerly',
  'items.release-checklist',
  'items.dangling-reference',
] as const;

function v(rule: string, subject: string, message: string): Violation {
  return { rule, subject, message };
}

/** The first body line is `**Milestone:** M0 · **Wave:** M0-W1 · ... · **Trust-critical**`. */
function headerFields(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  const first = body.split(/\r?\n/, 1)[0] ?? '';
  for (const part of first.split(' · ')) {
    const pair = /^\*\*(?<key>[^*]+?):\*\* (?<value>.*)$/.exec(part)?.groups;
    if (pair !== undefined) {
      fields.set(pair.key ?? '', (pair.value ?? '').trim());
      continue;
    }
    const flag = /^\*\*(?<key>[^*:]+)\*\*$/.exec(part)?.groups;
    if (flag !== undefined) fields.set(flag.key ?? '', '');
  }
  return fields;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return [...a].sort().join('\n') === [...b].sort().join('\n');
}

function checkIdentity(items: readonly WorkItem[]): Violation[] {
  const out: Violation[] = [];
  const ids = new Set<string>();
  const titles = new Map<string, string>();
  for (const item of items) {
    if (ids.has(item.id)) {
      out.push(
        v(
          'items.duplicate-id',
          item.id,
          `${item.id} is used by more than one work item.`,
        ),
      );
    }
    ids.add(item.id);
    if (!item.title.startsWith(`[${item.id}] `)) {
      out.push(
        v(
          'items.title-prefix',
          item.id,
          `Title must start with "[${item.id}] ": ${item.title}`,
        ),
      );
    }
    const bare = item.title.replace(/^\[[^\]]*\]\s*/, '');
    const other = titles.get(bare);
    if (other !== undefined) {
      out.push(
        v(
          'items.duplicate-title',
          `${other},${item.id}`,
          `${other} and ${item.id} have the same title: "${bare}".`,
        ),
      );
    } else titles.set(bare, item.id);
  }
  return out;
}

function checkEnums(file: WorkItemsFile): Violation[] {
  const out: Violation[] = [];
  const milestones = new Set(file.milestones.map((m) => m.key));
  for (const item of file.items) {
    if (!milestones.has(item.milestone)) {
      out.push(
        v(
          'items.unknown-milestone',
          item.id,
          `${item.id} names milestone "${item.milestone}", which is not declared.`,
        ),
      );
    }
    if (!(KINDS as readonly string[]).includes(item.kind)) {
      out.push(
        v('items.unknown-kind', item.id, `${item.id} has kind "${item.kind}".`),
      );
    }
    if (!(LANES as readonly string[]).includes(item.lane)) {
      out.push(
        v('items.unknown-lane', item.id, `${item.id} has lane "${item.lane}".`),
      );
    }
    if (!(SIZES as readonly string[]).includes(item.size)) {
      out.push(
        v('items.unknown-size', item.id, `${item.id} has size "${item.size}".`),
      );
    }
  }
  return out;
}

function checkDependencies(items: readonly WorkItem[]): Violation[] {
  const out: Violation[] = [];
  const byId = new Map(items.map((i) => [i.id, i]));
  const edges = new Map<string, string[]>();
  for (const item of items) {
    edges.set(item.id, item.depends);
    if (new Set(item.depends).size !== item.depends.length) {
      out.push(
        v(
          'items.duplicate-dependency',
          item.id,
          `${item.id} lists a dependency more than once: ${item.depends.join(', ')}.`,
        ),
      );
    }
    for (const dep of item.depends) {
      const subject = `${item.id}->${dep}`;
      if (dep === item.id) {
        out.push(
          v('items.self-dependency', subject, `${item.id} depends on itself.`),
        );
        continue;
      }
      const target = byId.get(dep);
      if (target === undefined) {
        out.push(
          v(
            'items.dangling-dependency',
            subject,
            `${item.id} depends on ${dep}, which does not exist.`,
          ),
        );
        continue;
      }
      if (milestoneRank(target.milestone) > milestoneRank(item.milestone)) {
        out.push(
          v(
            'items.forward-milestone',
            subject,
            `${item.id} (${item.milestone}) depends on ${dep}, which belongs to the later milestone ${target.milestone}.`,
          ),
        );
      }
      const mine = waveRank(item.wave);
      const theirs = waveRank(target.wave);
      if (
        mine !== null &&
        theirs !== null &&
        (theirs[0] > mine[0] || (theirs[0] === mine[0] && theirs[1] > mine[1]))
      ) {
        out.push(
          v(
            'items.wave-order',
            subject,
            `${item.id} (${item.wave ?? ''}) depends on ${dep}, which is scheduled in the later wave ${target.wave ?? ''}.`,
          ),
        );
      }
    }
  }
  for (const cycle of findCycles(edges)) {
    out.push(
      v(
        'items.cycle',
        cycle,
        `Dependency cycle: ${cycle.split('>').join(' -> ')}.`,
      ),
    );
  }
  return out;
}

function checkParentsAndWaves(file: WorkItemsFile): Violation[] {
  const out: Violation[] = [];
  const byId = new Map(file.items.map((i) => [i.id, i]));
  for (const item of file.items) {
    if (item.parent !== null) {
      const parent = byId.get(item.parent);
      if (parent === undefined) {
        out.push(
          v(
            'items.invalid-parent',
            `${item.id}->${item.parent}`,
            `${item.id} has parent ${item.parent}, which does not exist.`,
          ),
        );
      } else if (parent.kind !== 'epic') {
        out.push(
          v(
            'items.invalid-parent',
            `${item.id}->${item.parent}`,
            `${item.id} has parent ${item.parent}, which is a ${parent.kind}, not an epic.`,
          ),
        );
      }
    }
    if (item.wave !== null) {
      const named =
        item.wave === item.milestone ||
        item.wave.startsWith(`${item.milestone}-`);
      if (!named) {
        out.push(
          v(
            'items.wave-milestone',
            item.id,
            `${item.id} is in milestone ${item.milestone} but wave ${item.wave}.`,
          ),
        );
      }
    } else if (
      item.kind === 'work-package' &&
      (item.milestone === 'M0' || item.milestone === 'M1')
    ) {
      out.push(
        v(
          'items.wave-missing',
          item.id,
          `${item.id} is a ${item.milestone} work package with no wave.`,
        ),
      );
    }
    if (
      item.kind === 'work-package' &&
      (item.milestone === 'M0' || item.milestone === 'M1') &&
      item.wave !== null &&
      !isNumericWave(item.wave)
    ) {
      out.push(
        v(
          'items.wave-missing',
          item.id,
          `${item.id} is a ${item.milestone} work package but its wave "${item.wave}" is not a scheduled wave (Mn-Wk).`,
        ),
      );
    }
  }
  return out;
}

function checkLabels(file: WorkItemsFile): Violation[] {
  const out: Violation[] = [];
  const declared = new Set(file.labels);
  for (const item of file.items) {
    const have = new Set(item.labels);
    const expect = (label: string, present: boolean, why: string): void => {
      if (have.has(label) !== present) {
        out.push(
          v(
            'items.label-mismatch',
            `${item.id}:${label}`,
            `${item.id} ${present ? 'must carry' : 'must not carry'} label "${label}" (${why}).`,
          ),
        );
      }
    };
    expect(`type:${item.kind}`, true, `kind is ${item.kind}`);
    expect(`lane:${item.lane}`, true, `lane is ${item.lane}`);
    expect(`size:${item.size}`, true, `size is ${item.size}`);
    for (const prefix of ['type:', 'lane:', 'size:']) {
      const extra = item.labels.filter((l) => l.startsWith(prefix));
      if (extra.length > 1) {
        out.push(
          v(
            'items.label-mismatch',
            `${item.id}:${prefix}*`,
            `${item.id} carries ${String(extra.length)} ${prefix} labels: ${extra.join(', ')}.`,
          ),
        );
      }
    }
    expect('trust:critical', item.trust, `trust is ${String(item.trust)}`);
    expect('amended', item.amended.length > 0, 'amended list');
    expect(
      'needs-split',
      item.needsSplit,
      `needsSplit is ${String(item.needsSplit)}`,
    );
    const numeric = isNumericWave(item.wave);
    const waveLabels = item.labels.filter((l) => l.startsWith('wave:'));
    if (numeric) expect(`wave:${item.wave ?? ''}`, true, 'scheduled wave');
    if (!numeric && waveLabels.length > 0) {
      out.push(
        v(
          'items.label-mismatch',
          `${item.id}:wave`,
          `${item.id} has wave "${item.wave ?? 'none'}" but carries ${waveLabels.join(', ')}.`,
        ),
      );
    }
    const areaLabels = item.labels
      .filter((l) => l.startsWith('area:'))
      .map((l) => l.slice('area:'.length));
    if (!sameSet(areaLabels, item.areas)) {
      out.push(
        v(
          'items.label-mismatch',
          `${item.id}:area`,
          `${item.id} areas [${item.areas.join(', ')}] differ from its area labels [${areaLabels.join(', ')}].`,
        ),
      );
    }
    if (item.areas.length === 0 && areaLabels.length === 0) {
      out.push(
        v(
          'items.area-missing',
          item.id,
          `${item.id} has no area:* label; the seeding rule requires at least one.`,
        ),
      );
    }
    for (const label of item.labels) {
      if (!declared.has(label)) {
        out.push(
          v(
            'items.label-undeclared',
            `${item.id}:${label}`,
            `${item.id} carries label "${label}", which is not declared in the labels list.`,
          ),
        );
      }
    }
  }
  return out;
}

function checkHeaders(items: readonly WorkItem[]): Violation[] {
  const out: Violation[] = [];
  for (const item of items) {
    const fields = headerFields(item.body);
    const compare = (
      field: string,
      actual: string | undefined,
      want: string | null,
    ): void => {
      if ((actual ?? null) !== want) {
        out.push(
          v(
            'items.header-mismatch',
            `${item.id}:${field}`,
            `${item.id} body header says ${field} "${actual ?? 'none'}" but the field is "${want ?? 'none'}".`,
          ),
        );
      }
    };
    compare('Milestone', fields.get('Milestone'), item.milestone);
    compare('Wave', fields.get('Wave'), item.wave);
    compare('Lane', fields.get('Lane'), item.lane);
    compare('Size', fields.get('Size'), item.size);
    compare('Formerly', fields.get('Formerly'), item.formerly);
    if (fields.has('Trust-critical') !== item.trust) {
      out.push(
        v(
          'items.header-mismatch',
          `${item.id}:Trust-critical`,
          `${item.id} body header ${fields.has('Trust-critical') ? 'marks' : 'does not mark'} it trust-critical but trust is ${String(item.trust)}.`,
        ),
      );
    }
  }
  return out;
}

function checkMisc(file: WorkItemsFile): Violation[] {
  const out: Violation[] = [];
  const formerly = new Map<string, string>();
  for (const item of file.items) {
    if (item.formerly === null) continue;
    const other = formerly.get(item.formerly);
    if (other !== undefined) {
      out.push(
        v(
          'items.duplicate-formerly',
          `${other},${item.id}`,
          `${other} and ${item.id} both claim to be formerly ${item.formerly}.`,
        ),
      );
    } else formerly.set(item.formerly, item.id);
  }
  for (const milestone of file.milestones) {
    const checklists = file.items.filter(
      (i) => i.kind === 'chore' && i.milestone === milestone.key,
    );
    if (
      checklists.length !== 1 ||
      checklists[0]?.id !== `RC-${milestone.key}`
    ) {
      out.push(
        v(
          'items.release-checklist',
          milestone.key,
          `${milestone.key} must have exactly one chore RC-${milestone.key}; found [${checklists.map((c) => c.id).join(', ')}].`,
        ),
      );
    }
  }
  const ids = new Set(file.items.map((i) => i.id));
  for (const item of file.items) {
    if (item.kind !== 'lab-cell') continue;
    const listed = /## Work packages\r?\n\r?\n(?<list>.*)/.exec(item.body)
      ?.groups?.list;
    if (listed === undefined || listed.trim() === '-') continue;
    for (const ref of listed
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')) {
      if (!ids.has(ref)) {
        out.push(
          v(
            'items.dangling-reference',
            `${item.id}->${ref}`,
            `${item.id} lists work package ${ref}, which does not exist.`,
          ),
        );
      }
    }
  }
  return out;
}

export function checkItems(file: WorkItemsFile): Violation[] {
  return [
    ...checkIdentity(file.items),
    ...checkEnums(file),
    ...checkDependencies(file.items),
    ...checkParentsAndWaves(file),
    ...checkLabels(file),
    ...checkHeaders(file.items),
    ...checkMisc(file),
  ];
}
