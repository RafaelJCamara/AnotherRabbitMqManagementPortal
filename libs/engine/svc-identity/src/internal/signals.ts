// Waiting on a promise without being held by it: the wait ends when `signal` aborts, with the error
// `reason()` makes, and the promise is left to finish on its own (its late result is dropped).

export function raceSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  reason: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      promise.catch(() => undefined);
      reject(reason());
      return;
    }
    const onAbort = (): void => {
      reject(reason());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('rejected'));
      },
    );
  });
}

/** Why `signal` aborted, as an Error (the manager aborts with an AppError). */
export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted');
}
