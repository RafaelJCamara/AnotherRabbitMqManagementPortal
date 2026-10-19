// The control channel between a supervising process and the engine (blueprint 2.3): the Electron
// main process over `process.parentPort`, or any Node parent over the IPC channel of `fork`. Every
// frame is validated on receipt with the contract schema; one that does not match is dropped and
// reported by field name only, because a frame may carry the data key (I-10).
import { CtlFrameSchema, type CtlFrame } from '@app/contracts';

/** The raw transport: it hands over whatever the peer sent, unvalidated. */
export interface CtlTransport {
  post(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
}

export interface CtlPort {
  post(frame: CtlFrame): void;
  /** Resolves with the next frame of this type, or one that already arrived. Rejects after `timeoutMs`. */
  next<T extends CtlFrame['t']>(
    type: T,
    timeoutMs: number,
  ): Promise<Extract<CtlFrame, { t: T }>>;
  /** Called for every valid frame, after any `next` waiter. */
  onFrame(listener: (frame: CtlFrame) => void): void;
  /** Called with the names of the fields of a frame that failed validation. Never with values. */
  onInvalid(listener: (fields: readonly string[]) => void): void;
}

interface Waiter {
  readonly type: string;
  resolve(frame: CtlFrame): void;
}

export function createCtlPort(transport: CtlTransport): CtlPort {
  const listeners: ((frame: CtlFrame) => void)[] = [];
  const invalidListeners: ((fields: readonly string[]) => void)[] = [];
  let waiters: Waiter[] = [];
  /** The newest frame of each type that nobody was waiting for: at most one per frame type. */
  const early = new Map<string, CtlFrame>();

  transport.onMessage((message) => {
    const parsed = CtlFrameSchema.safeParse(message);
    if (!parsed.success) {
      const fields = [
        ...new Set(
          parsed.error.issues.map((issue) => issue.path.join('.') || 't'),
        ),
      ];
      for (const listener of invalidListeners) listener(fields);
      return;
    }
    const frame = parsed.data;
    const waiting = waiters.filter((waiter) => waiter.type === frame.t);
    if (waiting.length === 0) early.set(frame.t, frame);
    waiters = waiters.filter((waiter) => waiter.type !== frame.t);
    for (const waiter of waiting) waiter.resolve(frame);
    for (const listener of listeners) listener(frame);
  });

  return {
    post: (frame) => {
      transport.post(CtlFrameSchema.parse(frame));
    },
    next: <T extends CtlFrame['t']>(type: T, timeoutMs: number) =>
      new Promise<Extract<CtlFrame, { t: T }>>((resolve, reject) => {
        const have = early.get(type);
        if (have !== undefined) {
          early.delete(type);
          resolve(have as Extract<CtlFrame, { t: T }>);
          return;
        }
        const timer = setTimeout(() => {
          waiters = waiters.filter((waiter) => waiter !== waiter0);
          reject(
            new Error(
              `No ctl:${type} frame arrived within ${String(timeoutMs)} ms.`,
            ),
          );
        }, timeoutMs);
        const waiter0: Waiter = {
          type,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame as Extract<CtlFrame, { t: T }>);
          },
        };
        waiters.push(waiter0);
      }),
    onFrame: (listener) => {
      listeners.push(listener);
    },
    onInvalid: (listener) => {
      invalidListeners.push(listener);
    },
  };
}

/** What a process exposes for its supervisor, if anything. */
export interface CtlProcess {
  parentPort?: {
    postMessage(message: unknown): void;
    on(event: 'message', handler: (event: { data: unknown }) => void): void;
  };
  send?: (message: unknown) => boolean;
  on(event: 'message', handler: (message: unknown) => void): unknown;
}

/** The transport of `process`: Electron's utility-process parent port, else a Node IPC channel. */
export function detectCtlTransport(proc: CtlProcess): CtlTransport | undefined {
  const { parentPort, send } = proc;
  if (parentPort !== undefined) {
    return {
      post: (message) => {
        parentPort.postMessage(message);
      },
      onMessage: (handler) => {
        parentPort.on('message', (event) => {
          handler(event.data);
        });
      },
    };
  }
  if (typeof send === 'function') {
    return {
      post: (message) => {
        send.call(proc, message);
      },
      onMessage: (handler) => {
        proc.on('message', handler);
      },
    };
  }
  return undefined;
}
