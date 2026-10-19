// Recording against stand-ins for the broker, in temporary folders. The real broker is exercised
// by the integration run (libs/testkit/src/it/conformance.it.ts); the real `testing/lab-evidence`
// is never touched: the "canonical root" below is a temporary folder.
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { ChannelModel } from 'amqplib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ForeignEndpointError,
  type LabEndpoint,
} from '../driver/lab-endpoint.ts';
import {
  declareQueue,
  defineScenario,
  get,
  observe,
  publish,
  settle,
} from '../dsl.ts';
import { cfSmoke01 } from '../scenarios/cf-smoke-01.ts';
import {
  DIGEST,
  MemoryHost,
  brokerData,
  localProvenance,
  mintEndpoint,
} from '../testing/lab.ts';
import { EvidenceError, verifyEvidenceText } from './evidence.ts';
import { openLabHost, recordCells, type RecordOptions } from './record.ts';

let scratch: string;
let canonical: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'evidence-record-'));
  canonical = join(scratch, 'testing', 'lab-evidence');
  mkdirSync(canonical, { recursive: true });
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const ciProvenance = {
  kind: 'ci',
  recorder: 'conformance:record',
  gitSha: 'c'.repeat(40),
  runUrl: 'https://github.com/example/repo/actions/runs/7',
  workflow:
    'example/repo/.github/workflows/conformance-record.yml@refs/heads/main',
  recordedAt: '2026-10-19T12:00:00.000Z',
} as const;

const options = async (
  host: MemoryHost,
  change: Partial<RecordOptions> = {},
): Promise<RecordOptions> => ({
  scenarios: [cfSmoke01],
  endpoint: await mintEndpoint(),
  provenance: localProvenance,
  root: join(scratch, 'out'),
  canonicalRoot: canonical,
  runId: 'abcd1234',
  openHost: () => Promise.resolve(host),
  ...change,
});

const codeOf = async (
  action: () => Promise<unknown>,
): Promise<string | undefined> => {
  try {
    await action();
  } catch (error) {
    return error instanceof EvidenceError ? error.code : 'other';
  }
  return undefined;
};

describe('AC-1 conformance:record writes <root>/<version>/CF-SMOKE-01.json showing redelivered=true at position 0', () => {
  it('records CF-SMOKE-01 on 4.3.6: the nacked message comes back first, redelivered', async () => {
    const host = new MemoryHost();

    const [file] = await recordCells(await options(host));

    expect(file).toBe(join(scratch, 'out', '4.3.6', 'CF-SMOKE-01.json'));
    const artefact = verifyEvidenceText(
      '4.3.6/CF-SMOKE-01.json',
      readFileSync(file ?? '', 'utf8'),
    );
    expect(artefact).toMatchObject({
      cfId: 'CF-SMOKE-01',
      brokerVersion: '4.3.6',
      imageDigest: DIGEST,
      provenance: { kind: 'local' },
    });
    // The evidence says which settle ran: a nack with requeue, not a reject.
    expect(artefact.steps.find((step) => step.op === 'settle')).toMatchObject({
      args: { action: 'nack', requeue: true, target: 'first' },
    });
    const first = artefact.observations.find((item) => item.messageId === 'm1');
    expect(first).toMatchObject({
      survived: true,
      position: 0,
      redelivered: true,
    });
    expect(
      artefact.observations.find((item) => item.messageId === 'm2'),
    ).toMatchObject({
      position: 1,
      redelivered: false,
    });
  });

  it('a ci run writes into the evidence tree, stamped with its commit and run', async () => {
    const [file] = await recordCells(
      await options(new MemoryHost(), {
        provenance: ciProvenance,
        root: canonical,
      }),
    );

    const artefact = verifyEvidenceText(
      '4.3.6/CF-SMOKE-01.json',
      readFileSync(file ?? '', 'utf8'),
    );
    expect(artefact.provenance).toEqual(ciProvenance);
  });

  it('takes the version from what the broker serves and the digest from the lab pin', async () => {
    const endpoint = await mintEndpoint();
    const host = new MemoryHost('4.3.6');

    await recordCells(await options(host, { endpoint }));

    const text = readFileSync(
      join(scratch, 'out', '4.3.6', 'CF-SMOKE-01.json'),
      'utf8',
    );
    expect(JSON.parse(text)).toMatchObject({
      brokerVersion: '4.3.6',
      imageDigest: endpoint.digest,
    });
  });

  it('closes the broker connection when it is done', async () => {
    const host = new MemoryHost();

    await recordCells(await options(host));

    expect(host.closedCount).toBe(1);
  });
});

