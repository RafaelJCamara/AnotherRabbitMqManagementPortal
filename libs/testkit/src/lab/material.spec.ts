import { execFileSync } from 'node:child_process';
import { createPublicKey, createVerify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  generateOAuthMaterial,
  generateTlsMaterial,
  signLabToken,
} from './material.ts';

const scratch: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-lab-spec-'));
  scratch.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const hasOpenssl = ((): boolean => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('OAuth material', () => {
  it('writes a public key and mints tokens that verify with it and carry the audience and scope', () => {
    const parent = tmp();
    const oauth = generateOAuthMaterial(parent);
    const publicPem = readFileSync(join(oauth.dir, 'lab-key.pem'), 'utf8');
    expect(publicPem).toContain('BEGIN PUBLIC KEY');
    expect(publicPem).not.toContain('PRIVATE');

    const token = signLabToken(
      oauth,
      { subject: 'alice', scope: ['rabbitmq.tag:administrator'] },
      1_700_000_000,
    );
    const [header, payload, signature] = token.split('.');
    expect(
      JSON.parse(Buffer.from(header ?? '', 'base64url').toString()),
    ).toEqual({
      alg: 'RS256',
      typ: 'JWT',
      kid: 'lab-key',
    });
    expect(
      JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()),
    ).toEqual({
      sub: 'alice',
      aud: ['rabbitmq'],
      scope: ['rabbitmq.tag:administrator'],
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    const verifier = createVerify('RSA-SHA256').update(
      `${header ?? ''}.${payload ?? ''}`,
    );
    expect(
      verifier.verify(
        createPublicKey(publicPem),
        Buffer.from(signature ?? '', 'base64url'),
      ),
    ).toBe(true);
  });

  it('does not verify a token signed with another key', () => {
    const first = generateOAuthMaterial(tmp());
    const second = generateOAuthMaterial(tmp());
    const token = signLabToken(second, { subject: 'x', scope: [] });
    const [header, payload, signature] = token.split('.');
    const verifier = createVerify('RSA-SHA256').update(
      `${header ?? ''}.${payload ?? ''}`,
    );
    expect(
      verifier.verify(
        createPublicKey(readFileSync(join(first.dir, 'lab-key.pem'), 'utf8')),
        Buffer.from(signature ?? '', 'base64url'),
      ),
    ).toBe(false);
  });
});

describe('TLS material', () => {
  it.skipIf(!hasOpenssl)(
    'creates a certificate for localhost and 127.0.0.1 that is its own CA',
    async () => {
      const material = await generateTlsMaterial(tmp());
      const certificate = readFileSync(
        join(material.dir, 'server.pem'),
        'utf8',
      );
      expect(certificate).toContain('BEGIN CERTIFICATE');
      expect(readFileSync(material.caPath, 'utf8')).toBe(certificate);
      expect(readFileSync(join(material.dir, 'server.key'), 'utf8')).toContain(
        'PRIVATE KEY',
      );
      const text = execFileSync(
        'openssl',
        ['x509', '-in', join(material.dir, 'server.pem'), '-noout', '-text'],
        { encoding: 'utf8' },
      );
      expect(text).toContain('DNS:localhost');
      expect(text).toContain('IP Address:127.0.0.1');
    },
  );
});
