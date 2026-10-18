import { connect as tcpConnect, type Socket } from 'node:net';
import {
  connect as tlsConnect,
  getCACertificates,
  setDefaultCACertificates,
} from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrokerProfileSchema } from '@app/domain-model';
import {
  createTestPki,
  startTestTlsServer,
  type TestTlsServer,
} from './testing/index.ts';

import { toProfileTls } from './diagnostics.ts';
import { NetworkError } from './errors.ts';
import { secureSocket } from './handshake.ts';
import {
  createTrustStore,
  nodeTlsRuntime,
  parseCertificates,
  validateServername,
  type TlsRuntime,
  type TlsTrust,
} from './truststore.ts';

const servers: TestTlsServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function serve(
  pki: ReturnType<typeof createTestPki>,
  options: Parameters<ReturnType<typeof createTestPki>['issueServer']>[0] = {},
  onConnection?: Parameters<typeof startTestTlsServer>[0]['onConnection'],
): Promise<TestTlsServer> {
  const { leaf, chainPem } = pki.issueServer(options);
  const server = await startTestTlsServer({
    certPem: chainPem,
    keyPem: leaf.keyPem,
    ...(onConnection === undefined ? {} : { onConnection }),
  });
  servers.push(server);
  return server;
}

function tcp(server: TestTlsServer): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect({ host: server.host, port: server.port }, () => {
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

/** Dials the server by IP, verifying `hint` (or the IP itself when absent). */
async function secure(server: TestTlsServer, trust: TlsTrust, hint?: string) {
  return secureSocket(
    await tcp(server),
    trust,
    server.host,
    hint === undefined ? {} : { hint },
  );
}

/** A runtime that serves fixed stores and records what was installed. */
function fakeRuntime(stores: {
  bundled?: string[];
  system?: string[] | Error;
}): TlsRuntime & { installed: string[][] } {
  const installed: string[][] = [];
  return {
    installed,
    getCACertificates(type) {
      const value = type === 'bundled' ? stores.bundled : stores.system;
      if (value instanceof Error) throw value;
      return value ?? [];
    },
    setDefaultCACertificates(certificates) {
      installed.push(certificates);
    },
  };
}

describe('TrustStore (DC-44)', () => {
  it('AC-1 a private CA in the profile verifies a broker reached by IP with a servername override, and a public endpoint still verifies against the system CAs', async () => {
    const publicPki = createTestPki('Public Root');
    const privatePki = createTestPki('Corporate Root');
    // The "system store" holds the public root only; the broker's CA is private.
    const store = createTrustStore({
      runtime: fakeRuntime({ system: [publicPki.root.pem] }),
    });
    const broker = await serve(privatePki, {
      dnsNames: ['broker.lab.test'],
      ipAddresses: [],
    });
    const publicSite = await serve(publicPki, {
      dnsNames: ['www.public.test'],
      ipAddresses: [],
    });

    const trust = store.forProfile({
      ca: [privatePki.root.pem],
      servername: 'broker.lab.test',
    });
    const viaIp = await secure(broker, trust);
    // A profile without an override still reaches a public name with only the defaults.
    const publicTrust = store.forProfile({ ca: [privatePki.root.pem] });
    const publicOk = await secure(publicSite, publicTrust, 'www.public.test');
    viaIp.socket.destroy();
    publicOk.socket.destroy();

    expect(viaIp.diagnostics.verified).toBe(true);
    expect(viaIp.diagnostics.verifiedName).toBe('broker.lab.test');
    expect(viaIp.diagnostics.sni).toBe('broker.lab.test');
    expect(publicOk.diagnostics.verified).toBe(true);
    expect(trust.ca).toEqual([
      ...store.defaults,
      ...parseCertificates(privatePki.root.pem, 'test'),
    ]);
  });

  it('AC-2 insecure=true connects to an untrusted server and the profile records tls.insecureOverride=true', async () => {
    const stranger = createTestPki('Unknown Root');
    const server = await serve(stranger, { dnsNames: ['other.test'] });
    const store = createTrustStore({ runtime: fakeRuntime({}) });

    const result = await secure(
      server,
      store.forProfile({ insecure: true }),
      'broker.lab.test',
    );
    result.socket.destroy();
    const recorded = toProfileTls(result.diagnostics);

    expect(result.diagnostics.verified).toBe(false);
    expect(result.diagnostics.insecureOverride).toBe(true);
    expect(recorded.insecureOverride).toBe(true);
    expect(recorded.verified).toBe(false);
    expect(() => BrokerProfileSchema.shape.tls.parse(recorded)).not.toThrow();
  });

  it('insecure stays off unless the profile says exactly true', async () => {
    const store = createTrustStore({ runtime: fakeRuntime({}) });
    const server = await serve(createTestPki());

    expect(store.forProfile({}).insecureOverride).toBe(false);
    expect(store.forProfile({ insecure: false }).insecureOverride).toBe(false);
    expect(
      store.forProfile({}).connectOptions('localhost').rejectUnauthorized,
    ).toBe(true);
    // A JSON profile that spells it "true" or 1 is a mistake, not a switch.
    for (const value of ['true', 1, 'yes']) {
      expect(() =>
        store.forProfile({ insecure: value as unknown as boolean }),
      ).toThrow(NetworkError);
    }
    await expect(
      secure(server, store.forProfile({}), 'localhost'),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('keeps verifying after the broker rotates its leaf: no leaf pinning', async () => {
    const pki = createTestPki();
    const store = createTrustStore({ runtime: fakeRuntime({}) });
    const trust = store.forProfile({ ca: [pki.root.pem] });

    const first = await secure(await serve(pki), trust, 'localhost');
    const second = await secure(await serve(pki), trust, 'localhost');
    first.socket.destroy();
    second.socket.destroy();

    expect(first.diagnostics.chain[0]?.fingerprint256).not.toBe(
      second.diagnostics.chain[0]?.fingerprint256,
    );
    expect(first.diagnostics.verified && second.diagnostics.verified).toBe(
      true,
    );
  });

  it('adds the profile CAs to the defaults and never replaces them', () => {
    const defaultsPki = createTestPki('Defaults');
    const orgPki = createTestPki('Org');
    const profilePki = createTestPki('Profile');
    const store = createTrustStore({
      org: [orgPki.root.pem],
      runtime: fakeRuntime({
        bundled: [defaultsPki.root.pem],
        system: [defaultsPki.intermediate.pem],
      }),
    });

    const trust = store.forProfile({ ca: [profilePki.root.pem] });

    expect(store.defaults.map((pem) => pem.trim())).toEqual([
      defaultsPki.root.pem.trim(),
      defaultsPki.intermediate.pem.trim(),
      orgPki.root.pem.trim(),
    ]);
    expect(trust.ca.map((pem) => pem.trim())).toEqual([
      ...store.defaults.map((pem) => pem.trim()),
      profilePki.root.pem.trim(),
    ]);
    expect(trust.profileCaCount).toBe(1);
    expect(store.sources).toEqual({ bundled: 1, system: 1, org: 1 });
  });

  it('deduplicates certificates that appear in more than one source', () => {
    const pki = createTestPki();
    const store = createTrustStore({
      org: [pki.root.pem],
      runtime: fakeRuntime({ bundled: [pki.root.pem], system: [pki.root.pem] }),
    });

    expect(store.defaults).toHaveLength(1);
    expect(
      store.forProfile({ ca: [pki.root.pem + pki.root.pem] }).ca,
    ).toHaveLength(1);
  });

  it('falls back to bundled and organisation CAs when the system store cannot be read, and says so', () => {
    const pki = createTestPki();
    const store = createTrustStore({
      org: [pki.root.pem],
      runtime: fakeRuntime({
        bundled: [pki.intermediate.pem],
        system: new Error('no keychain'),
      }),
    });

    expect(store.defaults).toHaveLength(2);
    expect(store.sources.systemError).toBe('no keychain');
    expect(store.sources.system).toBe(0);
  });

  it('does not read the system store when asked not to', () => {
    const runtime = fakeRuntime({});
    const spy = vi.spyOn(runtime, 'getCACertificates');

    createTrustStore({ includeSystem: false, runtime });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('bundled');
  });

  it('installs the defaults as the process-wide default CAs', () => {
    const pki = createTestPki();
    const runtime = fakeRuntime({ bundled: [pki.root.pem] });
    const store = createTrustStore({ runtime });

    store.install();

    expect(runtime.installed).toEqual([[...store.defaults]]);
  });

  describe('against the real Node runtime', () => {
    const original = getCACertificates('default');
    afterEach(() => {
      setDefaultCACertificates(original);
    });

    it('starts from the bundled Mozilla roots', () => {
      const store = createTrustStore({ includeSystem: false });

      expect(store.sources.bundled).toBeGreaterThan(100);
      expect(store.defaults.length).toBe(store.sources.bundled);
    });

    it('install() makes plain tls.connect trust the organisation CA, with no per-connection ca', async () => {
      const pki = createTestPki();
      const server = await serve(pki);
      const store = createTrustStore({
        includeSystem: false,
        org: [pki.root.pem],
        runtime: nodeTlsRuntime,
      });
      store.install();

      const authorized = await new Promise<boolean>((resolve, reject) => {
        const socket = tlsConnect(
          { host: server.host, port: server.port, servername: 'localhost' },
          () => {
            resolve(socket.authorized);
            socket.destroy();
          },
        );
        socket.once('error', reject);
      });

      expect(authorized).toBe(true);
    });
  });

  describe('server name', () => {
    const store = createTrustStore({ runtime: fakeRuntime({}) });

    it('sends SNI for a name and none for an IP address', () => {
      expect(store.forProfile().connectOptions('broker.test').servername).toBe(
        'broker.test',
      );
      expect(
        store.forProfile().connectOptions('10.1.2.3').servername,
      ).toBeUndefined();
      expect(
        store.forProfile().connectOptions('[::1]').servername,
      ).toBeUndefined();
    });

    it('prefers the profile override over the caller hint over the host', () => {
      const withOverride = store.forProfile({ servername: 'Override.Test.' });

      expect(withOverride.verifyName('10.1.2.3', 'hint.test')).toBe(
        'override.test',
      );
      expect(store.forProfile().verifyName('10.1.2.3', 'hint.test')).toBe(
        'hint.test',
      );
      expect(store.forProfile().verifyName('Host.Test.')).toBe('host.test');
    });

    it('sends the override as SNI when dialling an IP, and no SNI without it', async () => {
      const seen: unknown[] = [];
      const pki = createTestPki();
      const server = await serve(
        pki,
        { dnsNames: ['broker.lab.test'] },
        (socket) => {
          seen.push(socket.servername);
          socket.end();
        },
      );

      const named = await secure(
        server,
        store.forProfile({ ca: [pki.root.pem], servername: 'broker.lab.test' }),
      );
      const bare = await secure(
        server,
        store.forProfile({ ca: [pki.root.pem] }),
      );
      named.socket.destroy();
      bare.socket.destroy();

      expect(seen[0]).toBe('broker.lab.test');
      expect(seen[1]).toBeFalsy();
      expect(named.diagnostics.sni).toBe('broker.lab.test');
      expect(bare.diagnostics.sni).toBeUndefined();
    });

    it.each([
      '',
      ' ',
      'a b',
      'a/b',
      'host:443',
      'a..b',
      '-a.test',
      'x'.repeat(300),
    ])('rejects the server name %j', (value) => {
      expect(() => validateServername(value)).toThrow(NetworkError);
    });

    it.each(['broker.test', 'b-1.lab_a.test', '10.0.0.1', '::1', '[fe80::1]'])(
      'accepts the server name %s',
      (value) => {
        expect(() => validateServername(value)).not.toThrow();
      },
    );
  });

  describe('importing CAs', () => {
    const pki = createTestPki();

    it('accepts a bundle with commentary and returns each certificate', () => {
      const bundle = `# corporate roots\n${pki.root.pem}\nsome text\n${pki.intermediate.pem}`;

      expect(parseCertificates(bundle, 'bundle')).toEqual([
        pki.root.pem,
        pki.intermediate.pem,
      ]);
    });

    it('rejects a private key without echoing it', () => {
      const key = pki.root.keyPem;

      let failure: unknown;
      try {
        parseCertificates(pki.root.pem + key, 'profile CA 1');
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(NetworkError);
      const text = (failure as NetworkError).message;
      expect(text).toContain('private key');
      expect(text).not.toContain(key.split('\n')[1] ?? 'unreachable');
    });

    it.each([
      ['empty text', ''],
      ['no certificate', 'hello world'],
      [
        'corrupt certificate',
        '-----BEGIN CERTIFICATE-----\nAAAAAAAA\n-----END CERTIFICATE-----',
      ],
      ['a DER file read as text', '0\u0082\u0003\u0001'],
    ])('rejects %s', (_label, text) => {
      expect(() => parseCertificates(text, 'profile CA 1')).toThrow(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }) as Error,
      );
    });

    it('rejects an oversized entry and a bundle of too many certificates', () => {
      expect(() =>
        parseCertificates('x'.repeat(1024 * 1024 + 1), 'big'),
      ).toThrow(NetworkError);
      expect(() => parseCertificates(pki.root.pem.repeat(257), 'many')).toThrow(
        NetworkError,
      );
    });

    it('refuses a bad profile CA when the profile is built, naming it', () => {
      const store = createTrustStore({ runtime: fakeRuntime({}) });

      expect(() => store.forProfile({ ca: [pki.root.pem, 'junk'] })).toThrow(
        /profile CA 2/,
      );
      expect(() =>
        createTrustStore({ org: ['junk'], runtime: fakeRuntime({}) }),
      ).toThrow(/organisation CA 1/);
    });
  });
});
