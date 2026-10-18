import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { startBroker } from './broker-lab.ts';
import type { Docker } from './lab/docker.ts';
import { startFakeBroker, type FakeBroker } from './lab/fake-broker.ts';
import { verifyBroker } from './lab/verify.ts';
import { LAB_DIR, findBroker } from './lab/versions.ts';

let fake: FakeBroker | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const portOf = (url: string): number => Number(new URL(url).port);

/**
 * A docker CLI that records its calls and answers `port` / `compose port` with the ports of the
 * fake broker, as the daemon would answer with the random host ports.
 */
function fakeDocker(broker: FakeBroker): {
  docker: Docker;
  calls: { args: readonly string[]; env: Record<string, string> | undefined }[];
  copied: Map<string, string>;
} {
  const copied = new Map<string, string>();
  const calls: {
    args: readonly string[];
    env: Record<string, string> | undefined;
  }[] = [];
  const mapped = new Map<number, number>([
    [5672, portOf(broker.handle.amqp)],
    [15672, broker.httpPort],
    [15692, portOf(broker.handle.prometheus)],
  ]);
  const docker: Docker = (args, options) => {
    calls.push({ args, env: options?.env ? { ...options.env } : undefined });
    if (args[0] === 'cp' && args[1]?.endsWith('.conf')) {
      // the file lives in a temporary folder that stop() removes, so read it now
      copied.set(
        (args[2] ?? '').slice((args[2] ?? '').indexOf(':') + 1),
        readFileSync(args[1], 'utf8'),
      );
    }
    const portIndex = args.indexOf('port');
    if (portIndex >= 0) {
      const container = Number.parseInt(args[portIndex + 2] ?? '', 10);
      return Promise.resolve(
        `127.0.0.1:${String(mapped.get(container) ?? 40000 + container)}\n`,
      );
    }
    if (args[0] === 'inspect') return Promise.resolve('true\n');
    if (args[0] === 'logs' || args.includes('logs')) {
      return Promise.resolve('boot log line\n');
    }
    return Promise.resolve('');
  };
  return { docker, calls, copied };
}

const verbs = (calls: { args: readonly string[] }[]): string[] =>
  calls.map((call) =>
    call.args.slice(0, call.args[0] === 'compose' ? 6 : 1).join(' '),
  );

