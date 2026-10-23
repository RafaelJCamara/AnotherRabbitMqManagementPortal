// The CaptureRepository over a message port (M1-09, blueprint 1.4): on SQLite the capture-ingest and
// search worker owns a second connection to the database, so a transaction (and the index
// tokenisation inside it) blocks the worker's thread and never the engine's main loop (I-5).
//
//   server  `serveCaptureRepository(repo, endpoint)` in the worker: answers `{id, method, args}` with
//           `{id, ok, value}` or `{id, ok: false, error}`. Only the repository's own methods are
//           callable, and an error leaves the worker as a code and a fixed sentence, never as the
//           text of the database's error.
//   client  `createCaptureRepositoryClient(endpoint)` on the main thread: the same interface as the
//           repository. At most `maxInFlight` requests are open (more are refused at once and
//           counted, I-6), each has a deadline, and a worker that is gone rejects every open request.
//
// What crosses the port is what the repository already holds: sealed bytes and masked text, never a
// key or a plaintext body (the sealing is the service's, on the main thread).
import {
  CaptureSearchUnavailableError,
  type CaptureRepository,
} from '@app/ports';

/** The part of a `Worker`, a `MessagePort` or a `MessageChannel` end that this file uses. */
export interface RpcEndpoint {
  postMessage(value: unknown): void;
  on(event: string, listener: (value: unknown) => void): unknown;
}

const METHODS = [
  'createCapture',
  'getCapture',
  'listCaptures',
  'appendMessages',
  'queryMessages',
  'getMessage',
  'getBlobChunks',
  'noteLoss',
  'deleteCapture',
  'purgeExpired',
  'usage',
  'searchAvailable',
] as const satisfies readonly (keyof CaptureRepository)[];

type Method = (typeof METHODS)[number];

const isMethod = (value: unknown): value is Method =>
  typeof value === 'string' && (METHODS as readonly string[]).includes(value);

interface Request {
  readonly id: number;
  readonly method: Method;
  readonly args: readonly unknown[];
}

type Reply =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | {
      readonly id: number;
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

/** The codes a client turns back into errors; anything else is `CAPTURE_STORE_ERROR`. */
const SEARCH_UNAVAILABLE = 'CAPTURE_SEARCH_UNAVAILABLE';
const STORE_ERROR = 'CAPTURE_STORE_ERROR';
const INVALID = 'CAPTURE_INVALID_REQUEST';

export class CaptureWorkerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CaptureWorkerError';
    this.code = code;
  }
}

function fail(id: number, error: unknown): Reply {
  if (error instanceof CaptureSearchUnavailableError) {
    return {
      id,
      ok: false,
      error: { code: SEARCH_UNAVAILABLE, message: error.message },
    };
  }
  if (error instanceof RangeError) {
    return {
      id,
      ok: false,
      error: { code: INVALID, message: 'The request is out of range.' },
    };
  }
  // Not the database's words: they can name a column or a constraint, and a message is not ours to
  // describe. The service logs only the code.
  return {
    id,
    ok: false,
    error: { code: STORE_ERROR, message: 'The capture store failed.' },
  };
}

function isRequest(value: unknown): value is Request {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'number' && isMethod(v.method) && Array.isArray(v.args)
  );
}

export interface CaptureRpcServer {
  /** Stops answering; requests that arrive afterwards are ignored. */
  close(): void;
}

export function serveCaptureRepository(
  repo: CaptureRepository,
  endpoint: RpcEndpoint,
): CaptureRpcServer {
  let open = true;
  const handle = (message: unknown): void => {
    if (!open || !isRequest(message)) return;
    const { id, method, args } = message;
    const call = Reflect.get(repo, method) as (
      ...a: unknown[]
    ) => Promise<unknown>;
    void Promise.resolve()
      .then(() => Reflect.apply(call, repo, args))
      .then(
        (value): Reply => ({ id, ok: true, value }),
        (error: unknown) => fail(id, error),
      )
      .then((reply) => {
        if (open) endpoint.postMessage(reply);
      });
  };
  endpoint.on('message', handle);
  return {
    close() {
      open = false;
    },
  };
}

