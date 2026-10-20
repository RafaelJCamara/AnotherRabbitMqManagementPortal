// CF-SETTLE-01, -02 and -05 on the in-memory host: their shape, and that they record no secret. The
// memory host proves the plumbing only.
import { describe, expect, it } from 'vitest';

import { defineScenario, runScenario, type LabScenario } from '../dsl.ts';
import { sealArtefact } from '../record/evidence.ts';
import { findSecrets } from '../record/secrets.ts';
import {
  DIGEST,
  MemoryHost,
  VERSION,
  localProvenance,
} from '../testing/lab.ts';
import { cfSettle01 } from './cf-settle-01.ts';
import { cfSettle02 } from './cf-settle-02.ts';
import { cfSettle05 } from './cf-settle-05.ts';
import { FIN_LIMIT, UNSET_ROUNDS } from './settle-return.ts';

const LIMITS = { unset: undefined, fin: FIN_LIMIT, minus1: -1 };
const SINGLE = (path: string[]) =>
  Object.keys(LIMITS).flatMap((l) => path.map((p) => `${l}-${p}`));

/** Runs the scenario on the memory host and seals what it recorded. */
async function sealed(scenario: LabScenario, host = new MemoryHost()) {
  const run = await runScenario(host, scenario, 'r1');
  return sealArtefact({
    ...{ schemaVersion: 1, cfId: scenario.cfId, title: scenario.title },
    ...{ protocol: scenario.protocol, brokerVersion: VERSION },
    ...{ imageDigest: DIGEST, ...run, provenance: localProvenance },
  });
}

/** The queues in the order declared, the take count of each, and the limit argument of each. */
function shape(scenario: LabScenario, queues: string[]) {
  const steps = defineScenario(scenario).steps;
  const declared = steps.filter((s) => s.op === 'declareQueue');
  expect(declared.map((s) => s.queue)).toEqual(queues);
  // Quorum queues with no limit, a limit of 2 and -1.
  const limit = (q: string) => LIMITS[q.split('-')[0] as keyof typeof LIMITS];
  expect(
    declared.map((s) => [s.type, s.arguments['x-delivery-limit']]),
  ).toEqual(queues.map((q) => ['quorum', limit(q)]));
  const takes = (q: string) =>
    steps.filter(
      (s) =>
        (s.op === 'get' || s.op === 'consume' || s.op === 'mgmtGet') &&
        s.queue === q,
    ).length;
  // One return per single queue; the crossing queues return limit + 1 times.
  const expected = queues.map((q) =>
    q.endsWith('-rounds')
      ? q.startsWith('unset')
        ? UNSET_ROUNDS
        : FIN_LIMIT + 1
      : 1,
  );
  expect(queues.map(takes)).toEqual(expected);
  // A wait follows the last return of every queue (a settle, or the management get) and comes before its drain.
  for (const q of queues) {
    const last = steps
      .map(
        (s) =>
          (s.op === 'settle' &&
            'ref' in s.target &&
            s.target.ref.startsWith(`${q}-`)) ||
          (s.op === 'mgmtGet' && s.queue === q),
      )
      .lastIndexOf(true);
    const at = (op: string) =>
      steps.findIndex((s) => s.op === op && 'queue' in s && s.queue === q);
    expect(last, q).toBeGreaterThan(-1);
    expect(last, q).toBeLessThan(at('awaitReady'));
    expect(at('awaitReady'), q).toBeLessThan(at('observe'));
  }
  return steps;
}

const ZERO_SECRETS = (artefact: Awaited<ReturnType<typeof sealed>>) => {
  expect(findSecrets(artefact, ['guest'])).toEqual([]);
  expect(JSON.stringify(artefact)).not.toMatch(/body|amqp:|http:|password/i);
};

describe('the settle return scenarios', () => {
  it('AC-10 CF-SETTLE-01 and CF-SETTLE-02 are well formed, cover every limit and path, and record no secret', async () => {
    const both = [...SINGLE(['get', 'consume']), 'unset-rounds', 'fin-rounds'];
    for (const [scenario, action] of [
      [cfSettle01, 'nack'],
      [cfSettle02, 'reject'],
    ] as const) {
      const steps = shape(scenario, both);
      expect(steps.filter((s) => s.op === 'consume')).toHaveLength(3);
      // Every return is the same settle on the delivery's own channel, with requeue; no management get.
      const settles = steps.filter((s) => s.op === 'settle');
      expect(settles, action).toHaveLength(
        SINGLE(['get', 'consume']).length + UNSET_ROUNDS + FIN_LIMIT + 1,
      );
      expect(
        settles.every(
          (s) =>
            s.action.kind === action &&
            s.action.requeue &&
            s.channel === undefined,
        ),
        action,
      ).toBe(true);
      expect(steps.some((s) => s.op === 'mgmtGet')).toBe(false);
      expect(scenario.protocol).toBe('amqp091');

      const artefact = await sealed(scenario);
      ZERO_SECRETS(artefact);
      expect(artefact.observations).toHaveLength(2 * both.length);
    }
  }, 60_000);

  it('AC-16 CF-SETTLE-05 returns with the management get and reads the counters from the drain', async () => {
    const queues = [...SINGLE(['http']), 'unset-rounds', 'fin-rounds'];
    const steps = shape(cfSettle05, queues);
    // The management get with ack_requeue_true is the only return: no 0-9-1 get, consume or settle.
    const gets = steps.filter((s) => s.op === 'mgmtGet');
    expect(gets).toHaveLength(3 + UNSET_ROUNDS + FIN_LIMIT + 1);
    expect(
      gets.every((s) => s.ackmode === 'ack_requeue_true' && s.count === 1),
    ).toBe(true);
    expect(
      steps.filter((s) => ['get', 'consume', 'settle'].includes(s.op)),
    ).toEqual([]);
    expect(cfSettle05.protocol).toBe('http');

    // The answer is kept as status, message id, redelivered, size and count: no body, no properties.
    const answer = [
      {
        ...{ redelivered: false, payload_bytes: 7, message_count: 1 },
        ...{
          payload: 'secret-body',
          properties: { message_id: 'm', app_id: 'x' },
        },
      },
    ];
    const host = new MemoryHost(VERSION, { managementJson: answer });
    const artefact = await sealed(cfSettle05, host);
    const first = artefact.steps.find((s) => s.args.as === 'fin-http-d');
    expect(first?.result).toEqual({
      status: 200,
      messages: [
        {
          messageId: 'm',
          redelivered: false,
          payloadBytes: 7,
          messageCount: 1,
        },
      ],
    });
    expect(JSON.stringify(artefact)).not.toMatch(/secret-body|app_id/);
    ZERO_SECRETS(artefact);
    // The counters come from the 0-9-1 drain that follows the returns: one observation per message.
    expect(artefact.observations).toHaveLength(2 * queues.length);
    expect(host.managementCalls).toHaveLength(gets.length);
    expect(host.managementCalls[0]).toMatchObject({
      method: 'POST',
      body: { count: 1, ackmode: 'ack_requeue_true' },
    });
  }, 60_000);
});
