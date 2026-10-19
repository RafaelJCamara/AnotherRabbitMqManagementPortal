// M0-69, the diagnostics bundle through the whole engine: the real router, executor, audit chain and
// log tail of a local engine started the way the bundle starts it, with canary secrets in its log.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { createCanaryScanner } from '@app/kernel';
import { afterEach, describe, expect, it } from 'vitest';

import { BUNDLE_DIR } from './data-dir-bundles.ts';
import {
  localArgs,
  startForTest,
  tempDir,
  type RunningEngine,
  type TempDir,
} from './testing/harness.ts';

const open: RunningEngine[] = [];
const dirs: TempDir[] = [];
afterEach(async () => {
  for (const running of open.splice(0)) await running.engine.close();
  for (const made of dirs.splice(0)) await made.cleanup();
});

async function start(): Promise<{ engine: RunningEngine; dir: string }> {
  const made = await tempDir();
  dirs.push(made);
  const engine = await startForTest(localArgs(made.dir));
  open.push(engine);
  return { engine, dir: made.dir };
}

let calls = 0;
const bundle = (
  engine: RunningEngine,
  body: unknown,
  headers: Record<string, string> = {},
) => {
  calls += 1;
  return fetch(`${engine.base ?? ''}/api/v1/diagnostics/bundle`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${engine.token ?? ''}`,
      'content-type': 'application/json',
      'idempotency-key': `engine-diagnostics-spec-${String(calls)}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
};

const FILE_TOKEN = 'engine-spec-save-target-01';
const written = (dir: string, token = FILE_TOKEN) =>
  readFileSync(join(dir, BUNDLE_DIR, `bundle-${token}.json`), 'utf8');

describe('diagnostics.bundle in a running engine', () => {
  it('AC-2 the launch token and secrets planted in the engine log are not in the bundle', async () => {
    const { engine, dir } = await start();
    const launchToken = engine.token ?? '';
    const dbPassword = 'engine-db-passw0rd-canary-1';
    const uriPassword = 'engine-uri-passw0rd-canary-2';
    // The ways a secret reaches a log: a field, a URI, and free text that only the value is known by.
    engine.logger.warn({ password: dbPassword }, 'login failed');
    engine.logger.warn(`dial amqp://svc:${uriPassword}@broker:5672/ failed`);
    engine.logger.info(`the launch token is ${launchToken}`);
    engine.logger.info({ detail: JSON.stringify({ t: launchToken }) }, 'echo');
    const canaries = [launchToken, dbPassword, uriPassword];

    const answer = await bundle(engine, { fileToken: FILE_TOKEN });
    const body = (await answer.json()) as Record<string, unknown>;

    expect(answer.status).toBe(200);
    const text = written(dir);
    // The planting worked: the log sink the test holds does carry the free-text token.
    expect(engine.lines.join('')).toContain(launchToken);
    expect(createCanaryScanner(canaries).scan(text)).toEqual([]);
    expect(body).toMatchObject({
      bytes: Buffer.byteLength(text),
      omitted: [{ id: 'receipts' }, { id: 'incidents' }],
    });
    expect(JSON.stringify(body)).not.toContain(launchToken);
  });

  it('AC-2 the bundle holds the engine versions, its newest log lines and the audit of the call itself', async () => {
    const { engine, dir } = await start();
    engine.logger.info({ event: 'spec.marker' }, 'a marker line');

    await bundle(engine, { fileToken: FILE_TOKEN });
    // The second bundle holds the whole first call and the attempt of its own: a bundle is built
    // before its own outcome row is written.
    await bundle(engine, { fileToken: 'engine-spec-save-target-02' });
    const first = JSON.parse(written(dir)) as {
      versions: Record<string, string>;
      logs: { lines: { event?: string }[] };
    };
    const second = JSON.parse(written(dir, 'engine-spec-save-target-02')) as {
      audit: { actionId: string; phase: string }[];
    };

    expect(first.versions).toMatchObject({
      engine: '0.0.0',
      mode: 'local',
      node: process.version,
    });
    expect(first.versions.contract).toMatch(/^[0-9a-f]{64}$/);
    expect(first.logs.lines.some((line) => line.event === 'spec.marker')).toBe(
      true,
    );
    expect(second.audit.map((row) => [row.actionId, row.phase])).toEqual([
      ['diagnostics.bundle', 'attempt'],
      ['diagnostics.bundle', 'outcome'],
      ['diagnostics.bundle', 'attempt'],
    ]);
  });

  it('AC-2 a token is good once and a path is not a token', async () => {
    const { engine, dir } = await start();
    await bundle(engine, { fileToken: FILE_TOKEN });
    const before = written(dir);

    const again = await bundle(engine, { fileToken: FILE_TOKEN });
    const path = await bundle(engine, {
      fileToken: '../../../etc/passwd-0123',
    });

    expect(again.status).toBe(404);
    expect(path.status).toBe(400);
    expect(written(dir)).toBe(before);
    expect(readdirSync(join(dir, BUNDLE_DIR))).toHaveLength(1);
  });

  it('AC-2 asking for a bundle needs the launch token', async () => {
    const { engine, dir } = await start();

    const answer = await bundle(
      engine,
      { fileToken: FILE_TOKEN },
      { authorization: 'Bearer not-the-launch-token' },
    );

    expect(answer.status).toBe(401);
    expect(() => readdirSync(join(dir, BUNDLE_DIR))).toThrow();
  });
});
