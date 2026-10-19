// How a probe step reads the broker: GET only, in the interactive lane (a person asked for the
// probe), with a schema of its own so the scheduler neither merges nor reuses the answer.
import type { MgmtQuery } from '@app/ports';
import type { z } from 'zod';

import { uncached } from './schemas';
import type { ProbeEnv } from './types';

/** Largest text a step reads from an answer that is not JSON. */
const MAX_TEXT_BYTES = 64 * 1024;

export function read<T>(
  env: ProbeEnv,
  path: string,
  schema: z.ZodType<T>,
  query?: MgmtQuery,
): Promise<T> {
  return env.mgmt.get(
    {
      connectionId: env.connectionId,
      path,
      schema: uncached(schema),
      lane: 'interactive',
      ...(query === undefined ? {} : { query }),
    },
    env.signal,
  );
}

/** The first bytes of a text answer (a script), cut at `MAX_TEXT_BYTES`, never more (I-6). */
export async function readText(env: ProbeEnv, path: string): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  const body = await env.mgmt.stream(
    { connectionId: env.connectionId, path, lane: 'interactive' },
    env.signal,
  );
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk));
    size += chunk.length;
    if (size >= MAX_TEXT_BYTES) break;
  }
  return Buffer.concat(chunks).subarray(0, MAX_TEXT_BYTES).toString('utf8');
}
