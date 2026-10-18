// Static file server for the spike. It plays the part of the `app://` protocol handler (desktop)
// and of the engine's static route (local web): every response carries the CSP under test, and
// every HTML response gets a fresh nonce.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/**
 * @param {object} options
 * @param {string} options.root directory to serve
 * @param {string | undefined} options.csp policy template (`{N}` = nonce), or undefined for none
 * @param {boolean} [options.reportOnly] send Content-Security-Policy-Report-Only instead
 * @param {boolean} [options.angular] treat index.html as an Angular shell: put the nonce on the root
 */
export async function startServer({
  root,
  csp,
  reportOnly = false,
  angular = false,
}) {
  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      response.writeHead(500).end(String(error));
    });
  });

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(root, path));
    if (!file.startsWith(root + sep)) {
      response.writeHead(403).end();
      return;
    }
    let body;
    try {
      body = await readFile(file);
    } catch {
      // SPA fallback only for the Angular shell.
      if (!angular || extname(path) !== '') {
        response.writeHead(404).end('not found');
        return;
      }
      body = await readFile(join(root, 'index.html'));
      path = '/index.html';
    }
    const nonce = randomBytes(16).toString('base64');
    const type = MIME[extname(path)] ?? 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    if (csp !== undefined) {
      const name = reportOnly
        ? 'Content-Security-Policy-Report-Only'
        : 'Content-Security-Policy';
      headers[name] = csp.replaceAll('{N}', nonce);
    }
    if (extname(path) === '.html') {
      let html = body.toString('utf8').replaceAll('{{NONCE}}', nonce);
      if (angular) {
        // What the engine/main process does for the Angular shell: nonce for Angular's own <style>.
        html = html.replace('<app-root', `<app-root ngCspNonce="${nonce}"`);
      }
      body = Buffer.from(html);
    }
    response.writeHead(200, headers).end(body);
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // Browsers keep idle connections open; do not wait for them.
        server.closeAllConnections();
      }),
  };
}