describe('startBroker', () => {
  it('AC-1 returns the addresses, the pinned digest and the credentials of one plain broker', async () => {
    fake = await startFakeBroker({ version: '4.3.6' });
    const { docker, calls } = fakeDocker(fake);
    const broker = await startBroker(
      { version: '4.3.6' },
      { docker, pollMs: 5 },
    );

    const pinned = findBroker('4.3.6');
    expect(broker).toMatchObject({
      version: '4.3.6',
      variant: 'plain',
      nodes: 1,
      digest: pinned.digest,
      credentials: { username: 'guest', password: 'guest' },
    });
    expect(broker.amqp).toMatch(/^amqp:\/\/127\.0\.0\.1:\d+$/);
    expect(broker.http).toBe(`http://127.0.0.1:${String(fake.httpPort)}`);
    expect(broker.prometheus).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/metrics$/);
    expect(broker.stream).toMatch(/^rabbitmq-stream:\/\/127\.0\.0\.1:\d+$/);
    expect(broker.amqps).toBeUndefined();
    expect(broker.tls).toBeUndefined();
    // the container to `docker exec rabbitmqctl` in, the one that `create` made
    const created = calls.find((call) => call.args[0] === 'create')?.args ?? [];
    expect(broker.container).toBeDefined();
    expect(created).toContain(broker.container);
    expect(verbs(calls)).toEqual(
      expect.arrayContaining(['build', 'create', 'start']),
    );
    // the handle works with the verify checks (the fake serves the stream port)
    const checks = await verifyBroker({
      ...broker,
      stream: fake.handle.stream,
    });
    expect(checks.filter((check) => !check.ok)).toEqual([]);
    await broker.stop();
    expect(calls.at(-1)?.args.slice(0, 2)).toEqual(['rm', '--force']);
  });

  it('builds the image from the digest in versions.json before it creates the container', async () => {
    fake = await startFakeBroker({ version: '4.2.9' });
    const { docker, calls } = fakeDocker(fake);
    const broker = await startBroker(
      { version: '4.2.9' },
      { docker, pollMs: 5 },
    );
    await broker.stop();

    const build = calls[0]?.args ?? [];
    const digest = findBroker('4.2.9').digest;
    expect(build[0]).toBe('build');
    expect(build).toContain('VERSION=4.2.9');
    expect(build).toContain(`DIGEST=${digest}`);
    expect(build).toContain('broker-lab/rabbitmq:4.2.9');
    expect(build.at(-1)).toBe(LAB_DIR);
  });

  it('does not build when build is false', async () => {
    fake = await startFakeBroker({ version: '4.3.6' });
    const { docker, calls } = fakeDocker(fake);
    const broker = await startBroker(
      { version: '4.3.6', build: false },
      { docker, pollMs: 5 },
    );
    await broker.stop();
    expect(verbs(calls)).not.toContain('build');
  });

  it('publishes on loopback only and advertises the stream port it publishes', async () => {
    fake = await startFakeBroker({ version: '4.3.6' });
    const { docker, calls, copied } = fakeDocker(fake);
    const broker = await startBroker(
      { version: '4.3.6' },
      { docker, pollMs: 5 },
    );
    await broker.stop();

    const create = calls.find((call) => call.args[0] === 'create')?.args ?? [];
    const published = create.filter(
      (_, index) => create[index - 1] === '--publish',
    );
    expect(published.length).toBeGreaterThanOrEqual(4);
    expect(published.every((spec) => spec.startsWith('127.0.0.1:'))).toBe(true);
    const streamPort = portOf(broker.stream);
    expect(published).toContain(`127.0.0.1:${String(streamPort)}:5552`);
    // the broker is told to advertise exactly the host port the stream port is published on
    expect(copied.get('/etc/rabbitmq/conf.d/30-stream.conf')).toBe(
      `stream.advertised_host = 127.0.0.1\nstream.advertised_port = ${String(streamPort)}\n`,
    );
  });

  it('removes the container and rejects with the broker log when it never becomes ready', async () => {
    fake = await startFakeBroker({ version: '4.3.6' });
    const { docker, calls } = fakeDocker(fake);
    await expect(
      startBroker(
        { version: '4.3.6', readyTimeoutMs: 50 },
        {
          docker: (args, options) =>
            // answer the management port with a closed one so the API never answers
            args.includes('port') && args.at(-1) === '15672/tcp'
              ? Promise.resolve('127.0.0.1:1\n')
              : docker(args, options),
          pollMs: 10,
        },
      ),
    ).rejects.toThrow(/not ready after 50 ms[\s\S]*boot log line/);
    expect(calls.some((call) => call.args[0] === 'rm')).toBe(true);
  });

  it('fails at once with the log when the container stops while the broker boots', async () => {
    fake = await startFakeBroker({ version: '4.3.6' });
    const { docker, calls } = fakeDocker(fake);
    await expect(
      startBroker(
        { version: '4.3.6', readyTimeoutMs: 60_000 },
        {
          docker: (args, options) =>
            args.includes('port') && args.at(-1) === '15672/tcp'
              ? Promise.resolve('127.0.0.1:1\n')
              : args[0] === 'inspect'
                ? Promise.resolve('false\n')
                : docker(args, options),
          pollMs: 10,
        },
      ),
    ).rejects.toThrow(/stopped before[\s\S]*boot log line/);
    expect(calls.some((call) => call.args[0] === 'rm')).toBe(true);
  });

  it('rejects an unknown version and lists the known ones', async () => {
    await expect(
      startBroker({ version: '9.9.9' }, { docker: () => Promise.resolve('') }),
    ).rejects.toThrow(
      /Known versions: 3\.13\.7, 4\.0\.9, 4\.1\.8, 4\.2\.9, 4\.3\.6/,
    );
  });

  it('refuses TLS or OAuth on the 3-node lab', async () => {
    await expect(
      startBroker(
        { version: '4.3.6', nodes: 3, variant: 'tls' },
        { docker: () => Promise.resolve('') },
      ),
    ).rejects.toThrow(/plain only/);
  });

  it('starts the OAuth variant with the lab key and a config fragment', async () => {
    fake = await startFakeBroker({ version: '4.3.6' });
    const { docker, calls } = fakeDocker(fake);
    const broker = await startBroker(
      { version: '4.3.6', variant: 'oauth' },
      { docker, pollMs: 5 },
    );
    await broker.stop();
    expect(broker.oauth).toMatchObject({
      keyId: 'lab-key',
      resourceServerId: 'rabbitmq',
    });
    const copies = calls
      .filter((call) => call.args[0] === 'cp')
      .map((call) => call.args[2]);
    expect(copies).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/:\/etc\/rabbitmq\/oauth$/),
        expect.stringMatching(/:\/etc\/rabbitmq\/conf\.d\/30-oauth\.conf$/),
      ]),
    );
  });

  it('starts the 3-node lab through compose with the image, free stream ports and Toxiproxy', async () => {
    fake = await startFakeBroker({ version: '4.3.6' });
    const { docker, calls } = fakeDocker(fake);
    const broker = await startBroker(
      { version: '4.3.6', nodes: 3 },
      { docker, pollMs: 5 },
    );
    expect(broker.nodes).toBe(3);
    expect(broker.toxiproxy?.api).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const up = calls.find((call) => call.args.includes('up'));
    expect(up?.args).toEqual(
      expect.arrayContaining(['compose', '--detach', '--wait']),
    );
    expect(up?.args.some((arg) => arg.endsWith('compose.3node.yaml'))).toBe(
      true,
    );
    const env = up?.env ?? {};
    expect(env.BROKER_IMAGE).toBe('broker-lab/rabbitmq:4.3.6');
    for (const key of ['STREAM_PORT_1', 'STREAM_PORT_2', 'STREAM_PORT_3']) {
      expect(env[key]).toMatch(/^[0-9]+$/);
    }
    expect(
      new Set([env.STREAM_PORT_1, env.STREAM_PORT_2, env.STREAM_PORT_3]).size,
    ).toBe(3);
    expect(portOf(broker.stream)).toBe(Number(env.STREAM_PORT_1));

    await broker.stop();
    const down = calls.at(-1)?.args ?? [];
    expect(down).toEqual(
      expect.arrayContaining(['down', '--volumes', '--remove-orphans']),
    );
  });
});
