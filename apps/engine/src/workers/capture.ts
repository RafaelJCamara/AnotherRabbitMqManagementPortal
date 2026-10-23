// The capture-ingest/search worker (M1-09, blueprint 1.4, OQ-980). It runs in a worker thread, opens
// its own connection to the SQLite database the engine already migrated, and serves the capture
// repository to the main thread over the thread's message port. A transaction (and the tokenising
// of the index inside it) therefore blocks this thread, never the engine's event loop (I-5).
//
// It holds no key and sees no plaintext body: the main thread seals before it posts, and what arrives
// here is ciphertext and the redacted projection. It is a second entry of the engine bundle
// (`apps/engine/project.json`), started by `capture-host.ts`.
//
// Two settings of this connection only (OQ-993):
//   synchronous = NORMAL   in WAL mode the log is synced at checkpoints, not at every commit. An engine
//                          crash loses nothing; a power cut can lose the last committed batches of
//                          captures (copies the person can take again) and never corrupts the file.
//   wal_autocheckpoint = 0 SQLite would otherwise checkpoint inside whichever commit crosses 1,000
//                          pages, which makes that one transaction tens of milliseconds long. The
//                          worker checkpoints (passively) after `CHECKPOINT_BYTES` of writes, between
//                          requests, and fully when it closes.
import { parentPort, workerData } from 'node:worker_threads';

import {
  createRepositories,
  executeRawStatement,
  openSqlite,
  serveCaptureRepository,
} from '@app/persistence';

/** Bytes written between two checkpoints. */
const CHECKPOINT_BYTES = 8 * 1024 * 1024;

const port = parentPort;
const data = workerData as { path?: unknown } | null;

if (port !== null && typeof data?.path === 'string') {
  const handle = await openSqlite({ path: data.path });
  await executeRawStatement(handle, 'PRAGMA synchronous = NORMAL');
  await executeRawStatement(handle, 'PRAGMA wal_autocheckpoint = 0');
  const repo = createRepositories(handle).captures;
  let written = 0;
  let checkpointing = false;
  const served: typeof repo = {
    ...repo,
    appendMessages: async (batch, limits) => {
      const result = await repo.appendMessages(batch, limits);
      written += result.storedBytes;
      if (written >= CHECKPOINT_BYTES && !checkpointing) {
        written = 0;
        checkpointing = true;
        void executeRawStatement(handle, 'PRAGMA wal_checkpoint(PASSIVE)')
          .catch(() => undefined)
          .finally(() => {
            checkpointing = false;
          });
      }
      return result;
    },
  };
  const server = serveCaptureRepository(served, port);
  port.on('message', (message: unknown) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      (message as { type?: unknown }).type === 'close'
    ) {
      server.close();
      void executeRawStatement(handle, 'PRAGMA wal_checkpoint(TRUNCATE)')
        .catch(() => undefined)
        .then(() => handle.close())
        .finally(() => {
          port.close();
        });
    }
  });
  port.postMessage({ type: 'ready' });
}
