// Raw management HTTP for the lab: one request to `/api/...` of a LabEndpoint, with no retry and no
// interpretation, so a scenario sees the status and the body the broker really answered. It also
// reaches the paths a product would never call (`POST /api/queues/{vhost}/{queue}/get` with a
// destructive `ackmode`), which is what a conformance scenario is for.
//
// It talks to the loopback address of an endpoint broker-lab created, and nothing else: the host
// and port come from the endpoint, not from the caller, and the path must start with `/api/`.
import { request } from 'node:http';

import { assertLabEndpoint, type LabEndpoint } from './lab-endpoint.ts';

export interface HttpRawResponse {
  readonly status: number;
  /** The parsed JSON body, or `undefined` when the body is empty or not JSON. */
  readonly json: unknown;
}

export interface HttpRawRequest {
  readonly method: 'GET' | 'PUT' | 'POST' | 'DELETE';
  /** `/api/...`, percent-encoded by the caller (a vhost `/` is `%2F`). */
  readonly path: string;
  readonly body?: unknown;
  readonly timeoutMs?: number;
}

const API_PATH =
  /^\/api\/[A-Za-z0-9._~%@!$&'()*+,;=:/-]*(?:\?[A-Za-z0-9._~%=&-]*)?$/;

export async function httpRaw(
  endpoint: LabEndpoint,
  call: HttpRawRequest,
): Promise<HttpRawResponse> {
  assertLabEndpoint(endpoint);
  if (!API_PATH.test(call.path) || call.path.split('/').includes('..')) {
    throw new Error(
      `the path ${JSON.stringify(call.path)} is not a management API path`,
    );
  }
  const payload =
    call.body === undefined
      ? undefined
      : Buffer.from(JSON.stringify(call.body));
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: endpoint.host,
        port: endpoint.httpPort,
        path: call.path,
        method: call.method,
        auth: `${endpoint.credentials.username}:${endpoint.credentials.password}`,
        timeout: call.timeoutMs ?? 15_000,
        headers: {
          accept: 'application/json',
          ...(payload === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': String(payload.length),
              }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('error', reject);
        response.once('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown;
          try {
            json = text === '' ? undefined : (JSON.parse(text) as unknown);
          } catch {
            json = undefined;
          }
          resolve({ status: response.statusCode ?? 0, json });
        });
      },
    );
    outgoing.once('timeout', () => {
      outgoing.destroy(new Error(`${call.method} ${call.path} timed out`));
    });
    outgoing.once('error', reject);
    outgoing.end(payload);
  });
}
