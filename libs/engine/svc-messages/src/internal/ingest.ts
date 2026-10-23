// The ingest queue of the capture store (M1-09, blueprint 1.4, I-5, I-6, I-13). Sealed messages are
// offered to a queue bounded by items and bytes; a single loop takes them off in batches, one
// transaction each, and gives the event loop a turn between batches. A batch is as large as the last
// transactions allowed: when one takes longer than the budget (5 ms) the next is half the size, and
// when they are comfortably fast it grows again, so the writer's hold on its connection stays short
// whatever the rows look like.
//
// Nothing is lost silently. An offer the queue refuses is returned to the caller and counted on its
// capture (`noteLoss`); a batch whose write fails is counted as lost to error; rows the repository
// refuses (quota, message limit, duplicate) are counted from its answer.
import { BoundedQueue } from '@app/kernel';
import type {
  AppendLimits,
  AppendResult,
  CaptureRepository,
  NewMessage,
} from '@app/ports';

import { yieldToLoop } from './seal';

export interface IngestItem {
  readonly captureId: string;
  readonly ownerId: string;
  readonly message: NewMessage;
  /** The bytes this item holds in the queue. */
  readonly bytes: number;
}

export interface IngestOptions {
  readonly repo: CaptureRepository;
  readonly limits: () => AppendLimits;
  readonly maxItems: number;
  readonly maxBytes: number;
  /** The transaction time a batch should stay within. */
  readonly budgetMs: number;
  readonly maxBatch: number;
  /** Called with the code of an error, never its text, when a batch could not be written. */
  readonly onError?: (code: string) => void;
}

export interface IngestStats {
  readonly items: number;
  readonly bytes: number;
  readonly maxItems: number;
  readonly maxBytes: number;
  readonly stored: number;
  readonly rejected: {
    readonly quota: number;
    readonly captureLimit: number;
    readonly duplicate: number;
    readonly captureMissing: number;
  };
  readonly lostToError: number;
  readonly batches: number;
  readonly lastTxnMs: number;
  readonly maxTxnMs: number;
  readonly batchSize: number;
}

export interface Ingest {
  /** False, with nothing stored, when the queue is full (items or bytes). */
  offer(item: IngestItem): boolean;
  /** True when an item of `bytes` would fit now (a hint: it can change before the offer). */
  hasRoom(bytes: number): boolean;
  /**
   * Counts messages that were refused on their capture: by a full queue (`queue`) or because one is
   * larger than the store takes (`limit`). Written with the next batch.
   */
  refused(captureId: string, count: number, kind: 'queue' | 'limit'): void;
  /** Resolves when everything offered so far has been written or counted as lost. */
  flush(): Promise<void>;
  stats(): IngestStats;
}

/** The most bytes of messages one transaction carries, whatever the batch size. */
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const MAX_FLUSH_ROUNDS = 8;
const INITIAL_BATCH = 16;
const GROW_STEP = 4;
/**
 * The batch halves when a transaction takes more than this share of the budget, and grows when it
 * takes less than the other. Halving at 50 % rather than at 100 % keeps the spread of times around
 * the budget under it, not on it (the time of a transaction varies by a factor of three or more with
 * the disk and the machine's load), so the 95th percentile stays within.
 */
const SHRINK_ABOVE = 0.5;
const GROW_BELOW = 0.25;

function countCode(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : 'ERROR';
}

