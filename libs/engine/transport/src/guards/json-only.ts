// JSON-only bodies (blueprint 7.2): a body is `application/json` or it is refused. HTML forms and
// `text/plain` are the bodies a page can send cross-site without a preflight, so they never reach a
// parser. A request without a body needs no media type. There is no upload route yet; when one
// arrives it will be a token-guarded exception of its own.
import type { IncomingHttpHeaders } from 'node:http';

import { httpError } from '../problem-handler.ts';

const JSON_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;

export function checkJsonOnly(
  headers: IncomingHttpHeaders,
  method: string,
): void {
  const length = headers['content-length'];
  const hasBody =
    headers['transfer-encoding'] !== undefined ||
    (length !== undefined && length !== '0');
  if (!hasBody) return;
  if (method === 'GET' || method === 'HEAD') {
    throw httpError(400, 'A GET or HEAD request carries no body.');
  }
  const type = headers['content-type'];
  if (typeof type !== 'string' || !JSON_TYPE.test(type)) {
    throw httpError(415, 'The body must be application/json.');
  }
}