describe('A-20 and I-14 the recorder refuses to record what it cannot stand behind', () => {
  it('refuses a broker that serves another version than the lab pinned, and writes nothing', async () => {
    const host = new MemoryHost('4.2.9');

    expect(await codeOf(async () => recordCells(await options(host)))).toBe(
      'refused',
    );
    expect(existsSync(join(scratch, 'out'))).toBe(false);
    expect(host.closedCount).toBe(1);
  });

  it('refuses a broker whose version could not be read', async () => {
    expect(
      await codeOf(async () =>
        recordCells(await options(new MemoryHost(null))),
      ),
    ).toBe('refused');
  });

  it('a local run cannot write into the evidence tree, and writes nothing there', async () => {
    expect(
      await codeOf(async () =>
        recordCells(await options(new MemoryHost(), { root: canonical })),
      ),
    ).toBe('refused');
    expect(readdirSync(canonical)).toEqual([]);
  });

  it('I-10 a secret in any artefact stops the whole run before the first file is written', async () => {
    const leaky = defineScenario({
      cfId: 'CF-LEAK-01',
      title: 'leaks the lab password as a message id',
      protocol: 'amqp091',
      steps: [
        declareQueue('q'),
        publish('q', 'guest'),
        get('d', 'q'),
        settle('d', { kind: 'ack' }),
      ],
    });

    const code = await codeOf(async () =>
      recordCells(
        await options(new MemoryHost(), { scenarios: [cfSmoke01, leaky] }),
      ),
    );

    expect(code).toBe('secret');
    expect(existsSync(join(scratch, 'out'))).toBe(false);
  });

  it('a scenario that fails on the broker stops the run, writes nothing and still closes the connection', async () => {
    const host = new MemoryHost();
    host.failOn = 'publish';

    await expect(recordCells(await options(host))).rejects.toThrow(
      'nack from the broker',
    );
    expect(existsSync(join(scratch, 'out'))).toBe(false);
    expect(host.closedCount).toBe(1);
  });

  it('records several scenarios, one file each', async () => {
    const second = defineScenario({
      cfId: 'CF-SMOKE-02',
      title: 'ack removes the message',
      protocol: 'amqp091',
      steps: [
        declareQueue('q'),
        publish('q', 'm1'),
        get('d', 'q'),
        settle('d', { kind: 'ack' }),
        observe('after', 'q'),
      ],
    });

    const files = await recordCells(
      await options(new MemoryHost(), { scenarios: [cfSmoke01, second] }),
    );

    expect(files.map((file) => basename(file))).toEqual([
      'CF-SMOKE-01.json',
      'CF-SMOKE-02.json',
    ]);
  });

  it('AC-2 (M0-37) gives each scenario its own connection, closed after it, so no tag and no broken channel carries over', async () => {
    const second = defineScenario({
      cfId: 'CF-SMOKE-02',
      title: 'a second scenario',
      protocol: 'amqp091',
      steps: [
        declareQueue('q'),
        publish('q', 'm1'),
        get('d', 'q'),
        settle('d', { kind: 'ack' }),
        observe('after', 'q'),
      ],
    });
    const hosts: MemoryHost[] = [];

    const files = await recordCells(
      await options(new MemoryHost(), {
        scenarios: [cfSmoke01, second],
        openHost: () => {
          const host = new MemoryHost();
          hosts.push(host);
          return Promise.resolve(host);
        },
      }),
    );

    expect(hosts).toHaveLength(2);
    expect(hosts.map((host) => host.closedCount)).toEqual([1, 1]);
    // The second scenario's first delivery is tag 1, as if it had been recorded alone.
    const artefact = verifyEvidenceText(
      '4.3.6/CF-SMOKE-02.json',
      readFileSync(files[1] ?? '', 'utf8'),
    );
    expect(
      artefact.steps.find((step) => step.op === 'get')?.result,
    ).toMatchObject({ deliveryTag: 1 });
  });
});

describe('AC-2 the recorder reaches a broker only through an endpoint broker-lab created', () => {
  it('the real host refuses a forged endpoint before it connects', async () => {
    let connects = 0;
    const forged = { ...(await mintEndpoint()) } as LabEndpoint;

    await expect(
      openLabHost(forged, {
        connect: () => {
          connects += 1;
          return Promise.reject(new Error('unreachable'));
        },
      }),
    ).rejects.toThrow(ForeignEndpointError);
    expect(connects).toBe(0);
  });
});

describe('the version a broker serves is read from HTTP and checked against AMQP', () => {
  let server: Server;
  let overview: { status: number; body: string };
  beforeEach(async () => {
    overview = { status: 200, body: '{"rabbitmq_version":"4.3.6"}' };
    server = createServer((_request, response) => {
      response.statusCode = overview.status;
      response.end(overview.body);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const hostWith = async (amqpVersion: string | undefined) => {
    const { port } = server.address() as AddressInfo;
    const endpoint = await mintEndpoint(
      brokerData({ http: `http://127.0.0.1:${String(port)}` }),
    );
    const model = Object.assign(new EventEmitter(), {
      connection: {
        serverProperties:
          amqpVersion === undefined ? {} : { version: amqpVersion },
      },
      createChannel: () => Promise.resolve(new EventEmitter()),
      close: () => Promise.resolve(),
    });
    return openLabHost(endpoint, {
      connect: () => Promise.resolve(model as unknown as ChannelModel),
    });
  };

  it('reports the version when both answers agree, or AMQP says nothing', async () => {
    expect(await (await hostWith('4.3.6')).brokerVersion()).toBe('4.3.6');
    expect(await (await hostWith(undefined)).brokerVersion()).toBe('4.3.6');
  });

  it('reports nothing when the two answers disagree, the API fails or the body is not an overview', async () => {
    expect(await (await hostWith('4.2.9')).brokerVersion()).toBeNull();
    overview = { status: 500, body: '{"rabbitmq_version":"4.3.6"}' };
    expect(await (await hostWith('4.3.6')).brokerVersion()).toBeNull();
    overview = { status: 200, body: '{"version":"4.3.6"}' };
    expect(await (await hostWith('4.3.6')).brokerVersion()).toBeNull();
    overview = { status: 200, body: '"4.3.6"' };
    expect(await (await hostWith('4.3.6')).brokerVersion()).toBeNull();
  });
});
