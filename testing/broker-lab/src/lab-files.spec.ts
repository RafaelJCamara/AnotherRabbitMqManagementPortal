// Static checks of the lab artefacts. They run without Docker: the images themselves are proven
// by `nx run broker-lab:verify` (libs/testkit/src/lab/verify.ts).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { BROKER_LAB_DIR } from './index';

const read = (name: string): string =>
  readFileSync(join(BROKER_LAB_DIR, name), 'utf8');

const versions = (
  JSON.parse(read('versions.json')) as {
    brokers: { version: string; digest: string }[];
  }
).brokers;

interface Compose {
  services: Record<
    string,
    {
      image: string;
      ports?: string[];
      hostname?: string;
      volumes?: string[];
      depends_on?: unknown;
    }
  >;
}
const compose = parse(read('compose.3node.yaml'), { merge: true }) as Compose;

describe('Dockerfile', () => {
  const dockerfile = read('Dockerfile');
  const lines = dockerfile
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'));

  it('AC-1 builds FROM the official management image of ${VERSION}, pinned by ${DIGEST}', () => {
    expect(lines).toContain('FROM rabbitmq:${VERSION}-management@${DIGEST}');
  });

  it('defaults to the newest version in versions.json with its recorded digest', () => {
    const newest = versions.at(-1);
    expect(dockerfile).toContain(`ARG VERSION=${newest?.version ?? ''}`);
    expect(dockerfile).toContain(`ARG DIGEST=${newest?.digest ?? ''}`);
  });

  it('copies the plugin list and the configuration, and only that', () => {
    const copies = lines.filter((line) => line.startsWith('COPY'));
    expect(copies).toEqual([
      'COPY --chown=rabbitmq:rabbitmq enabled_plugins /etc/rabbitmq/enabled_plugins',
      'COPY --chown=rabbitmq:rabbitmq rabbitmq.conf /etc/rabbitmq/conf.d/20-broker-lab.conf',
    ]);
  });

  it('exposes the ports of the matrix', () => {
    const expose = lines.find((line) => line.startsWith('EXPOSE')) ?? '';
    for (const port of [5672, 5671, 15672, 15671, 5552, 5551, 15692]) {
      expect(expose.split(' ')).toContain(String(port));
    }
  });

  it('has no floating tag, ADD, root user or package installation', () => {
    expect(dockerfile).not.toMatch(/:latest\b/);
    expect(lines.some((line) => /^(ADD|USER|RUN)\b/.test(line))).toBe(false);
  });
});

describe('enabled plugins', () => {
  const plugins = read('enabled_plugins')
    .trim()
    .replace(/^\[|\]\.$/g, '')
    .split(',');

  it('AC-2 enables management, Prometheus, stream, tracing, shovel, federation, consistent-hash, event exchange and OAuth', () => {
    expect(plugins).toEqual(
      expect.arrayContaining([
        'rabbitmq_management',
        'rabbitmq_prometheus',
        'rabbitmq_stream',
        'rabbitmq_stream_management',
        'rabbitmq_tracing',
        'rabbitmq_shovel',
        'rabbitmq_shovel_management',
        'rabbitmq_federation',
        'rabbitmq_federation_management',
        'rabbitmq_consistent_hash_exchange',
        'rabbitmq_event_exchange',
        'rabbitmq_auth_backend_oauth2',
      ]),
    );
  });

  it('is one Erlang list of unique names ending in a full stop', () => {
    expect(read('enabled_plugins').trim()).toMatch(/^\[[a-z0-9_,]+\]\.$/);
    expect(new Set(plugins).size).toBe(plugins.length);
  });
});

describe('rabbitmq.conf', () => {
  const conf = read('rabbitmq.conf');
  it('AC-1 listens on 5672, 15672, 5552 and 15692', () => {
    expect(conf).toMatch(/^listeners\.tcp\.default = 5672$/m);
    expect(conf).toMatch(/^management\.tcp\.port = 15672$/m);
    expect(conf).toMatch(/^stream\.listeners\.tcp\.default = 5552$/m);
    expect(conf).toMatch(/^prometheus\.tcp\.port = 15692$/m);
  });

  it('leaves the advertised stream address to the run time', () => {
    expect(conf).not.toMatch(/^stream\.advertised/m);
  });
});

