// The worker side of the tier-1 pool convention (@app/plugin-host, M1-10):
//   pool -> worker  { type: 'job', id, input: PayloadInput }
//   worker -> pool  { type: 'result', id, value: DecodedPayload }  or  { type: 'failure', id }
// `decodePayload` never throws, so `failure` is only for a message this file cannot even read.
// Node starts this file itself, so it imports only relative `.ts` files and `node:` modules.
import { parentPort } from 'node:worker_threads';

import { decodePayload } from './payload/decode-payload.ts';
import type { PayloadInput } from './payload/result.ts';

const port = parentPort;

if (port !== null) {
  port.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null) return;
    const { type, id, input } = message as {
      type?: unknown;
      id?: unknown;
      input?: unknown;
    };
    if (type !== 'job' || typeof id !== 'number') return;
    try {
      port.postMessage({
        type: 'result',
        id,
        value: decodePayload(input as PayloadInput),
      });
    } catch {
      port.postMessage({ type: 'failure', id });
    }
  });
  port.postMessage({ type: 'ready' });
}
