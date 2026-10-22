// The small static server of the harness page: what the engine's static route does for the web UI
// (`libs/engine/transport/src/static-ui.ts`), reduced to what this page needs. Every response carries the
// Content-Security-Policy of the engine (spike S-04: `require-trusted-types-for 'script'`, `style-src 'self'
// 'nonce-N'`, no `unsafe-eval`; the policy text is `contentSecurityPolicy` of `@app/transport`, so there is one
// copy), and the page gets a fresh nonce in every `index.html` (the placeholder is the engine's too).
import { randomBytes } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, sep } from 'node:path';

import { contentSecurityPolicy, NONCE_PLACEHOLDER } from '@app/transport';

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export interface PageServer {
  readonly url: string;
  /** The `Content-Security-Policy` values this server sent, one per response (the test reads what was enforced). */
  readonly policies: readonly string[];
  close(): Promise<void>;
}

/** The one rule of the engine's policy that lets markup carry a `style` attribute. */
const STYLE_ATTR_RULE = "style-src-attr 'unsafe-inline'; ";

export interface PageServerOptions {
  /**
   * Send the engine's policy WITHOUT `style-src-attr 'unsafe-inline'`: then `style-src 'self' 'nonce-N'` alone
   * decides, and no element may carry a `style` attribute written in markup (the CSSOM is not governed).
   */
  readonly strictStyleAttributes?: boolean;
}

/** Serves `root` on a free loopback port. */
export async function startPageServer(
  root: string,
  options: PageServerOptions = {},
): Promise<PageServer> {
  const base = await realpath(root);
  const policies: string[] = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      const path = decodeURIComponent(
        new URL(request.url ?? '/', 'http://localhost').pathname,
      );
      const name = path === '/' ? 'index.html' : path.slice(1);
      let file: string;
      try {
        file = await realpath(join(base, name));
      } catch {
        response.writeHead(404).end('not found');
        return;
      }
      if (!file.startsWith(base + sep)) {
        response.writeHead(403).end('forbidden');
        return;
      }
      const nonce = randomBytes(16).toString('base64');
      const engine = contentSecurityPolicy(nonce);
      const policy =
        options.strictStyleAttributes === true
          ? engine.replace(STYLE_ATTR_RULE, '')
          : engine;
      policies.push(policy);
      const type = TYPES[extname(file)] ?? 'application/octet-stream';
      let body: string | Buffer = await readFile(file);
      if (extname(file) === '.html') {
        body = body.toString('utf8').replaceAll(NONCE_PLACEHOLDER, nonce);
      }
      response
        .writeHead(200, {
          'content-type': type,
          'content-security-policy': policy,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        .end(body);
    })().catch((error: unknown) => {
      response.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the page server has no port');
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}/`,
    policies,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        // A browser keeps idle connections open; do not wait for them.
        server.closeAllConnections();
      }),
  };
}
