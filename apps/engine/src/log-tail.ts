// The newest log lines, kept in memory for the diagnostics bundle (blueprint 13). The logger redacts
// a line before it reaches its sink and its `onLine` hook (I-10), so what is held here is already
// redacted; the bundle scrubs it again anyway. The ring is bounded by lines and by bytes, and what
// it evicts is counted (I-6, I-13): the bundle reports `dropped`.
import { BoundedRing } from '@app/kernel';
import type { LogTail } from '@app/svc-ops';

export const LOG_TAIL_MAX_LINES = 2000;
export const LOG_TAIL_MAX_BYTES = 2 * 1024 * 1024;

export interface HeldLogTail extends LogTail {
  /** Keeps one finished line (the logger's `onLine`). */
  add(line: string): void;
}

export function createLogTail(
  limits: { maxItems?: number; maxBytes?: number } = {},
): HeldLogTail {
  const ring = new BoundedRing<string>({
    maxItems: limits.maxItems ?? LOG_TAIL_MAX_LINES,
    maxBytes: limits.maxBytes ?? LOG_TAIL_MAX_BYTES,
  });
  return {
    add: (line) => {
      ring.add(line.endsWith('\n') ? line.slice(0, -1) : line);
    },
    tail: (maxLines) => ({
      lines: maxLines <= 0 ? [] : ring.toArray().slice(-maxLines),
      held: ring.size,
      dropped: ring.dropped,
    }),
  };
}
