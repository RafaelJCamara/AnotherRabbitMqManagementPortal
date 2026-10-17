// Known exceptions: findings the validator reports that are judgement calls recorded as open
// questions (docs/open-questions.md) rather than silently rewritten plan decisions.
//
// An exception names a rule, the exact subject the validator prints, and the OQ row that tracks
// it. It is honoured only while the finding exists: when the plan is fixed the exception turns
// stale and the run fails until the entry is removed, so the list can only shrink.
import type { Violation } from './types.ts';

export interface KnownException {
  rule: string;
  subject: string;
  /** The open-question row that tracks the finding, for example `OQ-90`. */
  oq: string;
  reason: string;
}

export interface ExceptionResult {
  /** Violations that fail the run, including problems with the exception list itself. */
  failing: Violation[];
  /** Violations covered by an exception. */
  known: { violation: Violation; exception: KnownException }[];
}

function problem(subject: string, message: string, rule: string): Violation {
  return { rule, subject, message };
}

export function parseExceptions(text: string): {
  exceptions: KnownException[];
  violations: Violation[];
} {
  const violations: Violation[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      exceptions: [],
      violations: [
        problem(
          'known-exceptions.json',
          `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
          'exceptions.invalid',
        ),
      ],
    };
  }
  const list =
    typeof raw === 'object' && raw !== null
      ? (raw as { exceptions?: unknown }).exceptions
      : undefined;
  if (!Array.isArray(list)) {
    return {
      exceptions: [],
      violations: [
        problem(
          'known-exceptions.json',
          'Expected an object with an `exceptions` array.',
          'exceptions.invalid',
        ),
      ],
    };
  }
  const exceptions: KnownException[] = [];
  (list as unknown[]).forEach((entry, i) => {
    const e = entry as Partial<Record<keyof KnownException, unknown>> | null;
    const ok =
      typeof e === 'object' &&
      e !== null &&
      typeof e.rule === 'string' &&
      typeof e.subject === 'string' &&
      typeof e.oq === 'string' &&
      /^OQ-\d+$/.test(e.oq) &&
      typeof e.reason === 'string' &&
      e.reason.trim() !== '';
    if (!ok) {
      violations.push(
        problem(
          `exceptions[${String(i)}]`,
          'Each exception needs string rule, subject, reason and an `OQ-n` oq.',
          'exceptions.invalid',
        ),
      );
      return;
    }
    exceptions.push(e as unknown as KnownException);
  });
  return { exceptions, violations };
}

/**
 * Splits violations into failing and known. `openQuestionIds` is the set of `OQ-n` ids found in
 * docs/open-questions.md; an exception pointing at a missing row fails.
 */
export function applyExceptions(
  violations: readonly Violation[],
  exceptions: readonly KnownException[],
  openQuestionIds: ReadonlySet<string>,
): ExceptionResult {
  const failing: Violation[] = [];
  const known: ExceptionResult['known'] = [];
  const used = new Set<KnownException>();
  const seen = new Set<string>();

  for (const exception of exceptions) {
    const key = `${exception.rule}|${exception.subject}`;
    if (seen.has(key)) {
      failing.push(
        problem(
          `${exception.rule} ${exception.subject}`,
          'Listed more than once in known-exceptions.json.',
          'exceptions.duplicate',
        ),
      );
    }
    seen.add(key);
    if (!openQuestionIds.has(exception.oq)) {
      failing.push(
        problem(
          `${exception.rule} ${exception.subject}`,
          `${exception.oq} is not a row in docs/open-questions.md.`,
          'exceptions.unknown-oq',
        ),
      );
    }
  }

  for (const violation of violations) {
    const match = exceptions.find(
      (e) => e.rule === violation.rule && e.subject === violation.subject,
    );
    if (match === undefined) failing.push(violation);
    else {
      used.add(match);
      known.push({ violation, exception: match });
    }
  }
  for (const exception of exceptions) {
    if (!used.has(exception)) {
      failing.push(
        problem(
          `${exception.rule} ${exception.subject}`,
          `Stale exception (${exception.oq}): the finding no longer occurs. Remove it from known-exceptions.json and close the open question.`,
          'exceptions.stale',
        ),
      );
    }
  }
  return { failing, known };
}