export interface CaptureRepositoryClientOptions {
  /** A request that is not answered by then is rejected. Default 30 s. */
  readonly timeoutMs?: number;
  /** Requests open at once; more are refused and counted. Default 64. */
  readonly maxInFlight?: number;
}

export interface CaptureRpcStats {
  readonly inFlight: number;
  readonly maxInFlight: number;
  /** Requests refused because too many were open. */
  readonly refused: number;
  readonly timeouts: number;
  readonly closed: boolean;
}

export interface CaptureRepositoryClient extends CaptureRepository {
  stats(): CaptureRpcStats;
  /** Rejects every open request and refuses new ones. Does not stop the worker. */
  close(): void;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export function createCaptureRepositoryClient(
  endpoint: RpcEndpoint,
  options: CaptureRepositoryClientOptions = {},
): CaptureRepositoryClient {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxInFlight = options.maxInFlight ?? 64;
  const pending = new Map<number, Pending>();
  let next = 1;
  let closed = false;
  let refused = 0;
  let timeouts = 0;

  const rejectAll = (error: Error): void => {
    for (const [id, entry] of [...pending]) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  };
  const gone = (): CaptureWorkerError =>
    new CaptureWorkerError(
      'CAPTURE_WORKER_GONE',
      'The capture worker is not running.',
    );

  endpoint.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null) return;
    const reply = message as Partial<Reply>;
    if (typeof reply.id !== 'number') return;
    const entry = pending.get(reply.id);
    if (entry === undefined) return;
    pending.delete(reply.id);
    clearTimeout(entry.timer);
    if (reply.ok === true) {
      entry.resolve(reply.value);
    } else if (reply.ok === false && reply.error !== undefined) {
      entry.reject(
        reply.error.code === SEARCH_UNAVAILABLE
          ? new CaptureSearchUnavailableError()
          : reply.error.code === INVALID
            ? new RangeError(reply.error.message)
            : new CaptureWorkerError(STORE_ERROR, reply.error.message),
      );
    }
  });
  for (const event of ['close', 'exit', 'error', 'messageerror']) {
    endpoint.on(event, () => {
      closed = true;
      rejectAll(gone());
    });
  }

  function call<T>(method: Method, args: readonly unknown[]): Promise<T> {
    if (closed) return Promise.reject(gone());
    if (pending.size >= maxInFlight) {
      refused += 1;
      return Promise.reject(
        new CaptureWorkerError(
          'CAPTURE_WORKER_BUSY',
          'The capture worker has too many requests open.',
        ),
      );
    }
    const id = next;
    next += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        timeouts += 1;
        reject(
          new CaptureWorkerError(
            'CAPTURE_WORKER_TIMEOUT',
            'The capture worker did not answer in time.',
          ),
        );
      }, timeoutMs);
      timer.unref();
      pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        endpoint.postMessage({ id, method, args } satisfies Request);
      } catch {
        pending.delete(id);
        clearTimeout(timer);
        reject(gone());
      }
    });
  }

  return {
    createCapture: (capture) => call('createCapture', [capture]),
    getCapture: (ownerId, id) => call('getCapture', [ownerId, id]),
    listCaptures: (ownerId, query) => call('listCaptures', [ownerId, query]),
    appendMessages: (batch, limits) => call('appendMessages', [batch, limits]),
    queryMessages: (ownerId, query) => call('queryMessages', [ownerId, query]),
    getMessage: (ownerId, captureId, id) =>
      call('getMessage', [ownerId, captureId, id]),
    getBlobChunks: (ownerId, ref, from, to) =>
      call('getBlobChunks', [ownerId, ref, from, to]),
    noteLoss: (captureId, loss) => call('noteLoss', [captureId, loss]),
    deleteCapture: (ownerId, id) => call('deleteCapture', [ownerId, id]),
    purgeExpired: (now, limit) => call('purgeExpired', [now, limit]),
    usage: (ownerId) => call('usage', [ownerId]),
    searchAvailable: () => call('searchAvailable', []),
    stats: () => ({
      inFlight: pending.size,
      maxInFlight,
      refused,
      timeouts,
      closed,
    }),
    close() {
      closed = true;
      rejectAll(gone());
    },
  };
}
