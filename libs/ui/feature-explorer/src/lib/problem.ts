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

/**
 * A sentence of help for the failures a first session meets, by the Problem's code: the key of the sentence in the
 * `explorer.hint` group, or `null` when the Problem is shown as sent and nothing more is said. The Problem itself is
 * always shown too; a hint never replaces it.
 */
export function hintKey(code: string | null): string | null {
  switch (code) {
    case 'UNAUTHENTICATED':
      return 'explorer.hint.unauthenticated';
    case 'FORBIDDEN_BROKER':
      return 'explorer.hint.forbiddenBroker';
    case 'BROKER_UNREACHABLE':
      return 'explorer.hint.brokerUnreachable';
    case 'TLS_UNTRUSTED':
      return 'explorer.hint.tlsUntrusted';
    default:
      return null;
  }
}
