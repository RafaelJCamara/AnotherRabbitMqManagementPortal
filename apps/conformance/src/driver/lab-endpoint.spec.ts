import { describe, expect, it } from 'vitest';

import {
  CONTAINER,
  DIGEST,
  VERSION,
  brokerData,
  containerShape,
  fakeDocker,
  mintEndpoint,
  pinned,
} from '../testing/lab.ts';
import {
  ForeignEndpointError,
  assertLabEndpoint,
  loadPinnedDigests,
  parseLabBrokerData,
  verifyLabEndpoint,
  type LabBrokerData,
} from './lab-endpoint.ts';

const refusal = async (
  data: LabBrokerData,
  shape = containerShape(() => undefined, data),
): Promise<string> => {
  try {
    await verifyLabEndpoint(data, {
      docker: fakeDocker(shape),
      pinnedDigests: pinned,
    });
  } catch (error) {
    expect(error).toBeInstanceOf(ForeignEndpointError);
    return (error as Error).message;
  }
  return 'NOT REFUSED';
};

describe('AC-2 the driver refuses any endpoint that broker-lab did not create', () => {
  it('mints an endpoint for the lab broker that Docker describes, with the pinned digest', async () => {
    const endpoint = await mintEndpoint();

    expect(endpoint).toMatchObject({
      version: VERSION,
      digest: DIGEST,
      host: '127.0.0.1',
      amqpPort: 49100,
      httpPort: 49101,
    });
    expect(() => {
      assertLabEndpoint(endpoint);
    }).not.toThrow();
    expect(Object.isFrozen(endpoint)).toBe(true);
  });

  it.each([
    [
      'an object literal that looks like an endpoint',
      {
        version: VERSION,
        digest: DIGEST,
        host: '127.0.0.1',
        amqpPort: 5672,
        httpPort: 15672,
        credentials: { username: 'guest', password: 'guest' },
      },
    ],
    ['null', null],
    ['a string', 'amqp://127.0.0.1:5672'],
    ['undefined', undefined],
  ])('refuses %s', (_name, forged) => {
    expect(() => {
      assertLabEndpoint(forged);
    }).toThrow(ForeignEndpointError);
  });

  it('refuses a copy of a real endpoint, even with the same fields, and a copy aimed at a production port', async () => {
    const real = await mintEndpoint();

    expect(() => {
      assertLabEndpoint({ ...real });
    }).toThrow(ForeignEndpointError);
    expect(() => {
      assertLabEndpoint({ ...real, amqpPort: 5672 });
    }).toThrow(ForeignEndpointError);
    expect(() => {
      assertLabEndpoint(Object.create(real) as unknown);
    }).toThrow(ForeignEndpointError);
    expect(() => {
      assertLabEndpoint(structuredClone(real));
    }).toThrow(ForeignEndpointError);
  });

  it.each([
    ['a remote host', { amqp: 'amqp://broker.example.com:5672' }],
    ['a private network address', { amqp: 'amqp://10.0.0.5:5672' }],
    [
      'localhost (a name, not the loopback address)',
      { amqp: 'amqp://localhost:49100' },
    ],
    ['the IPv6 loopback', { amqp: 'amqp://[::1]:49100' }],
    ['a wildcard address', { http: 'http://0.0.0.0:49101' }],
    ['a login in the URL', { amqp: 'amqp://admin:secret@127.0.0.1:49100' }],
    ['a user name only in the URL', { http: 'http://admin@127.0.0.1:49101' }],
    ['the wrong scheme for AMQP', { amqp: 'amqps://127.0.0.1:49100' }],
    ['the wrong scheme for HTTP', { http: 'https://127.0.0.1:49101' }],
    ['a URL without a port', { amqp: 'amqp://127.0.0.1' }],
    ['something that is not a URL', { http: 'not a url' }],
  ])('refuses %s', async (_name, change) => {
    expect(await refusal(brokerData(change))).toMatch(/must be|not a URL/);
  });

  it.each([
    [
      'a version that is not pinned',
      brokerData({ version: '9.9.9', container: 'broker-lab-9.9.9-0a1b2c3d' }),
      /not a pinned lab version/,
    ],
    [
      'a digest that is not the pin',
      brokerData({ digest: `sha256:${'0'.repeat(64)}` }),
      /not a pinned lab version/,
    ],
  ])('refuses %s', async (_name, data, reason) => {
    expect(await refusal(data)).toMatch(reason);
  });

  it.each([
    [
      'a container not named like a lab container',
      brokerData({ container: 'prod-rabbit' }),
      /not named like a broker-lab/,
    ],
    [
      'a lab container of another version',
      brokerData({ container: 'broker-lab-4.2.9-0a1b2c3d' }),
      /not named like a broker-lab 4.3.6/,
    ],
  ])('refuses %s', async (_name, data, reason) => {
    expect(await refusal(data)).toMatch(reason);
  });

  it.each([
    [
      'a container that is not running',
      (shape: ReturnType<typeof containerShape>) => {
        shape.State.Running = false;
      },
      /not running/,
    ],
    [
      'another container name',
      (shape: ReturnType<typeof containerShape>) => {
        shape.Name = '/something-else';
      },
      /name differs/,
    ],
    [
      'an image that is not the lab image',
      (shape: ReturnType<typeof containerShape>) => {
        shape.Config.Image = 'rabbitmq:4.3.6-management';
      },
      /not the lab image/,
    ],
    [
      'the image of another lab version',
      (shape: ReturnType<typeof containerShape>) => {
        shape.Config.Image = 'broker-lab/rabbitmq:4.2.9';
      },
      /not the lab image/,
    ],
    [
      'no labels',
      (shape: ReturnType<typeof containerShape>) => {
        shape.Config.Labels = null;
      },
      /labels/,
    ],
    [
      'no run label',
      (shape: ReturnType<typeof containerShape>) => {
        delete shape.Config.Labels?.['io.broker-lab.run'];
      },
      /labels/,
    ],
    [
      'a run label that is not the run of the container name',
      (shape: ReturnType<typeof containerShape>) => {
        shape.Config.Labels = {
          ...shape.Config.Labels,
          'io.broker-lab.run': 'ffffffff',
        };
      },
      /labels/,
    ],
    [
      'a version label that differs',
      (shape: ReturnType<typeof containerShape>) => {
        shape.Config.Labels = {
          ...shape.Config.Labels,
          'io.broker-lab.rabbitmq-version': '4.2.9',
        };
      },
      /labels/,
    ],
    [
      'an AMQP port that is not the one published',
      (shape: ReturnType<typeof containerShape>) => {
        shape.NetworkSettings.Ports['5672/tcp'] = [
          { HostIp: '127.0.0.1', HostPort: '5672' },
        ];
      },
      /AMQP port/,
    ],
    [
      'an AMQP port published on every interface',
      (shape: ReturnType<typeof containerShape>) => {
        shape.NetworkSettings.Ports['5672/tcp'] = [
          { HostIp: '0.0.0.0', HostPort: '49100' },
        ];
      },
      /AMQP port/,
    ],
    [
      'no published AMQP port',
      (shape: ReturnType<typeof containerShape>) => {
        shape.NetworkSettings.Ports['5672/tcp'] = null;
      },
      /AMQP port/,
    ],
    [
      'a management port that is not the one published',
      (shape: ReturnType<typeof containerShape>) => {
        shape.NetworkSettings.Ports['15672/tcp'] = [
          { HostIp: '127.0.0.1', HostPort: '15672' },
        ];
      },
      /management port/,
    ],
    [
      'a management port published on every interface',
      (shape: ReturnType<typeof containerShape>) => {
        shape.NetworkSettings.Ports['15672/tcp'] = [
          { HostIp: '', HostPort: '49101' },
        ];
      },
      /management port/,
    ],
  ])('refuses %s', async (_name, change, reason) => {
    expect(await refusal(brokerData(), containerShape(change))).toMatch(reason);
  });

  it('refuses when Docker cannot be asked, or answers nonsense, or lists no container', async () => {
    const data = brokerData();
    const ask = (docker: Parameters<typeof verifyLabEndpoint>[1]) =>
      verifyLabEndpoint(data, { ...docker, pinnedDigests: pinned });

    await expect(ask({ docker: fakeDocker(null) })).rejects.toThrow(
      /cannot inspect/,
    );
    await expect(
      ask({ docker: () => Promise.resolve('not json') }),
    ).rejects.toThrow(/cannot inspect/);
    await expect(
      ask({ docker: () => Promise.resolve('{"Name":"x"}') }),
    ).rejects.toThrow(/cannot inspect/);
    await expect(ask({ docker: () => Promise.resolve('[]') })).rejects.toThrow(
      /name differs/,
    );
  });

  it('asks Docker about the container it was told about, with an inspect of containers only', async () => {
    const asked: (readonly string[])[] = [];
    await verifyLabEndpoint(brokerData(), {
      docker: (args) => {
        asked.push(args);
        return fakeDocker()(args);
      },
      pinnedDigests: pinned,
    });

    expect(asked).toEqual([['inspect', '--type', 'container', CONTAINER]]);
  });

  it('the pinned digests are those of testing/broker-lab/versions.json', () => {
    const digests = loadPinnedDigests();

    expect(digests.get('4.3.6')).toBe(DIGEST);
    expect([...digests.keys()]).toEqual([
      '3.13.7',
      '4.0.9',
      '4.1.8',
      '4.2.9',
      '4.3.6',
    ]);
  });
});

describe('LAB_BROKER', () => {
  it('parses what the launcher hands over', () => {
    expect(parseLabBrokerData(JSON.stringify(brokerData()))).toEqual(
      brokerData(),
    );
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['not JSON', '{'],
    ['an array', '[]'],
    [
      'missing a field',
      JSON.stringify({ ...brokerData(), container: undefined }),
    ],
    ['carrying an extra field', JSON.stringify({ ...brokerData(), extra: 1 })],
    [
      'with a version that is not exact',
      JSON.stringify({ ...brokerData(), version: '4.3' }),
    ],
    [
      'with a digest that is not a sha256',
      JSON.stringify({ ...brokerData(), digest: 'latest' }),
    ],
  ])('refuses it when it is %s', (_name, text) => {
    expect(() => parseLabBrokerData(text)).toThrow(ForeignEndpointError);
  });
});
