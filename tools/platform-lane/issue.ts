// Issue rendering, plan validation and de-duplication for the platform upgrade lane (A-25).
// The plan crosses a job boundary as a workflow output, so `parsePlan` validates every field
// before anything is rendered into an issue.
import type { Candidate, CheckResult, Plan, PlatformReport } from './detect.ts';

/**
 * The runbook steps that follow the issue (docs/runbooks/platform-upgrade-lane.md, steps 2-4,
 * with step 2 split in two). `.github/ISSUE_TEMPLATE/platform_upgrade.yml` carries the same text;
 * the self-test fails when they drift.
 */
export const CHECKLIST = [
  'Conformance suite passes on the new version.',
  'Deny-all egress E2E passes on the new version (I-12).',
  'Bundle budgets are respected.',
  'Pins and docs are updated (catalog, .nvmrc or packageManager, and the toolchain pins in AGENTS.md).',
] as const;

export const ADR_ITEM =
  'ADR accepted before the bump (open an ADR proposal issue; required for Nx and fastify).';

export const LABELS = ['lane:platform', 'type:chore'] as const;

export function marker(platform: string, major: number): string {
  return `<!-- platform-lane:${platform}:${String(major)} -->`;
}

export function title(c: Candidate): string {
  return `[Platform] ${c.name} ${String(c.major)}: upgrade from ${c.pinned}`;
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

function cell(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const RESULT_WORD: Record<CheckResult['status'], string> = {
  ok: 'compatible',
  incompatible: 'incompatible',
  unknown: 'unknown',
};

export function renderBody(c: Candidate, ageGateMinutes: number): string {
  const days = Math.round(ageGateMinutes / 1440);
  const lines: string[] = [
    marker(c.platform, c.major),
    '',
    `**Lane:** platform · **Opened by:** the platform upgrade lane workflow (amendment A-25)`,
    '',
    '## Why',
    '',
    `${c.name} ${String(c.major)} is out: ${c.version} was published on ${day(c.published)} (the first ${String(c.major)}.x release on ${day(c.ga)}). This repository pins ${c.name} ${c.pinned}.`,
    '',
    `- **Target:** ${c.cadence}`,
  ];
  if (c.due !== null) lines.push(`- **Due:** ${day(c.due)}`);
  if (c.lts !== null) lines.push(`- **LTS:** ${c.lts}`);
  else if (c.platform === 'node')
    lines.push('- **LTS:** not yet promoted; the images move to an LTS line.');
  lines.push(
    `- **Release age:** the lane only proposes versions at least ${String(days)} days old (the pnpm \`minimumReleaseAge\` gate). Never weaken it for this bump; an exact exclusion needs maintainer sign-off and an ADR-027 log line.`,
    '',
  );
  if (c.checks.length > 0) {
    lines.push(
      '## Compatibility checks',
      '',
      'Read from published npm metadata (`engines`, `peerDependencies`). They are a first filter, not a substitute for the checklist below.',
      '',
      '| Check | Result | Detail |',
      '| --- | --- | --- |',
      ...c.checks.map(
        (k) =>
          `| ${cell(k.label)} | ${RESULT_WORD[k.status]} | ${cell(k.detail)} |`,
      ),
      '',
    );
  }
  lines.push(
    '## Checklist',
    '',
    'From `docs/runbooks/platform-upgrade-lane.md`. The conformance suite and the egress E2E are planned work packages; until they exist, record which check you ran by hand.',
    '',
  );
  if (c.adrGated) lines.push(`- [ ] ${ADR_ITEM}`);
  for (const item of CHECKLIST) lines.push(`- [ ] ${item}`);
  lines.push('');
  return lines.join('\n');
}

// ---- plan validation ------------------------------------------------------------------------

const SLUG = /^[a-z][a-z0-9-]*$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STATUSES = new Set(['ok', 'incompatible', 'unknown']);

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown, max: number): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !/[\u0000-\u0008\u000b-\u001f]/.test(value)
    ? value
    : null;
}

