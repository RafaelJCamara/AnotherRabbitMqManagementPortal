// Small helpers for AbortSignal, whose `reason` is typed `any`.

/** The Error a signal was aborted with, or a plain `AbortError` when it carries something else. */
export function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException('The operation was aborted.', 'AbortError');
}
