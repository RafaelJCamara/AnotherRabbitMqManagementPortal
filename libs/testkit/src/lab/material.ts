import { execFile } from 'node:child_process';
import { generateKeyPairSync, createSign, type KeyObject } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** A self-signed certificate for `localhost` / 127.0.0.1; it is its own CA. */
export interface TlsMaterial {
  /** Folder with ca.pem, server.pem and server.key (copied to /etc/rabbitmq/tls). */
  readonly dir: string;
  /** The certificate, for clients to trust. */
  readonly caPath: string;
}

/**
 * Creates the TLS material with the openssl CLI (present on the Linux runners and with Git for
 * Windows). The key is world-readable on purpose: it only lives in a throwaway directory and
 * a container whose user differs from the owner has to read it.
 */
export async function generateTlsMaterial(
  parent: string,
): Promise<TlsMaterial> {
  const dir = join(parent, 'tls');
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o755);
  const certificate = join(dir, 'server.pem');
  const key = join(dir, 'server.key');
  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    certificate,
    '-days',
    '2',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ]);
  const caPath = join(dir, 'ca.pem');
  copyFileSync(certificate, caPath);
  for (const file of [certificate, key, caPath]) chmodSync(file, 0o644);
  return { dir, caPath };
}

/** The lab's OAuth signing key pair. The private key mints tokens for tests. */
export interface OAuthMaterial {
  /** Folder with lab-key.pem, the public key (copied to /etc/rabbitmq/oauth). */
  readonly dir: string;
  readonly keyId: string;
  readonly resourceServerId: string;
  readonly privateKey: KeyObject;
}

export const OAUTH_KEY_ID = 'lab-key';
export const OAUTH_RESOURCE_SERVER = 'rabbitmq';

export function generateOAuthMaterial(parent: string): OAuthMaterial {
  const dir = join(parent, 'oauth');
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o755);
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const publicPath = join(dir, `${OAUTH_KEY_ID}.pem`);
  writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }));
  chmodSync(publicPath, 0o644);
  return {
    dir,
    keyId: OAUTH_KEY_ID,
    resourceServerId: OAUTH_RESOURCE_SERVER,
    privateKey,
  };
}

const base64Url = (data: Buffer | string): string =>
  Buffer.from(data).toString('base64url');

/**
 * Mints an RS256 token the OAuth variant accepts. `scope` entries are RabbitMQ scopes such as
 * `rabbitmq.tag:administrator`.
 */
export function signLabToken(
  oauth: Pick<OAuthMaterial, 'privateKey' | 'keyId' | 'resourceServerId'>,
  claims: { readonly subject: string; readonly scope: readonly string[] },
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: oauth.keyId };
  const payload = {
    sub: claims.subject,
    aud: [oauth.resourceServerId],
    scope: claims.scope,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const body = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = createSign('RSA-SHA256')
    .update(body)
    .sign(oauth.privateKey);
  return `${body}.${base64Url(signature)}`;
}
