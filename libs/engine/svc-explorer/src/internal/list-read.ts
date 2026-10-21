// One streamed GET of a management list, read incrementally and bounded (M0-48l). The body is never
// held whole: a bare array is read item by item up to a count, a byte total and a size per item; a
// paged envelope is buffered within its own byte limit. Every failure is a fixed-text AppError, and a
// read that fails returns nothing of what it saw (I-6, I-10, I-13).
import { ErrorCodeSchema } from '@app/contracts';
import { AppError, type Timers } from '@app/kernel';
import {
  JsonStreamError,
  openJson,
  type ArrayEnd,
  type JsonStreamReason,
} from '@app/json-stream';
import type { MgmtReadPort, MgmtStreamRequest } from '@app/ports';

export interface ListReadLimits {
  /** Items delivered from a bare array; one more behind them ends the read as `item-limit`. */
  readonly maxItems: number;
  /** Bytes taken from the body of a bare array, whatever they are. */
  readonly maxBytes: number;
  /** Bytes of one item of a bare array. */
  readonly maxItemBytes: number;
  /** Bytes of a paged envelope, which is buffered whole. */
  readonly maxEnvelopeBytes: number;
  /** The read ends, and gives its slot back, after this long. */
  readonly deadlineMs: number;
}

export type ListRead =
  | {
      readonly shape: 'array';
      readonly items: readonly unknown[];
      readonly end: ArrayEnd;
    }
  | { readonly shape: 'envelope'; readonly value: unknown };

/** The only texts a failed read carries: no broker text and no input byte is ever in one (I-10). */
export const LIST_READ_TEXT = {
  incomplete: 'The answer of the broker was not a complete list.',
  tooLarge: 'The answer of the broker was larger than the limit.',
  late: 'The bindings of the vhost could not be read in time.',
  failed: 'The bindings of the vhost could not be read.',
  cancelled: 'The bindings read was cancelled.',
} as const;

function invalid(reason: JsonStreamReason): AppError {
  const tooLarge = reason === 'too-large' || reason === 'too-deep';
  return new AppError('BROKER_ERROR', {
    detail: tooLarge ? LIST_READ_TEXT.tooLarge : LIST_READ_TEXT.incomplete,
  });
}

/** The error of a failed read; what ended it decides, never the text of the cause. */
function listError(
  error: unknown,
  timedOut: boolean,
  cancelled: boolean,
): AppError {
  if (timedOut) {
    return new AppError('BROKER_UNREACHABLE', {
      detail: LIST_READ_TEXT.late,
      retryable: true,
    });
  }
  if (cancelled) {
    return new AppError('ENGINE_SHUTTING_DOWN', {
      detail: LIST_READ_TEXT.cancelled,
    });
  }
  if (error instanceof JsonStreamError) return invalid(error.reason);
  if (error instanceof AppError) {
    return new AppError(error.code, { detail: LIST_READ_TEXT.failed });
  }
  const code = ErrorCodeSchema.safeParse(
    (error as { code?: unknown } | null)?.code,
  );
  return new AppError(code.success ? code.data : 'BROKER_ERROR', {
    detail: LIST_READ_TEXT.failed,
  });
}

/**
 * One streamed GET. Holds one slot of `request.lane` until the body is read, the limit is reached, a
 * failure, the deadline or `signal`. Never returns part of a failed read. The deadline is kept with
 * the injected `Timers` and is shorter than the scheduler's hold time, which frees a slot without
 * stopping the body.
 */
export async function readBoundedList(
  mgmt: MgmtReadPort,
  request: MgmtStreamRequest,
  limits: ListReadLimits,
  signal: AbortSignal,
  timers: Timers,
): Promise<ListRead> {
  const late = new AbortController();
  let timedOut = false;
  const cancelTimer = timers.setTimer(() => {
    timedOut = true;
    late.abort();
  }, limits.deadlineMs);
  const linked = AbortSignal.any([signal, late.signal]);
  try {
    linked.throwIfAborted();
    const body = await mgmt.stream(request, linked);
    const json = await openJson(body, { signal: linked });
    if (json.shape === 'object') {
      return {
        shape: 'envelope',
        value: await json.value(limits.maxEnvelopeBytes),
      };
    }
    if (json.shape !== 'array') {
      await json.close();
      throw new JsonStreamError('not-an-array', 0, 0);
    }
    const items: unknown[] = [];
    const stream = json.array({
      maxItems: limits.maxItems,
      maxBytes: limits.maxBytes,
      maxItemBytes: limits.maxItemBytes,
    });
    for (;;) {
      const step = await stream.next();
      if (step.done === true) return { shape: 'array', items, end: step.value };
      items.push(step.value);
    }
  } catch (error) {
    throw listError(error, timedOut, signal.aborted);
  } finally {
    cancelTimer();
  }
}
