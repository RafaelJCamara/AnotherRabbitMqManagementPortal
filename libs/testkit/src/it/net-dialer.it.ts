// Integration test of the Dialer and the TrustStore against the broker-lab TLS variant (M0-26).
// Run with `pnpm nx run net-dialer:it --versions=4.3.6`; it needs a Docker daemon.
//
// The lab broker's certificate is generated for every run and is its own CA (CN=localhost,
// SAN DNS:localhost and IP:127.0.0.1), so "a private CA imported into a profile" is that
// certificate, and "connecting by IP with a servername override" is 127.0.0.1 with `localhost`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDialer, createUndiciConnector } from '@app/net-dialer';
import {
  NetworkError,
  createTrustStore,
  toProfileTls,
} from '@app/net-truststore';

import { startBroker } from '../broker-lab.ts';
import { readAll } from './read-all.ts';
import type { BrokerHandle } from '../lab/types.ts';

const DIRECT = { kind: 'direct' } as const;
const versions = (process.env.IT_BROKER_VERSIONS ?? '4.3.6')
  .split(',')
  .filter((version) => version !== '');
// The public-endpoint check needs the internet; CI sets IT_OFFLINE=1 only on an air-gapped runner.
const offline = process.env.IT_OFFLINE === '1';
const publicHost = process.env.IT_PUBLIC_HTTPS_HOST ?? 'example.com';

const portOf = (address: string | undefined): number => {
  if (address === undefined) throw new Error('the broker has no TLS listener');
  return Number(new URL(address).port);
};

describe.each(versions)(
  'net-dialer against RabbitMQ %s (TLS variant)',
  (version) => {
    let broker: BrokerHandle;
    let ca: string;

    beforeAll(async () => {
      broker = await startBroker({ version, variant: 'tls' });
      if (broker.tls === undefined)
        throw new Error('the lab did not return a CA');
      ca = broker.tls.ca;
    });
    afterAll(async () => {
      await broker.stop();
    });

    it('lab AC-1: a private CA imported into a profile verifies by IP with a servername override, and a public HTTPS endpoint still verifies against the system CAs', async () => {
      const store = createTrustStore();
      const trust = store.forProfile({ ca: [ca], servername: 'localhost' });
      const dialer = createDialer();

      // AMQP over TLS: the broker answers the protocol header with Connection.Start (frame type 1).
      const amqp = await dialer.dial(
        {
          host: '127.0.0.1',
          port: portOf(broker.amqps),
          purpose: 'amqp',
          tls: trust,
        },
        DIRECT,
      );
      amqp.socket.write(Buffer.from('AMQP\u0000\u0000\u0009\u0001', 'latin1'));
      const first = await new Promise<Buffer>((resolve, reject) => {
        amqp.socket.once('data', (chunk: Buffer) => {
          resolve(chunk);
        });
        amqp.socket.once('error', reject);
      });
      amqp.socket.destroy();

      // The management API over HTTPS through the undici connector.
      const connector = createUndiciConnector({
        dialer,
        purpose: 'mgmt-http',
        tls: trust,
      });
      const mgmt = await new Promise<import('node:net').Socket>(
        (resolve, reject) => {
          connector(
            {
              hostname: '127.0.0.1',
              protocol: 'https:',
              port: portOf(broker.https),
            },
            (error, socket) => {
              if (error !== null || socket === null) {
                reject(error ?? new Error('no socket'));
              } else {
                resolve(socket);
              }
            },
          );
        },
      );
      const credentials = Buffer.from(
        `${broker.credentials.username}:${broker.credentials.password}`,
      ).toString('base64');
      mgmt.write(
        `GET /api/overview HTTP/1.1\r\nhost: localhost\r\nauthorization: Basic ${credentials}\r\nconnection: close\r\n\r\n`,
      );
      const reply = await readAll(mgmt);

      expect(amqp.tls?.verified).toBe(true);
      expect(amqp.tls?.insecureOverride).toBe(false);
      expect(first[0]).toBe(1);
      expect(reply).toContain('200 OK');
      expect(reply).toContain(`"rabbitmq_version":"${version}"`);

      if (!offline) {
        // The profile's CA was added to the defaults, not substituted for them. (The override
        // above names the lab broker, so the public host is dialled with the CA and no override.)
        const publicSite = await dialer.dial(
          {
            host: publicHost,
            port: 443,
            purpose: 'https',
            tls: store.forProfile({ ca: [ca] }),
          },
          DIRECT,
        );
        publicSite.socket.destroy();
        expect(publicSite.tls?.verified).toBe(true);
      }
    });

    it('lab: the broker is refused without the CA, and under a name its certificate does not carry', async () => {
      const store = createTrustStore();
      const dialer = createDialer();
      const target = {
        host: '127.0.0.1',
        port: portOf(broker.amqps),
        purpose: 'amqp',
      };

      const untrusted = await dialer
        .connect({ ...target, tls: store.forProfile() }, DIRECT)
        .catch((error: unknown) => error);
      const wrongName = await dialer
        .connect(
          {
            ...target,
            tls: store.forProfile({
              ca: [ca],
              servername: 'elsewhere.example',
            }),
          },
          DIRECT,
        )
        .catch((error: unknown) => error);

      expect(untrusted).toBeInstanceOf(NetworkError);
      expect((untrusted as NetworkError).code).toBe('TLS_UNTRUSTED');
      expect(wrongName).toBeInstanceOf(NetworkError);
      expect((wrongName as NetworkError).tls?.nodeCode).toBe(
        'ERR_TLS_CERT_ALTNAME_INVALID',
      );
    });

    it('lab AC-2: insecure=true connects without the CA and the profile records tls.insecureOverride=true', async () => {
      const trust = createTrustStore().forProfile({ insecure: true });

      const result = await createDialer().dial(
        {
          host: '127.0.0.1',
          port: portOf(broker.amqps),
          purpose: 'amqp',
          tls: trust,
        },
        DIRECT,
      );
      result.socket.destroy();

      expect(result.tls).toBeDefined();
      if (result.tls === undefined) return;
      expect(result.tls.verified).toBe(false);
      expect(toProfileTls(result.tls).insecureOverride).toBe(true);
    });
  },
);
