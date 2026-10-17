// Parsers for the three plan documents the graph validator reads:
//   docs/plan/work-items.json  (the manifest)
//   docs/plan/work-items.md    (the issue index with GitHub numbers)
//   docs/product/features.md   (the feature catalogue)
// Each returns what it understood plus violations for what it could not parse, so a malformed
// document is reported rather than crashing the run.
import type {
  Feature,
  FeatureCatalogue,
  FeatureDetail,
  IndexRow,
  Parsed,
  Violation,
  WorkItem,
  WorkItemsFile,
  WorkItemsIndex,
} from './types.ts';

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string') return null;
    out.push(entry);
  }
  return out;
}

function lines(text: string): string[] {
  return text.split(/\r?\n/);
}

// ---------------------------------------------------------------------------------------------
// work-items.json
// ---------------------------------------------------------------------------------------------

function parseItem(raw: unknown, index: number): WorkItem | string {
  if (!isRec(raw)) return `items[${String(index)}] is not an object`;
  const id = raw.id;
  if (typeof id !== 'string' || id === '') {
    return `items[${String(index)}] has no string \`id\``;
  }
  const missing: string[] = [];
  const text = (key: string): string => {
    const value = raw[key];
    if (typeof value === 'string') return value;
    missing.push(key);
    return '';
  };
  const textOrNull = (key: string): string | null => {
    const value = raw[key];
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    missing.push(key);
    return null;
  };
  const list = (key: string): string[] => {
    const value = strings(raw[key]);
    if (value !== null) return value;
    missing.push(key);
    return [];
  };
  const flag = (key: string): boolean => {
    const value = raw[key];
    if (typeof value === 'boolean') return value;
    missing.push(key);
    return false;
  };
  const item: WorkItem = {
    id,
    title: text('title'),
    milestone: text('milestone'),
    kind: text('kind'),
    lane: text('lane'),
    size: text('size'),
    wave: textOrNull('wave'),
    depends: list('depends'),
    parent: textOrNull('parent'),
    formerly: textOrNull('formerly'),
    trust: flag('trust'),
    amended: list('amended'),
    needsSplit: flag('needsSplit'),
    areas: list('areas'),
    labels: list('labels'),
    body: text('body'),
  };
  return missing.length === 0
    ? item
    : `${id}: missing or mistyped field(s) ${missing.join(', ')}`;
}

