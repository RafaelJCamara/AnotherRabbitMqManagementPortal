// Shared types for the feature and work-item graph validator (M0-77).
// Pure TypeScript with erasable syntax only, so Node 24 runs it directly (type stripping).

export interface Violation {
  /** Stable rule id, for example `items.dangling-dependency`. The self-test asserts on these. */
  rule: string;
  /** The offending ids, for example `M0-12->M0-99`. Known exceptions match on rule and subject. */
  subject: string;
  message: string;
}

/** `kind` values of docs/plan/work-items.json, which map to the `type:*` labels. */
export const KINDS = [
  'work-package',
  'epic',
  'human',
  'adr',
  'lab-cell',
  'chore',
] as const;
export const LANES = ['platform', 'feature', 'evidence'] as const;
export const SIZES = ['S', 'M', 'L'] as const;

export interface WorkItem {
  id: string;
  title: string;
  milestone: string;
  kind: string;
  lane: string;
  size: string;
  /** `M0-W1` style for scheduled waves, `M2` or `M2-platform` for later milestones, or null. */
  wave: string | null;
  depends: string[];
  parent: string | null;
  formerly: string | null;
  trust: boolean;
  amended: string[];
  needsSplit: boolean;
  areas: string[];
  labels: string[];
  body: string;
}

export interface MilestoneEntry {
  key: string;
  title: string;
}

export interface WorkItemsFile {
  repo: string;
  milestones: MilestoneEntry[];
  /** Declared label names. */
  labels: string[];
  items: WorkItem[];
}

/** One row of the table in docs/plan/work-items.md. */
export interface IndexRow {
  line: number;
  milestone: string;
  issue: number;
  url: string;
  id: string;
  title: string;
  type: string;
  lane: string;
}

export interface WorkItemsIndex {
  declaredIssues: number | null;
  declaredMilestones: number | null;
  rows: IndexRow[];
}

export interface Feature {
  id: string;
  name: string;
  area: string;
  /** Raw milestone cell of the summary table, for example `M2 (Windows), M3 (Linux)`. */
  milestoneText: string;
  /** Every milestone key named in the cell, in order. The first is the earliest start. */
  milestones: string[];
  parity: string;
  size: string;
  personas: string;
  /** Null when the detail section is missing its `Depends on` line. */
  depends: string[] | null;
  detail: FeatureDetail | null;
}

export interface FeatureDetail {
  heading: string;
  milestoneText: string;
  size: string;
  parity: string;
  personas: string;
}

export interface FeatureCatalogue {
  declaredCount: number | null;
  areas: { name: string; declared: number; rows: number }[];
  features: Feature[];
}

export interface GraphInputs {
  featuresMd: string;
  workItemsJson: string;
  workItemsMd: string;
}

export interface Parsed<T> {
  value: T;
  violations: Violation[];
}