describe('variants', () => {
  it('opens the TLS ports 5671, 15671 and 5551 and ships no key material', () => {
    const tls = read('tls/rabbitmq.tls.conf');
    expect(tls).toMatch(/^listeners\.ssl\.default = 5671$/m);
    expect(tls).toMatch(/^management\.ssl\.port = 15671$/m);
    expect(tls).toMatch(/^stream\.listeners\.ssl\.default = 5551$/m);
    expect(readdirSync(join(BROKER_LAB_DIR, 'tls'))).toEqual([
      'rabbitmq.tls.conf',
    ]);
    expect(read('Dockerfile')).not.toMatch(/\.(pem|key)\b/);
  });

  it('keeps the internal backend next to oauth2 so guest still works', () => {
    const oauth = read('oauth/rabbitmq.oauth.conf');
    expect(oauth).toMatch(/^auth_backends\.1 = oauth2$/m);
    expect(oauth).toMatch(/^auth_backends\.2 = internal$/m);
    expect(oauth).toMatch(/^auth_oauth2\.resource_server_id = rabbitmq$/m);
  });
});

describe('compose.3node.yaml', () => {
  const services = compose.services;

  it('AC-1 has three broker nodes, HAProxy and Toxiproxy', () => {
    expect(Object.keys(services).sort()).toEqual([
      'haproxy',
      'rmq1',
      'rmq2',
      'rmq3',
      'toxiproxy',
    ]);
  });

  it('pins every third-party image by digest and takes the broker image from the environment', () => {
    expect(services.rmq1?.image).toContain('${BROKER_IMAGE');
    for (const name of ['haproxy', 'toxiproxy']) {
      expect(services[name]?.image).toMatch(
        /^[^@]+:\d[^@]*@sha256:[0-9a-f]{64}$/,
      );
    }
  });

  it('publishes only on the loopback interface', () => {
    for (const service of Object.values(services)) {
      for (const port of service.ports ?? []) {
        expect(port).toMatch(/^127.0.0.1:/);
      }
    }
  });

  it('gives every node its own stream port, advertised as the port it publishes', () => {
    const configs = (
      parse(read('compose.3node.yaml'), { merge: true }) as {
        configs: Record<string, { content: string }>;
      }
    ).configs;
    for (const node of [1, 2, 3]) {
      const port = `\${STREAM_PORT_${String(node)}:?}`;
      expect(services[`rmq${String(node)}`]?.ports).toEqual([
        `127.0.0.1:${port}:5552`,
      ]);
      expect(configs[`stream-${String(node)}`]?.content).toBe(
        `stream.advertised_host = 127.0.0.1\nstream.advertised_port = ${port}\n`,
      );
    }
  });

  it('names the nodes the way the cluster configuration and HAProxy do', () => {
    const cluster = read('rabbitmq.cluster.conf');
    const haproxy = read('haproxy.cfg');
    for (const node of ['rmq1', 'rmq2', 'rmq3']) {
      expect(services[node]?.hostname).toBe(node);
      expect(cluster).toContain(`rabbit@${node}`);
      expect(haproxy).toContain(`server ${node} ${node}:5672 check`);
      expect(haproxy).toContain(`server ${node} ${node}:15672 check`);
      expect(haproxy).toContain(`server ${node} ${node}:15692 check`);
    }
  });

  it('mounts files that exist', () => {
    for (const service of Object.values(services)) {
      for (const volume of service.volumes ?? []) {
        const source = volume.split(':')[0] ?? '';
        expect(existsSync(join(BROKER_LAB_DIR, source))).toBe(true);
      }
    }
  });

  it('points Toxiproxy at HAProxy', () => {
    const proxies = JSON.parse(read('toxiproxy.json')) as {
      name: string;
      listen: string;
      upstream: string;
    }[];
    expect(proxies.map((proxy) => proxy.upstream)).toEqual([
      'haproxy:5672',
      'haproxy:15672',
    ]);
    const published = services.toxiproxy?.ports ?? [];
    for (const proxy of proxies) {
      expect(published).toContain(
        `127.0.0.1::${proxy.listen.split(':')[1] ?? ''}`,
      );
    }
  });
});
