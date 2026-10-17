import { describe, expect, it } from 'vitest';

import {
  buildImageArgs,
  composeArgs,
  composeEnv,
  createContainerArgs,
  streamAdvertisedConf,
} from './args.ts';
import { parseHostPort } from './docker.ts';

const spec = {
  name: 'broker-lab-4.3.6-ab12',
  image: 'broker-lab/rabbitmq:4.3.6',
  runId: 'ab12',
  streamPort: 41552,
} as const;

const published = (args: string[]): string[] =>
  args.filter((_, index) => args[index - 1] === '--publish');

describe('docker arguments', () => {
  it('builds with the version and the digest of versions.json', () => {
    expect(
      buildImageArgs(
        { version: '4.3.6', digest: 'sha256:abc', support: '' },
        '/lab/',
      ),
    ).toEqual([
      'build',
      '--file',
      '/lab/Dockerfile',
      '--build-arg',
      'VERSION=4.3.6',
      '--build-arg',
      'DIGEST=sha256:abc',
      '--tag',
      'broker-lab/rabbitmq:4.3.6',
      '/lab/',
    ]);
  });

  it('publishes AMQP, management and Prometheus on random loopback ports and the stream port on a fixed one', () => {
    const args = createContainerArgs({ ...spec, variant: 'plain' });
    expect(published(args)).toEqual([
      '127.0.0.1::5672',
      '127.0.0.1::15672',
      '127.0.0.1::15692',
      '127.0.0.1:41552:5552',
    ]);
    expect(args.at(-1)).toBe(spec.image);
    expect(args).toContain('io.broker-lab.run=ab12');
  });

  it('adds the TLS ports for the TLS variant only', () => {
    const tls = published(createContainerArgs({ ...spec, variant: 'tls' }));
    expect(tls).toEqual(
      expect.arrayContaining([
        '127.0.0.1::5671',
        '127.0.0.1::15671',
        '127.0.0.1::5551',
      ]),
    );
    expect(
      published(createContainerArgs({ ...spec, variant: 'oauth' })),
    ).toHaveLength(4);
  });

  it('advertises the stream address the host reaches', () => {
    expect(streamAdvertisedConf(41552)).toBe(
      'stream.advertised_host = 127.0.0.1\nstream.advertised_port = 41552\n',
    );
  });

  it('passes the compose project, file and variables', () => {
    expect(composeArgs('p', 'f.yaml', 'up')).toEqual([
      'compose',
      '--project-name',
      'p',
      '--file',
      'f.yaml',
      'up',
    ]);
    expect(composeEnv('img', [1, 2, 3])).toEqual({
      BROKER_IMAGE: 'img',
      STREAM_PORT_1: '1',
      STREAM_PORT_2: '2',
      STREAM_PORT_3: '3',
    });
  });

  it('reads the host port from `docker port` output', () => {
    expect(parseHostPort('127.0.0.1:49153\n')).toBe(49153);
    expect(parseHostPort('0.0.0.0:32768\n[::]:32768\n')).toBe(32768);
    expect(() => parseHostPort('\n')).toThrow(/cannot read a host port/);
  });
});
