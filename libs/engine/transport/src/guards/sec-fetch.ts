// Fetch metadata (blueprint 7.2): a browser tells the server where a request came from, in headers
// a page cannot forge. Anything but `same-origin` is refused. A user typing the address gives
// `none`, which is accepted only for a navigation to the UI itself. Clients that send no
// `Sec-Fetch-*` headers (curl, the CLI) are not browsers and still need the token.
import type { IncomingHttpHeaders } from 'node:http';

import { httpError } from '../problem-handler.ts';

export function checkSecFetch(
  headers: IncomingHttpHeaders,
  navigation: boolean,
): void {
  const site = headers['sec-fetch-site'];
  if (site === undefined) return;
  if (typeof site === 'string' && site.toLowerCase() === 'same-origin') return;
  if (
    navigation &&
    site === 'none' &&
    headers['sec-fetch-mode'] === 'navigate'
  ) {
    return;
  }
  throw httpError(403, 'Cross-site requests are refused.');
}