export function parseWorkItems(jsonText: string): Parsed<WorkItemsFile> {
  const empty: WorkItemsFile = {
    repo: '',
    milestones: [],
    labels: [],
    items: [],
  };
  const violations: Violation[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (error) {
    return {
      value: empty,
      violations: [
        {
          rule: 'items.json-invalid',
          subject: 'docs/plan/work-items.json',
          message: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
  if (!isRec(raw) || !Array.isArray(raw.items)) {
    return {
      value: empty,
      violations: [
        {
          rule: 'items.json-invalid',
          subject: 'docs/plan/work-items.json',
          message: 'Expected an object with an `items` array.',
        },
      ],
    };
  }
  const repo = typeof raw.repo === 'string' ? raw.repo : '';
  const milestones = (Array.isArray(raw.milestones) ? raw.milestones : [])
    .filter(isRec)
    .map((m) => ({
      key: typeof m.key === 'string' ? m.key : '',
      title: typeof m.title === 'string' ? m.title : '',
    }));
  const labels = (Array.isArray(raw.labels) ? raw.labels : [])
    .filter(isRec)
    .map((l) => (typeof l.name === 'string' ? l.name : ''));
  const items: WorkItem[] = [];
  (raw.items as unknown[]).forEach((entry, index) => {
    const parsed = parseItem(entry, index);
    if (typeof parsed === 'string') {
      violations.push({
        rule: 'items.malformed',
        subject:
          isRec(entry) && typeof entry.id === 'string'
            ? entry.id
            : `items[${String(index)}]`,
        message: parsed,
      });
    } else items.push(parsed);
  });
  return { value: { repo, milestones, labels, items }, violations };
}

// ---------------------------------------------------------------------------------------------
// work-items.md
// ---------------------------------------------------------------------------------------------

const INDEX_ROW =
  /^\| (?<milestone>\S+) \| \[#(?<issue>\d+)\]\((?<url>[^)]*)\) \| (?<id>\S+) \| (?<title>.*) \| (?<type>\S+) \| (?<lane>\S+) \|$/;

export function parseWorkItemsIndex(mdText: string): Parsed<WorkItemsIndex> {
  const violations: Violation[] = [];
  const rows: IndexRow[] = [];
  const intro = /\((?<issues>\d+) issues, (?<milestones>\d+) milestones\)/.exec(
    mdText,
  );
  lines(mdText).forEach((text, i) => {
    if (!text.startsWith('|')) return;
    if (text.startsWith('| Milestone |') || /^\|[-| ]+\|$/.test(text)) return;
    const g = INDEX_ROW.exec(text)?.groups;
    if (g === undefined) {
      violations.push({
        rule: 'index.unparsable-row',
        subject: `docs/plan/work-items.md:${String(i + 1)}`,
        message: `Row does not match | Milestone | [#n](url) | ID | Title | Type | Lane |: ${text.slice(0, 80)}`,
      });
      return;
    }
    rows.push({
      line: i + 1,
      milestone: g.milestone ?? '',
      issue: Number(g.issue),
      url: g.url ?? '',
      id: g.id ?? '',
      title: g.title ?? '',
      type: g.type ?? '',
      lane: g.lane ?? '',
    });
  });
  return {
    value: {
      declaredIssues: intro?.groups ? Number(intro.groups.issues) : null,
      declaredMilestones: intro?.groups
        ? Number(intro.groups.milestones)
        : null,
      rows,
    },
    violations,
  };
}

// ---------------------------------------------------------------------------------------------
// features.md
// ---------------------------------------------------------------------------------------------

const FEATURE_ID = /^[A-Z]{2,4}-\d{2}$/;
const SUMMARY_ROW = /^\| ([A-Z]{2,4}-\d{2}) \|/;
const DETAIL_MILESTONE =
  /^- \*\*Milestone:\*\* (?<ms>.*?) \(design-phase tag: M\d\) · \*\*Size:\*\* (?<size>\S+) · \*\*Parity:\*\* (?<parity>\S+) · \*\*Personas:\*\* (?<personas>.*)$/;

export function milestonesIn(text: string): string[] {
  return [...text.matchAll(/\bM(\d)\b/g)].map((m) => `M${m[1] ?? ''}`);
}

export function isFeatureId(value: string): boolean {
  return FEATURE_ID.test(value);
}

export function parseFeatures(mdText: string): Parsed<FeatureCatalogue> {
  const violations: Violation[] = [];
  const features = new Map<string, Feature>();
  const areas: FeatureCatalogue['areas'] = [];
  const declared = /^# Feature catalogue \((\d+) features\)/m.exec(mdText);
  const state: {
    area: FeatureCatalogue['areas'][number] | null;
    current: string | null;
  } = { area: null, current: null };
  const seenDetail = new Set<string>();

  lines(mdText).forEach((text, i) => {
    const where = `docs/product/features.md:${String(i + 1)}`;
    const heading = /^## (?<name>.+) \((?<n>\d+)\)$/.exec(text)?.groups;
    if (heading !== undefined) {
      state.area = {
        name: heading.name ?? '',
        declared: Number(heading.n),
        rows: 0,
      };
      areas.push(state.area);
      state.current = null;
      return;
    }
    const rowId = SUMMARY_ROW.exec(text)?.[1];
    if (rowId !== undefined) {
      const cells = text
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim());
      if (cells.length !== 6) {
        violations.push({
          rule: 'features.unparsable-row',
          subject: rowId,
          message: `${where}: expected 6 cells (ID, Feature, Milestone, Parity, Size, Personas), found ${String(cells.length)}.`,
        });
        return;
      }
      if (features.has(rowId)) {
        violations.push({
          rule: 'features.duplicate-id',
          subject: rowId,
          message: `${where}: ${rowId} appears in more than one summary row.`,
        });
        return;
      }
      const areaState = state.area;
      if (areaState !== null) areaState.rows += 1;
      const milestoneText = cells[2] ?? '';
      features.set(rowId, {
        id: rowId,
        name: cells[1] ?? '',
        area: areaState?.name ?? '',
        milestoneText,
        milestones: milestonesIn(milestoneText),
        parity: cells[3] ?? '',
        size: cells[4] ?? '',
        personas: cells[5] ?? '',
        depends: null,
        detail: null,
      });
      return;
    }
    const detailHead = /^#### (?<id>[A-Z]{2,4}-\d{2}) (?<name>.+)$/.exec(
      text,
    )?.groups;
    if (detailHead !== undefined) {
      const id = detailHead.id ?? '';
      if (seenDetail.has(id)) {
        violations.push({
          rule: 'features.duplicate-id',
          subject: id,
          message: `${where}: ${id} has more than one detail section.`,
        });
      }
      seenDetail.add(id);
      state.current = id;
      const feature = features.get(id);
      if (feature !== undefined) {
        feature.detail = {
          heading: detailHead.name ?? '',
          milestoneText: '',
          size: '',
          parity: '',
          personas: '',
        } satisfies FeatureDetail;
      }
      return;
    }
    if (state.current === null) return;
    const feature = features.get(state.current);
    if (feature?.detail == null) return;
    const ms = DETAIL_MILESTONE.exec(text)?.groups;
    if (ms !== undefined) {
      feature.detail.milestoneText = ms.ms ?? '';
      feature.detail.size = ms.size ?? '';
      feature.detail.parity = ms.parity ?? '';
      feature.detail.personas = ms.personas ?? '';
      return;
    }
    const depends = /^- \*\*Depends on:\*\* (.*)$/.exec(text);
    if (depends !== null) {
      // Some entries carry a parenthetical note, for example `POL-01 (impact preview per A-4)`.
      const value = (depends[1] ?? '').replace(/\([^)]*\)/g, '').trim();
      feature.depends =
        value === '-' || value === ''
          ? []
          : value.split(',').map((d) => d.trim());
    }
  });

  return {
    value: {
      declaredCount: declared ? Number(declared[1]) : null,
      areas,
      features: [...features.values()],
    },
    violations,
  };
}

/** Detail sections whose id has no summary row (the parser attaches details to rows only). */
export function detailIds(mdText: string): string[] {
  return [...mdText.matchAll(/^#### ([A-Z]{2,4}-\d{2}) /gm)].map(
    (m) => m[1] ?? '',
  );
}

// ---------------------------------------------------------------------------------------------
// Feature ids cited in free text
// ---------------------------------------------------------------------------------------------

/**
 * Feature ids cited in a title or body, expanding the shorthands the plan uses:
 * `ADM-04/05/06`, `PUB-03..07`, `STR-04/06, TOP-04`. A bare number after `/` or `..` continues the
 * previous prefix; a list separated by commas must repeat the prefix.
 */
export function citedFeatureIds(text: string): Set<string> {
  const out = new Set<string>();
  const add = (prefix: string, n: number): void => {
    out.add(`${prefix}-${String(n).padStart(2, '0')}`);
  };
  const id = /\b([A-Z]{2,4})-(\d{2})(?!\d)/g;
  const continuation = /\s*(\/|\.\.)\s*(\d{2})(?![\d-])/y;
  let match: RegExpExecArray | null;
  while ((match = id.exec(text)) !== null) {
    const prefix = match[1] ?? '';
    let last = Number(match[2]);
    add(prefix, last);
    let position = id.lastIndex;
    for (;;) {
      continuation.lastIndex = position;
      const next = continuation.exec(text);
      if (next === null) break;
      const n = Number(next[2]);
      if (next[1] === '..')
        for (let k = last + 1; k < n; k += 1) add(prefix, k);
      add(prefix, n);
      last = n;
      position = continuation.lastIndex;
    }
    id.lastIndex = position;
  }
  return out;
}
