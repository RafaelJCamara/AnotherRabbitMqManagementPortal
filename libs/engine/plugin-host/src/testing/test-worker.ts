// A worker for the pool's specs. Each job names an operation; the hostile ones are the point.
// Imports only `node:` modules: Node starts this file itself.
import { parentPort, workerData } from 'node:worker_threads';

interface Job {
  readonly type: string;
  readonly id: number;
  readonly input: { readonly op?: string; readonly [key: string]: unknown };
}

// workerData.flags is a SharedArrayBuffer of Int32: [0] releases `hold`, [1] releases `spin-until`.
const flags = new Int32Array(
  (workerData as { flags: SharedArrayBuffer } | undefined)?.flags ??
    new SharedArrayBuffer(8),
);

async function handle(input: Job['input']): Promise<unknown> {
  switch (input.op) {
    case 'echo':
      return input.value;
    case 'hold': {
      // Held until the spec stores 1 in flags[0]; the event loop stays free to hear it.
      while (Atomics.load(flags, 0) === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
      }
      return 'released';
    }
    case 'spin': {
      for (;;) {
        // a decode that never ends
      }
    }
    case 'spin-until': {
      // Busy until the main thread stores 1 in flags[1]: the work is off the main loop or the
      // spec never ends.
      while (Atomics.load(flags, 1) === 0) {
        // busy
      }
      return 'spun';
    }
    case 'hog': {
      const hoard: number[][] = [];
      for (;;) hoard.push(new Array<number>(100_000).fill(7));
    }
    case 'big':
      return new Uint8Array(Number(input.bytes));
    case 'throw':
      throw new Error('boom');
    case 'exit':
      process.exit(3);
      return undefined;
    case 'clone-me':
      return { fine: true };
    default:
      return undefined;
  }
}

const port = parentPort;
if (port !== null) {
  port.on('message', (message: Job) => {
    if (message.type !== 'job') return;
    if (message.input.op === 'garbage') {
      port.postMessage('not an object');
      return;
    }
    if (message.input.op === 'wrong-id') {
      port.postMessage({ type: 'result', id: message.id + 1000, value: 1 });
      return;
    }
    handle(message.input).then(
      (value) => {
        port.postMessage({ type: 'result', id: message.id, value });
      },
      () => {
        port.postMessage({ type: 'failure', id: message.id });
      },
    );
  });
  port.postMessage({ type: 'ready' });
}