/** Parses the JSON plan that `detect` wrote. Throws an Error naming the first invalid field. */
export function parsePlan(text: string): Plan {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`The plan is not JSON: ${String(error)}`);
  }
  const root = record(raw);
  const generatedAt = root.generatedAt;
  const ageGate = root.ageGateMinutes;
  if (typeof generatedAt !== 'string' || !ISO.test(generatedAt))
    throw new Error('plan.generatedAt must be an ISO timestamp.');
  if (typeof ageGate !== 'number' || !Number.isInteger(ageGate) || ageGate < 1)
    throw new Error('plan.ageGateMinutes must be a positive integer.');
  if (!Array.isArray(root.candidates))
    throw new Error('plan.candidates must be an array.');
  const candidates = (root.candidates as unknown[]).map((entry, i) => {
    const c = record(entry);
    const where = `plan.candidates[${String(i)}]`;
    const platform = c.platform;
    if (typeof platform !== 'string' || !SLUG.test(platform))
      throw new Error(`${where}.platform must be a slug.`);
    const name = str(c.name, 40);
    const cadence = str(c.cadence, 400);
    if (name === null) throw new Error(`${where}.name is invalid.`);
    if (cadence === null) throw new Error(`${where}.cadence is invalid.`);
    for (const key of ['pinned', 'version'] as const) {
      const value = c[key];
      if (typeof value !== 'string' || !VERSION.test(value))
        throw new Error(`${where}.${key} must be x.y.z.`);
    }
    const majorValue = c.major;
    if (
      typeof majorValue !== 'number' ||
      !Number.isInteger(majorValue) ||
      majorValue < 0
    )
      throw new Error(`${where}.major must be a non-negative integer.`);
    for (const key of ['published', 'ga'] as const) {
      const value = c[key];
      if (typeof value !== 'string' || !ISO.test(value))
        throw new Error(`${where}.${key} must be an ISO timestamp.`);
    }
    const due = c.due;
    if (due !== null && (typeof due !== 'string' || !ISO.test(due)))
      throw new Error(`${where}.due must be an ISO timestamp or null.`);
    if (typeof c.adrGated !== 'boolean')
      throw new Error(`${where}.adrGated must be a boolean.`);
    const lts = c.lts;
    if (
      lts !== null &&
      (typeof lts !== 'string' || !/^[A-Za-z]{1,30}$/.test(lts))
    )
      throw new Error(`${where}.lts must be a codename or null.`);
    if (!Array.isArray(c.checks))
      throw new Error(`${where}.checks must be an array.`);
    const checks = (c.checks as unknown[]).map((entry2, j) => {
      const k = record(entry2);
      const at = `${where}.checks[${String(j)}]`;
      const id = k.id;
      const label = str(k.label, 200);
      const detail = str(k.detail, 600);
      if (typeof id !== 'string' || !SLUG.test(id))
        throw new Error(`${at}.id must be a slug.`);
      if (label === null || detail === null)
        throw new Error(`${at} needs a label and a detail.`);
      if (typeof k.status !== 'string' || !STATUSES.has(k.status))
        throw new Error(`${at}.status is invalid.`);
      if (typeof k.blocking !== 'boolean')
        throw new Error(`${at}.blocking must be a boolean.`);
      return {
        id,
        label,
        detail,
        status: k.status as CheckResult['status'],
        blocking: k.blocking,
      };
    });
    return {
      platform,
      name,
      cadence,
      pinned: c.pinned as string,
      version: c.version as string,
      major: majorValue,
      published: c.published as string,
      ga: c.ga as string,
      due: due,
      adrGated: c.adrGated,
      lts: lts,
      checks,
    };
  });
  return { generatedAt, ageGateMinutes: ageGate, candidates };
}

// ---- de-duplication -------------------------------------------------------------------------

export interface ExistingIssue {
  number: number;
  state: string;
  title: string;
  body: string;
}

export interface Tracked {
  candidate: Candidate;
  issue: ExistingIssue;
}

/**
 * Splits the candidates into those that need a new issue and those already tracked. An issue
 * counts whether it is open or closed: closing it is a decision (adopted, or deferred on
 * purpose), and the lane does not reopen that question.
 */
export function splitTracked(
  candidates: readonly Candidate[],
  existing: readonly ExistingIssue[],
): { toOpen: Candidate[]; tracked: Tracked[] } {
  const toOpen: Candidate[] = [];
  const tracked: Tracked[] = [];
  for (const candidate of candidates) {
    const tag = marker(candidate.platform, candidate.major);
    const issue = existing.find((e) => e.body.includes(tag));
    if (issue === undefined) toOpen.push(candidate);
    else tracked.push({ candidate, issue });
  }
  return { toOpen, tracked };
}

// ---- report ---------------------------------------------------------------------------------

const STATUS_TEXT: Record<PlatformReport['status'], string> = {
  current: 'current',
  aging: 'waiting for release age',
  deferred: 'deferred (blocking check)',
  candidate: 'upgrade candidate',
  error: 'error',
};

/** A Markdown table of every platform, for the job summary. */
export function renderReport(
  reports: readonly PlatformReport[],
  plan: Plan,
  tracked: readonly Tracked[] = [],
): string {
  const days = Math.round(plan.ageGateMinutes / 1440);
  const lines = [
    '## Platform upgrade lane',
    '',
    `Generated ${plan.generatedAt}. Versions younger than ${String(days)} days are not proposed (pnpm \`minimumReleaseAge\`).`,
    '',
    '| Platform | Pinned | Newer major | Status | Note |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const r of reports) {
    const known = tracked.find((t) => t.candidate.platform === r.id);
    const notes: string[] = [];
    if (r.pinSource === 'fallback')
      notes.push('planned pin, not installed yet');
    if (r.status === 'aging' && r.eligibleAt !== null)
      notes.push(`eligible from ${day(r.eligibleAt)}`);
    if (r.status === 'deferred' && r.candidate !== null) {
      for (const k of r.candidate.checks) {
        if (k.blocking && k.status !== 'ok') notes.push(k.detail);
      }
    }
    if (known !== undefined)
      notes.push(
        `already tracked in #${String(known.issue.number)} (${known.issue.state.toLowerCase()})`,
      );
    if (r.error !== null) notes.push(r.error);
    lines.push(
      `| ${cell(r.name)} | ${r.pinned} | ${r.newest === null ? 'none' : cell(r.newest.version)} | ${STATUS_TEXT[r.status]} | ${cell(notes.join('; '))} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
