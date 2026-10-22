// The judgement of a browser run (AC-27), kept apart from the browser so every way of failing is unit-tested.
// Failures are of two kinds. DETERMINISTIC ones (a CSP or Trusted Types report, a request over a block, a step the
// page never answered) fail the run at once. TIMING ones (the p95, a long task) depend on the machine's load, so a
// run may repeat up to PERF_EXPLORER_UI_BROWSER_ATTEMPTS times and passes when one attempt meets the budgets; every
// attempt is printed, and a regression that is real fails all of them.

/** The budgets of AC-27 (Q-24). */
export const BUDGETS = {
  interactionP95Ms: 300,
  blockLimit: 200,
  longTaskMs: 50,
} as const;

export interface Sample {
  readonly kind: string;
  /** From the input to the end of the frame that holds the new rows. */
  readonly ms: number;
}

export interface RequestRecord {
  readonly offset: number;
  readonly limit: number;
}

export interface LongTask {
  readonly start: number;
  readonly duration: number;
}

export interface AttemptData {
  readonly samples: readonly Sample[];
  readonly requests: readonly RequestRecord[];
  /** Long tasks that began after the warm-up, up to the last interaction. */
  readonly longTasks: readonly LongTask[];
  /** CSP and Trusted Types reports over the whole life of the page, boot included. */
  readonly violations: readonly string[];
  /** Interactions that were planned for the measured part. */
  readonly planned: number;
  /** Interactions whose step expected a request (everything but a scroll within the cached blocks). */
  readonly requestingSteps: number;
}

export const percentile = (sorted: readonly number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;

export function summarise(values: readonly number[]): {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? 0,
  };
}

export interface Verdict {
  readonly deterministic: readonly string[];
  readonly timing: readonly string[];
}

export function judge(data: AttemptData): Verdict {
  const deterministic: string[] = [];
  const timing: string[] = [];
  for (const violation of data.violations) {
    deterministic.push(`CSP / Trusted Types report: ${violation}`);
  }
  const over = data.requests.filter(
    (request) => request.limit > BUDGETS.blockLimit,
  );
  if (over.length > 0) {
    deterministic.push(
      `${String(over.length)} request(s) asked for more than a block of ${String(BUDGETS.blockLimit)} rows (largest ${String(Math.max(...over.map((r) => r.limit)))})`,
    );
  }
  if (data.samples.length !== data.planned) {
    deterministic.push(
      `${String(data.samples.length)} interactions were timed, ${String(data.planned)} were planned`,
    );
  }
  if (data.requests.length < data.requestingSteps) {
    deterministic.push(
      `only ${String(data.requests.length)} requests reached the data port for ${String(data.requestingSteps)} steps that need one: the harness is not in the path`,
    );
  }
  const { p95 } = summarise(data.samples.map((sample) => sample.ms));
  if (data.samples.length > 0 && !(p95 < BUDGETS.interactionP95Ms)) {
    timing.push(
      `p95 ${p95.toFixed(1)} ms is not under ${String(BUDGETS.interactionP95Ms)} ms`,
    );
  }
  const long = data.longTasks.filter(
    (task) => task.duration > BUDGETS.longTaskMs,
  );
  if (long.length > 0) {
    timing.push(
      `${String(long.length)} long task(s) above ${String(BUDGETS.longTaskMs)} ms (longest ${Math.max(...long.map((t) => t.duration)).toFixed(0)} ms)`,
    );
  }
  return { deterministic, timing };
}

export type AttemptOutcome = 'passed' | 'failed' | 'retry';

/** What to do after an attempt: stop green, stop red, or try again (timing failures only). */
export function nextStep(
  verdict: Verdict,
  attempt: number,
  maxAttempts: number,
): AttemptOutcome {
  if (verdict.deterministic.length > 0) return 'failed';
  if (verdict.timing.length === 0) return 'passed';
  return attempt < maxAttempts ? 'retry' : 'failed';
}
