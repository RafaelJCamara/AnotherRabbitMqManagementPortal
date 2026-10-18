// The web UI (local web and team modes): the Angular build served from disk, with a CSP nonce in
// every page. Asset directories are listed newest first (N, then N-1): a tab that still runs the
// previous build keeps finding its lazy chunks after an upgrade, while `index.html` always comes
// from N. Nothing here reads a path the client typed: each segment must match a strict alphabet,
// and the file found must still lie inside its directory after links are resolved.
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, sep } from 'node:path';

import type { EngineMode } from '@app/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { httpError } from './problem-handler.ts';

export interface StaticUiOptions {
  /** Asset directories, newest first: `[N, N-1]`. `index.html` is read from the first only. */
  readonly roots: readonly string[];
  readonly engineVersion: string;
}

/** Where `index.html` takes the nonce of the response. */
export const NONCE_PLACEHOLDER = '__CSP_NONCE__';

/**
 * The policy of spike S-04 (docs/architecture/s-04-csp-trusted-types.md). Whether it becomes the
 * binding policy is OQ-231; `BuildAppOptions.csp` replaces it without touching this file.
 */
const POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self' 'nonce-{nonce}'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; worker-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types app-worker-url app-monaco-html dompurify angular";

export function contentSecurityPolicy(nonce: string): string {
  return POLICY.replace('{nonce}', nonce);
}
const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// The first character is never a dot (no `..`, no dotfiles) and the last is not one either
// (Windows drops trailing dots); no separator, colon, percent or control character can occur.
const SEGMENT =
  /^[A-Za-z0-9_@+=~-](?:[A-Za-z0-9._@+=~-]{0,198}[A-Za-z0-9_@+=~-])?$/;
const HASHED = /[-.][A-Za-z0-9]{8,}\.[a-z0-9]+$/;

/** The decoded segments of the URL path, or undefined when any of them is not plain. */
function segmentsOf(url: string): string[] | undefined {
  const path = url.split('?', 1)[0] ?? '';
  const parts = path.split('/').slice(1);
  if (parts.at(-1) === '') parts.pop();
  if (parts.length > 10) return undefined;
  const decoded: string[] = [];
  for (const part of parts) {
    let text: string;
    try {
      text = decodeURIComponent(part);
    } catch {
      return undefined;
    }
    if (!SEGMENT.test(text)) return undefined;
    decoded.push(text);
  }
  return decoded;
}

/** The first directory holding the file; a link that leaves its directory does not count. */
async function locate(
  roots: readonly string[],
  segments: readonly string[],
): Promise<{ file: string; size: number } | undefined> {
  for (const root of roots) {
    try {
      const base = await realpath(root);
      const file = await realpath(join(base, ...segments));
      const inside = file.startsWith(base.endsWith(sep) ? base : base + sep);
      const info = await stat(file);
      if (inside && info.isFile()) return { file, size: info.size };
    } catch {
      // Not in this directory; try the previous build.
    }
  }
  return undefined;
}

export function registerStaticUi(
  app: FastifyInstance,
  options: StaticUiOptions,
  mode: EngineMode,
): void {
  const [root] = options.roots;
  if (root === undefined || !options.roots.every((dir) => isAbsolute(dir))) {
    throw new TypeError(
      'The UI needs absolute asset directories, newest first.',
    );
  }
  const newest: string = root;
  const config = { public: true };
  const bootstrap = JSON.stringify({
    engineVersion: options.engineVersion,
    apiVersion: 'v1',
    mode,
  });

  async function page(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const html = await readFile(join(newest, 'index.html'), 'utf8').catch(
      () => undefined,
    );
    if (html === undefined) throw httpError(404, 'The UI is not installed.');
    return reply
      .header('content-type', TYPES['.html'])
      .send(html.replaceAll(NONCE_PLACEHOLDER, request.cspNonce));
  }

  async function serve(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const segments = segmentsOf(request.raw.url ?? '');
    // `api` belongs to the router; the UI never shadows it.
    if (segments === undefined || segments[0]?.toLowerCase() === 'api') {
      throw httpError(404, 'No such file.');
    }
    const name = segments.at(-1);
    // Only the root `index.html` is the page; it is the one file that takes a nonce.
    if (
      name === undefined ||
      (segments.length === 1 && name.toLowerCase() === 'index.html')
    ) {
      return page(request, reply);
    }
    const found = await locate(options.roots, segments);
    if (found === undefined) {
      // An address of the Angular router (no extension) gets the app; a missing file is a 404.
      const wantsPage =
        !name.includes('.') && request.headers.accept?.includes('text/html');
      if (wantsPage === true) return page(request, reply);
      throw httpError(404, 'No such file.');
    }
    return reply
      .header(
        'content-type',
        TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream',
      )
      .header('content-length', found.size)
      .header(
        'cache-control',
        HASHED.test(name) ? 'public, max-age=31536000, immutable' : 'no-cache',
      )
      .send(createReadStream(found.file));
  }

  app.get('/bootstrap.json', { config }, (_request, reply) =>
    reply.header('content-type', TYPES['.json']).send(bootstrap),
  );
  app.route({
    method: ['GET', 'HEAD'],
    url: '/*',
    config,
    handler: serve,
  });
  app.route({ method: ['GET', 'HEAD'], url: '/', config, handler: page });
}
