// Where and how the local web mode listens (blueprint 1.2 and 7.2, ADR-016, amendment A-12).
//
//   native      binds loopback only. A bind anywhere else is refused with guidance: outside loopback
//               the engine would need real authentication and TLS, which this build does not have
//               (DC-36). Remote use is an SSH tunnel.
//   container   `APP_RUNTIME=container` (the image sets it). The engine binds 0.0.0.0:8765 inside the
//               container's network namespace, because published traffic arrives there; what is
//               exposed is decided by the `-p 127.0.0.1:HOSTPORT:8765` publish, which the banner
//               prints and the docs require. The token is always required, the Host allow-list is the
//               transport's (loopback names on any port plus the public origins) and a public origin
//               must itself be loopback until real auth and https exist (A-12).
//
// Pure: it reads nothing but the token file, and creates nothing, so a refusal happens before the
// data directory is touched, a lock taken or a socket bound.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { EngineArgs } from '../entry/args.ts';
import { UsageError } from '../entry/args.ts';
import type { EnvConfig } from '../entry/env.ts';
import { ModeRefusedError } from './types.ts';

export type WebRuntime = 'native' | 'container';

export interface WebBinding {
  readonly runtime: WebRuntime;
  readonly host: string;
  readonly port: number;
  readonly publicOrigins: readonly string[];
  readonly dataDir: string;
  readonly kekFile?: string;
  readonly uiDir?: string;
  readonly token: {
    readonly value: string;
    readonly source: 'generated' | 'env' | 'file';
  };
  readonly open: boolean;
}

/** ADR-016: the port the container image documents. */
export const CONTAINER_PORT = 8765;
const CONTAINER_DATA_DIR = '/data';
const MAX_PUBLIC_ORIGINS = 8;

/** The shape the transport accepts as a launch token (and the web app as a fragment value). */
const TOKEN = /^[A-Za-z0-9_-]{32,512}$/;
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

const readUtf8 = (path: string): string => readFileSync(path, 'utf8');
const newToken = (): string => randomBytes(32).toString('base64url');

function nativeHost(raw: string | undefined): string {
  const host = (raw ?? '127.0.0.1').replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (host === '127.0.0.1' || host === '::1') return host;
  if (host === 'localhost') return '127.0.0.1';
  throw new ModeRefusedError(
    'That --host is refused: outside loopback the engine needs real authentication and TLS, which this build does not have (DC-36). ' +
      'Keep the default 127.0.0.1 and reach it from another machine through an SSH tunnel (ssh -L <local port>:127.0.0.1:<engine port> <user>@<host>), ' +
      'or run the container (APP_RUNTIME=container), which is published on 127.0.0.1 only.',
  );
}

function containerHost(raw: string | undefined): string {
  const host = (raw ?? '0.0.0.0').replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (['0.0.0.0', '::', '127.0.0.1', '::1'].includes(host)) return host;
  if (host === 'localhost') return '127.0.0.1';
  throw new ModeRefusedError(
    'That host is refused in container mode: bind 0.0.0.0 (the default) or :: inside the container and decide the exposure with the publish, ' +
      'docker run -p 127.0.0.1:<host port>:8765.',
  );
}

/**
 * Origins this engine is reached at (a published port, a proxy). Until real authentication and https
 * exist (A-12), only loopback names qualify; the host port they carry is what the banner prints.
 */
function parseOrigins(text: string | undefined): readonly string[] {
  if (text === undefined) return [];
  const parts = [
    ...new Set(
      text
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== ''),
    ),
  ];
  if (parts.length === 0 || parts.length > MAX_PUBLIC_ORIGINS) {
    throw new UsageError(
      `The public origin list needs 1 to ${String(MAX_PUBLIC_ORIGINS)} origins, comma separated.`,
    );
  }
  return parts.map((part) => {
    let url: URL;
    try {
      url = new URL(part);
    } catch {
      url = new URL('invalid:');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== part.toLowerCase()
    ) {
      throw new UsageError(
        'A public origin is written scheme://host[:port] with no path, user, query or trailing slash.',
      );
    }
    if (!LOOPBACK_NAMES.has(url.hostname)) {
      throw new ModeRefusedError(
        'A public origin outside loopback is refused: it needs real authentication and https, which this build does not have (A-12). ' +
          'Use an SSH tunnel to the loopback port instead.',
      );
    }
    return url.origin;
  });
}