export function createIngest(options: IngestOptions): Ingest {
  const queue = new BoundedQueue<IngestItem>({
    maxItems: options.maxItems,
    maxBytes: options.maxBytes,
    sizeOf: (item) => item.bytes,
  });
  const pendingLoss = new Map<string, { queue: number; limit: number }>();
  let running: Promise<void> | undefined;
  let scheduled = false;
  let batchSize = Math.min(INITIAL_BATCH, options.maxBatch);
  const totals = {
    stored: 0,
    quota: 0,
    captureLimit: 0,
    duplicate: 0,
    captureMissing: 0,
    lostToError: 0,
    batches: 0,
    lastTxnMs: 0,
    maxTxnMs: 0,
  };

  function take(): IngestItem[] {
    const first = queue.peek();
    if (first === undefined) return [];
    const batch: IngestItem[] = [];
    let bytes = 0;
    for (;;) {
      const next = queue.peek();
      if (next === undefined) return batch;
      const sameCapture =
        next.captureId === first.captureId && next.ownerId === first.ownerId;
      const roomLeft =
        batch.length < batchSize &&
        (batch.length === 0 || bytes + next.bytes <= MAX_BATCH_BYTES);
      if (!sameCapture || !roomLeft) return batch;
      batch.push(next);
      bytes += next.bytes;
      queue.shift();
    }
  }

  function record(result: AppendResult): void {
    totals.stored += result.stored;
    totals.batches += 1;
    totals.lastTxnMs = result.txnMs;
    totals.maxTxnMs = Math.max(totals.maxTxnMs, result.txnMs);
    for (const { reason } of result.rejected) {
      if (reason === 'quota') totals.quota += 1;
      else if (reason === 'capture-limit') totals.captureLimit += 1;
      else if (reason === 'duplicate') totals.duplicate += 1;
      else totals.captureMissing += 1;
    }
    if (result.txnMs > options.budgetMs * SHRINK_ABOVE) {
      batchSize = Math.max(1, Math.floor(batchSize / 2));
    } else if (result.txnMs < options.budgetMs * GROW_BELOW) {
      batchSize = Math.min(options.maxBatch, batchSize + GROW_STEP);
    }
  }

  function addLoss(
    captureId: string,
    loss: { queue: number; limit: number },
  ): void {
    const held = pendingLoss.get(captureId) ?? { queue: 0, limit: 0 };
    pendingLoss.set(captureId, {
      queue: held.queue + loss.queue,
      limit: held.limit + loss.limit,
    });
  }

  async function settleLoss(): Promise<void> {
    for (const [captureId, loss] of [...pendingLoss]) {
      pendingLoss.delete(captureId);
      try {
        await options.repo.noteLoss(captureId, loss);
      } catch (error) {
        // The count is kept for the next try: it must not vanish with the error.
        addLoss(captureId, loss);
        options.onError?.(countCode(error));
        return;
      }
    }
  }

  async function drain(): Promise<void> {
    while (queue.size > 0) {
      const batch = take();
      if (batch.length === 0) break;
      const head = batch[0];
      if (head === undefined) break;
      try {
        record(
          await options.repo.appendMessages(
            {
              captureId: head.captureId,
              ownerId: head.ownerId,
              messages: batch.map((item) => item.message),
            },
            options.limits(),
          ),
        );
      } catch (error) {
        totals.lostToError += batch.length;
        options.onError?.(countCode(error));
      }
      await settleLoss();
      await yieldToLoop();
    }
    await settleLoss();
  }

  /** Starts the loop when there is work and it is not running. */
  function start(): void {
    if (running !== undefined) return;
    if (queue.size === 0 && pendingLoss.size === 0) return;
    const done = drain().finally(() => {
      running = undefined;
    });
    running = done;
  }

  function kick(): void {
    if (running !== undefined || scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      if (queue.size > 0 || pendingLoss.size > 0) start();
    });
  }

  return {
    offer(item) {
      const taken = queue.offer(item);
      if (taken) kick();
      return taken;
    },
    hasRoom: (bytes) => {
      const stats = queue.stats();
      return (
        stats.items < stats.maxItems && stats.bytes + bytes <= stats.maxBytes
      );
    },
    refused(captureId, count, kind) {
      if (count <= 0) return;
      addLoss(captureId, {
        queue: kind === 'queue' ? count : 0,
        limit: kind === 'limit' ? count : 0,
      });
      kick();
    },
    async flush() {
      // A few rounds: work offered while a round runs is taken by the next one, and a repository
      // that keeps failing (its loss counts stay pending) does not hold the caller for ever.
      for (let round = 0; round < MAX_FLUSH_ROUNDS; round += 1) {
        start();
        const active = running;
        if (active === undefined) return;
        await active;
      }
    },
    stats() {
      const q = queue.stats();
      return {
        items: q.items,
        bytes: q.bytes,
        maxItems: q.maxItems,
        maxBytes: q.maxBytes,
        stored: totals.stored,
        rejected: {
          quota: totals.quota,
          captureLimit: totals.captureLimit,
          duplicate: totals.duplicate,
          captureMissing: totals.captureMissing,
        },
        lostToError: totals.lostToError,
        batches: totals.batches,
        lastTxnMs: totals.lastTxnMs,
        maxTxnMs: totals.maxTxnMs,
        batchSize,
      };
    },
  };
}

export type { AppendLimits };
