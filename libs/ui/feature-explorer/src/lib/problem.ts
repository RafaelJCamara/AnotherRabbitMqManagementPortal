import { isEngineProblem } from '@app/ui-data';

/** What the page shows of a failure: the engine's Problem as sent, or the message of anything else. */
export interface ProblemView {
  readonly title: string;
  readonly detail: string | null;
  /** The Problem's code, for an engine failure. */
  readonly code: string | null;
}

export function problemView(error: unknown): ProblemView {
  if (isEngineProblem(error)) {
    return {
      title: error.problem.title,
      detail: error.problem.detail ?? null,
      code: error.problem.code,
    };
  }
  if (error instanceof Error) {
    return { title: error.message, detail: null, code: null };
  }
  return { title: '', detail: null, code: null };
}