function resolveToken(
  args: EngineArgs,
  env: EnvConfig,
  readFile: (path: string) => string,
): WebBinding['token'] {
  let value: string;
  let source: 'env' | 'file';
  if (args.tokenFile !== undefined) {
    try {
      value = readFile(args.tokenFile).replace(/\r?\n$/, '');
    } catch {
      throw new UsageError('--token-file could not be read.');
    }
    source = 'file';
  } else if (env.token !== undefined) {
    value = env.token;
    source = 'env';
  } else {
    return { value: newToken(), source: 'generated' };
  }
  if (!TOKEN.test(value)) {
    throw new UsageError(
      `The launch token (${source === 'file' ? '--token-file or APP_TOKEN_FILE' : 'APP_TOKEN'}) must be 32 to 512 characters of A-Za-z0-9_- (for example 43 characters of base64url from 32 random bytes).`,
    );
  }
  return { value, source };
}

export function resolveWebBinding(
  args: EngineArgs,
  env: EnvConfig = {},
  readFile: (path: string) => string = readUtf8,
): WebBinding {
  const runtime: WebRuntime = env.runtime ?? 'native';
  const container = runtime === 'container';
  const host = container
    ? containerHost(args.host ?? env.host)
    : nativeHost(args.host ?? env.host);
  if (container && args.open === true) {
    throw new UsageError(
      '--open is not available in container mode: there is no browser inside a container.',
    );
  }
  const dataDir =
    args.dataDir ?? env.dataDir ?? (container ? CONTAINER_DATA_DIR : undefined);
  if (dataDir === undefined) {
    throw new UsageError('Local mode needs --data-dir.');
  }
  const publicOrigins = parseOrigins(args.publicOrigin ?? env.publicOrigin);
  const kekFile = args.kekFile ?? env.kekPath;
  const uiDir = args.uiDir ?? env.uiDir;
  return {
    runtime,
    host,
    port: args.port ?? env.port ?? (container ? CONTAINER_PORT : 0),
    publicOrigins,
    dataDir,
    ...(kekFile === undefined ? {} : { kekFile }),
    ...(uiDir === undefined ? {} : { uiDir }),
    token: resolveToken(args, env, readFile),
    open: args.open ?? false,
  };
}

const urlHost = (host: string): string =>
  host.includes(':') ? `[${host}]` : host;

/** The line a person opens. The token is in the fragment, which a browser never sends to a server. */
export function launchUrl(
  binding: WebBinding,
  address: { host: string; port: number },
): string {
  const origin =
    binding.runtime === 'container'
      ? (binding.publicOrigins[0] ?? `http://127.0.0.1:${String(address.port)}`)
      : `http://${urlHost(address.host)}:${String(address.port)}`;
  return `${origin}/#t=${binding.token.value}`;
}

/** The container banner (ADR-016): the exact publish line, what never to do, and what to know. */
export function containerNotice(
  binding: WebBinding,
  address: { port: number },
): readonly string[] {
  const inside = String(address.port);
  const firstOrigin = binding.publicOrigins[0];
  const originUrl =
    firstOrigin === undefined ? undefined : new URL(firstOrigin);
  const hostPort =
    originUrl === undefined
      ? inside
      : originUrl.port || (originUrl.protocol === 'https:' ? '443' : '80');
  return [
    `Container mode: the engine listens on ${binding.host}:${inside} inside the container. The publish decides who can reach it.`,
    `Run the container with:  docker run -p 127.0.0.1:${hostPort}:${inside} -v <volume>:${binding.dataDir} <image>`,
    'Never publish with -p 8765:8765, with -p 0.0.0.0:..., or with --network host: a published port bypasses host firewalls such as ufw.',
    'For use from another machine, tunnel to the loopback port (ssh -L). A public origin needs real authentication and https, which this build does not have.',
    ...(binding.kekFile === undefined
      ? [
          'No key file is set (APP_KEK_PATH): the credential vault stays locked, so connections with stored passwords cannot be used.',
        ]
      : []),
    binding.token.source === 'generated'
      ? 'The launch token was made for this run and is in this output only; a restart makes a new one. Set APP_TOKEN_FILE for a fixed token.'
      : `The launch token comes from ${binding.token.source === 'file' ? 'a file' : 'APP_TOKEN, which docker inspect can show; a file secret (APP_TOKEN_FILE) is safer'}.`,
  ];
}
