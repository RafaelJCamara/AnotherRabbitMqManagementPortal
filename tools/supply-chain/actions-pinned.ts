// GitHub Actions pin gate (M0-05, ADR-026/027, blueprint 7.6): every `uses:` is pinned by a full
// 40-character commit SHA with a trailing version comment, Docker actions by digest, and every
// checkout sets `persist-credentials: false`. Pure functions over file text so the self-test can
// plant violations without touching the real workflows.
import { parse } from 'yaml';
import { asRecord } from './shared.ts';

export const ACTIONS_RULES = [
  'actions.not-sha-pinned',
  'actions.docker-not-digest',
  'actions.missing-version-comment',
  'actions.persist-credentials',
] as const;

export interface ActionsViolation {
  rule: string;
  /** `path:line` of the offending `uses:` line, or the path for step-level rules. */
  subject: string;
  message: string;
}

export interface WorkflowFile {
  /** Repository-relative path, for messages. */
  path: string;
  text: string;
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const DOCKER_DIGEST = /@sha256:[0-9a-f]{64}$/;
const VERSION_COMMENT = /^v?\d+(?:\.\d+)*\S*/;
const USES_LINE =
  /^\s*(?:-\s+)?uses:\s*(?<value>"[^"]*"|'[^']*'|[^\s#]+)\s*(?:#\s*(?<comment>.*?))?\s*$/;

function stripQuotes(value: string): string {
  return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
}

function checkUsesLines(file: WorkflowFile): ActionsViolation[] {
  const out: ActionsViolation[] = [];
  file.text.split(/\r?\n/).forEach((line, index) => {
    const match = USES_LINE.exec(line);
    if (match?.groups === undefined) return;
    const value = stripQuotes(match.groups['value'] ?? '');
    const comment = match.groups['comment'] ?? '';
    const subject = `${file.path}:${index + 1}`;
    // Local composite actions and reusable workflows live in this repository.
    if (value.startsWith('./') || value.startsWith('$/')) return;
    if (value.startsWith('docker://')) {
      if (!DOCKER_DIGEST.test(value)) {
        out.push({
          rule: 'actions.docker-not-digest',
          subject,
          message: `${value} must be pinned by digest (docker://image@sha256:<64 hex>).`,
        });
      }
      return;
    }
    const at = value.lastIndexOf('@');
    const ref = at === -1 ? '' : value.slice(at + 1);
    if (!FULL_SHA.test(ref)) {
      out.push({
        rule: 'actions.not-sha-pinned',
        subject,
        message: `${value} must be pinned by a 40-character commit SHA, not "${ref || 'no ref'}".`,
      });
      return;
    }
    if (!VERSION_COMMENT.test(comment)) {
      out.push({
        rule: 'actions.missing-version-comment',
        subject,
        message: `${value} needs a trailing version comment such as "# v1.2.3".`,
      });
    }
  });
  return out;
}

/** Every step list in a workflow (`jobs.*.steps`) or composite action (`runs.steps`). */
function stepLists(doc: Record<string, unknown>): unknown[][] {
  const lists: unknown[][] = [];
  const steps = asRecord(doc['runs'])['steps'];
  if (Array.isArray(steps)) lists.push(steps);
  for (const job of Object.values(asRecord(doc['jobs']))) {
    const jobSteps = asRecord(job)['steps'];
    if (Array.isArray(jobSteps)) lists.push(jobSteps);
  }
  return lists;
}

function checkCheckoutCredentials(file: WorkflowFile): ActionsViolation[] {
  let doc: Record<string, unknown>;
  try {
    doc = asRecord(parse(file.text));
  } catch (error) {
    return [
      {
        rule: 'actions.persist-credentials',
        subject: file.path,
        message: `YAML does not parse: ${String(error)}`,
      },
    ];
  }
  const out: ActionsViolation[] = [];
  for (const steps of stepLists(doc)) {
    for (const step of steps) {
      const uses = asRecord(step)['uses'];
      if (typeof uses !== 'string' || !uses.startsWith('actions/checkout@'))
        continue;
      const persist = asRecord(asRecord(step)['with'])['persist-credentials'];
      if (persist !== false && persist !== 'false') {
        out.push({
          rule: 'actions.persist-credentials',
          subject: file.path,
          message: `${uses} must set \`persist-credentials: false\`.`,
        });
      }
    }
  }
  return out;
}

export function checkActionsPinned(files: WorkflowFile[]): ActionsViolation[] {
  return files.flatMap((file) => [
    ...checkUsesLines(file),
    ...checkCheckoutCredentials(file),
  ]);
}

export function formatActionsViolations(
  violations: ActionsViolation[],
): string {
  return violations
    .map((v) => `  [${v.rule}] ${v.subject}\n      ${v.message}`)
    .join('\n');
}
