// Starts the capture worker (M1-09) and gives the main thread the CaptureRepository that talks to it.
// Nothing in the engine's start-up calls this yet: the first action that saves a capture does
// (OQ-980). SQLite only: Postgres uses its pool in-process, with `createRepositories(...).captures`.
import { Worker } from 'node:worker_threads';

import {
  createCaptureRepositoryClient,
  type CaptureRepositoryClient,
  type CaptureRepositoryClientOptions,
} from '@app/persistence';

export interface CaptureWorkerOptions extends CaptureRepositoryClientOptions {
  /** The SQLite file, already migrated. `:memory:` has no second connection, so it is refused. */
  readonly path: string;
  /** The bundled worker module, beside the engine bundle: `new URL('./capture.mjs', import.meta.url)`. */
  readonly workerUrl: URL;
  /** How long the worker may take to open the database. Default 10 s. */
  readonly startTimeoutMs?: number;
  /** The old-generation heap of the worker, in MB (I-6). Default 256. */
  readonly maxOldGenerationSizeMb?: number;
}

export interface CaptureWorkerHost {
  /** The repository, served by the worker. */
  readonly repo: CaptureRepositoryClient;
  /** Asks the worker to close its connection and stop; terminates it after `graceMs`. */
  stop(graceMs?: number): Promise<void>;
  /** Resolves when the worker thread has ended, for whatever reason. */
  readonly exited: Promise<number>;
}

export async function startCaptureWorker(
  options: CaptureWorkerOptions,
): Promise<CaptureWorkerHost> {
  if (options.path === ':memory:' || options.path === '') {
    throw new Error('The capture worker needs a database file.');
  }
  const worker = new Worker(options.workerUrl, {
    workerData: { path: options.path },
    resourceLimits: {
      maxOldGenerationSizeMb: options.maxOldGenerationSizeMb ?? 256,
    },
  });
  const exited = new Promise<number>((resolve) => {
    worker.once('exit', resolve);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('The capture worker did not start in time.'));
    }, options.startTimeoutMs ?? 10_000);
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(
        error instanceof Error
          ? error
          : new Error('The capture worker failed to start.'),
      );
    });
    worker.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('The capture worker stopped while starting.'));
    });
    const onMessage = (message: unknown): void => {
      if ((message as { type?: unknown } | null)?.type === 'ready') {
        clearTimeout(timer);
        worker.off('message', onMessage);
        resolve();
      }
    };
    worker.on('message', onMessage);
  });
  const repo = createCaptureRepositoryClient(worker, options);
  return {
    repo,
    exited,
    async stop(graceMs = 5000) {
      repo.close();
      worker.postMessage({ type: 'close' });
      const timer = setTimeout(() => {
        void worker.terminate();
      }, graceMs);
      timer.unref();
      await exited;
      clearTimeout(timer);
    },
  };
}
