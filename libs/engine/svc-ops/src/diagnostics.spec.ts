// The acceptance criteria of M0-69 for the diagnostics bundle (DC-59, I-10), through the real
// ActionExecutor over the module's fakes. Every test that plants a canary scans the file the sink
// received with the kernel's canary scanner, which also finds a re-encoded value.
import { diagnosticsBundle } from '@app/contracts';
import {
  AppError,
  createCanaryScanner,
  createTestContext,
  createTestExecutor,
  systemClock,
  toProblem,
} from '@app/kernel';
import { describe, expect, it } from 'vitest';

import { createDiagnosticsBundleAction } from './actions/diagnostics-bundle';
import {
  AUDIT_ROWS_MAX,
  LOG_BYTES_MAX,
  PROFILES_MAX,
  maskSecretValues,
} from './internal/bundle';
import {
  FAKE_FILE_TOKEN,
  createAuditRow,
  createMemoryFileSink,
  createOpsFakeDeps,
  createSampleProfile,
  type FakeDepsOptions,
} from './testing';

let runs = 0;

/** Runs diagnostics.bundle through the executor and returns what it answered and what was written. */
async function bundleWith(
  options: FakeDepsOptions = {},
  input: { logLines?: number } = {},
) {
  const sink = createMemoryFileSink();
  const deps = createOpsFakeDeps({ files: sink, ...options });
  const engine = createTestExecutor();
  engine.executor.register(createDiagnosticsBundleAction(deps));
  runs += 1;
  const outcome = await engine.executor.run(
    diagnosticsBundle,
    { fileToken: FAKE_FILE_TOKEN, ...input },
    createTestContext({ idempotencyKey: `diagnostics-spec-${String(runs)}` }),
  );
  if (outcome.kind !== 'output') throw new Error(`got ${outcome.kind}`);
  const bytes = sink.written.get(FAKE_FILE_TOKEN);
  if (bytes === undefined) throw new Error('nothing was written');
  const text = Buffer.from(bytes).toString('utf8');
  return {
    output: outcome.output,
    bytes,
    text,
    document: JSON.parse(text) as Record<string, unknown>,
    engine,
  };
}

// Canaries long enough for the scanner; each is planted in the way a real leak would look.
const LAUNCH = 'launch-TOKEN-Zk9/Qw+7"x\\y-canary-1';
const DB_PASSWORD = 'db-passw0rd-canary-2';
const URI_PASSWORD = 'uri-passw0rd-canary-3';
const BEARER = 'bearer-value-canary-4';
const PROFILE_USER = 'profile-user-canary-5';
const PROFILE_URL_SECRET = 'prom-scrape-canary-6';
const ISSUER_SECRET = 'issuer-token-canary-7';
const NODE_NAME = 'rabbit@node-canary-8';
const ALL_CANARIES = [
  LAUNCH,
  DB_PASSWORD,
  URI_PASSWORD,
  BEARER,
  PROFILE_USER,
  PROFILE_URL_SECRET,
  ISSUER_SECRET,
  NODE_NAME,
] as const;

function plantedLogs(): string[] {
  const b64 = Buffer.from(LAUNCH).toString('base64');
  return [
    JSON.stringify({ level: 'info', msg: 'ready', password: DB_PASSWORD }),
    JSON.stringify({
      level: 'warn',
      msg: `connect to amqp://svc:${URI_PASSWORD}@broker:5672/vhost failed`,
    }),
    JSON.stringify({
      level: 'info',
      msg: `request with Authorization: Bearer ${BEARER}`,
    }),
    // Free text: only the value-based layer can know this one is a secret.
    `plain line, not JSON: the launch token is ${LAUNCH}`,
    JSON.stringify({ msg: 'echo', detail: JSON.stringify({ t: LAUNCH }) }),
    JSON.stringify({ msg: `GET /?t=${encodeURIComponent(LAUNCH)}` }),
    JSON.stringify({ msg: `hex ${Buffer.from(LAUNCH).toString('hex')}` }),
    JSON.stringify({ msg: `b64 ${b64}`, [`key-${LAUNCH}`]: 1 }),
  ];
}

function plantedProfile() {
  return createSampleProfile({
    identity: {
      user: PROFILE_USER,
      tags: [],
      isAdmin: true,
      canMonitor: true,
      isPolicymaker: true,
    },
    nodes: [{ name: NODE_NAME, running: true }],
    prometheus: {
      endpoints: [
        {
          node: NODE_NAME,
          url: `https://scrape:${PROFILE_URL_SECRET}@node:15692/metrics`,
          source: 'user',
        },
      ],
      perObjectAllowed: true,
      queueFilter: true,
      minIntervalSec: 15,
    },
    auth: {
      httpChainSeparate: 'unknown',
      oauth: {
        issuer: `https://idp.example/realm?access_token=${ISSUER_SECRET}`,
        pinned: true,
        source: 'api/auth',
      },
    },
    // An allowed field that carries a secret value: only the value-based layer can catch it.
    featureFlags: { [`flag-${LAUNCH}`]: 'enabled' },
  });
}

describe('diagnostics bundle', () => {
  it('AC-2 a bundle built with canary secrets planted in logs and profiles is clean under the secret scanner', async () => {
    const { text } = await bundleWith({
      lines: plantedLogs(),
      profiles: [plantedProfile()],
      secrets: [LAUNCH],
    });

    expect(createCanaryScanner(ALL_CANARIES).scan(text)).toEqual([]);
  });

  it('AC-2 the planting is not vacuous: the same data leaks through a raw dump of the sources', () => {
    const raw = JSON.stringify([plantedLogs(), plantedProfile()]);
    const found = createCanaryScanner(ALL_CANARIES).scan(raw);

    // Every canary is in the raw data under at least one encoding the scanner knows.
    expect(new Set(found.map((hit) => hit.index))).toEqual(
      new Set(ALL_CANARIES.map((_, index) => index)),
    );
  });

  it('AC-2 the engine launch token is removed from free text, keys and every re-encoding', async () => {
    const { text } = await bundleWith({
      lines: plantedLogs(),
      secrets: [LAUNCH],
    });

    expect(text).not.toContain(LAUNCH);
    expect(createCanaryScanner([LAUNCH]).scan(text)).toEqual([]);
    expect(text).toContain('[REDACTED]');
  });

  it('AC-2 a secret that contains a redactable pattern is removed whole, not left as the part redaction did not eat', async () => {
    // The kernel would redact `?token=...` and leave `canary-prefix-77` behind; the value goes first.
    const secret = 'canary-prefix-77?token=abcdef123456';
    const line = JSON.stringify({ msg: `see ${secret} here` });

    const { text } = await bundleWith({ lines: [line], secrets: [secret] });

    expect(text).not.toContain('canary-prefix-77');
    expect(text).toContain('see [REDACTED] here');
  });
  it('AC-2 a secret value is masked however short, and longer values first', () => {
    expect(maskSecretValues({ a: 'xx pw yy' }, ['pw'])).toEqual({
      a: 'xx [REDACTED] yy',
    });
    expect(maskSecretValues('a b c', ['b', ''])).toBe('a [REDACTED] c');
    expect(
      maskSecretValues('token-abcdef!', ['token-abc', 'token-abcdef']),
    ).toBe('[REDACTED]!');
  });

  it('AC-2 secrets are asked for at every build, so a secret that appears later is covered', async () => {
    const list: string[] = [];
    const sink = createMemoryFileSink([
      'first-token-000000001',
      'second-token-00000002',
    ]);
    const base = createOpsFakeDeps({ lines: [`value ${LAUNCH}`], files: sink });
    const deps = {
      ...base,
      diagnostics: { ...base.diagnostics, secretValues: () => list },
    };
    const action = createDiagnosticsBundleAction(deps);
    const engine = createTestExecutor();
    engine.executor.register(action);
    const run = (fileToken: string, key: string) =>
      engine.executor.run(
        diagnosticsBundle,
        { fileToken },
        createTestContext({ idempotencyKey: key }),
      );

    await run('first-token-000000001', 'diagnostics-late-0001');
    list.push(LAUNCH);
    await run('second-token-00000002', 'diagnostics-late-0002');

    const scan = (token: string) =>
      createCanaryScanner([LAUNCH]).scan(sink.written.get(token) ?? '');
    expect(scan('first-token-000000001')).not.toEqual([]);
    expect(scan('second-token-00000002')).toEqual([]);
  });

  it('AC-2 only allow-listed profile fields are copied: a field nobody chose is not in the bundle', async () => {
    const { text, document } = await bundleWith({
      profiles: [plantedProfile()],
    });

    // The user name, the node names and the endpoint and issuer URLs are not on the list.
    expect(text).not.toContain(PROFILE_USER);
    expect(text).not.toContain('node-canary');
    expect(text).not.toContain('scrape:');
    expect(text).not.toContain('idp.example');
    expect(document.profiles).toMatchObject([
      {
        connectionId: 'c1',
        product: 'rabbitmq',
        era: { value: '4.3', conservative: false },
        nodes: { count: 1, running: 1 },
        tls: { verified: true, insecureOverride: false },
      },
    ]);
  });

  it('AC-2 an audit row is copied without who, what it was aimed at, or its detail', async () => {
    const { text, document } = await bundleWith({
      audit: [
        createAuditRow(1, {
          actorId: 'actor-canary-9',
          actorJson: '{"id":"actor-canary-9"}',
          targetJson: '{"queue":"target-canary-9"}',
          detailJson: '{"note":"detail-canary-9"}',
        }),
      ],
    });

    expect(text).not.toContain('canary-9');
    expect(document.audit).toMatchObject([
      { seq: 1, actionId: 'settings.put', phase: 'attempt', risk: 'none' },
    ]);
  });

  it('AC-2 the answer describes the file and the file matches it', async () => {
    const { output, bytes, document } = await bundleWith({
      lines: ['{"a":1}', 'text'],
      profiles: [createSampleProfile()],
      audit: [createAuditRow(1)],
    });

    expect(output.bytes).toBe(bytes.byteLength);
    expect(output.sha256).toBe(
      (await import('node:crypto'))
        .createHash('sha256')
        .update(bytes)
        .digest('hex'),
    );
    expect(output.sections).toEqual([
      { id: 'versions', items: 2, truncated: false },
      { id: 'logs', items: 2, truncated: false },
      { id: 'profiles', items: 1, truncated: false },
      { id: 'audit', items: 1, truncated: false },
    ]);
    expect(output.omitted.map((entry) => entry.id)).toEqual([
      'receipts',
      'incidents',
    ]);
    expect(document).toMatchObject({
      format: 'diagnostics-bundle',
      schemaVersion: 1,
      createdAt: '2023-11-14T22:13:20.000Z',
      omitted: [{ id: 'receipts' }, { id: 'incidents' }],
    });
    // The answer never carries the content (I-13: it says what was left out, in the file too).
    expect(JSON.stringify(output)).not.toContain('"a":1');
  });

  describe('logs', () => {
    it('keeps the newest lines in the order they were written, as data when they are JSON', async () => {
      const { document, output } = await bundleWith(
        { lines: ['{"n":1}', '{"n":2}', 'not json', '{"n":4}'] },
        { logLines: 3 },
      );

      expect((document.logs as { lines: unknown[] }).lines).toEqual([
        { n: 2 },
        'not json',
        { n: 4 },
      ]);
      // One older line is not in the bundle: the section says so.
      expect(output.sections.find((s) => s.id === 'logs')).toEqual({
        id: 'logs',
        items: 3,
        truncated: true,
      });
    });

    it('says so when the ring dropped lines, and not otherwise', async () => {
      const dropped = await bundleWith({ lines: ['a'], logDropped: 4 });
      const kept = await bundleWith({ lines: ['a'], logDropped: 0 });

      expect(dropped.output.sections[1]?.truncated).toBe(true);
      expect(kept.output.sections[1]?.truncated).toBe(false);
      expect((dropped.document.logs as { dropped: number }).dropped).toBe(4);
    });

    it('carries no lines for logLines 0 and says that lines were left out', async () => {
      const { document, output } = await bundleWith(
        { lines: ['a', 'b'] },
        { logLines: 0 },
      );

      expect((document.logs as { lines: unknown[] }).lines).toEqual([]);
      expect(output.sections[1]).toEqual({
        id: 'logs',
        items: 0,
        truncated: true,
      });
    });

    it('replaces a huge line by a marker and keeps the section within its byte budget', async () => {
      const huge = 'y'.repeat(70_000);
      const big = JSON.stringify({ msg: 'ab cd '.repeat(333) });
      const many = Array.from(
        { length: Math.ceil(LOG_BYTES_MAX / 2000) + 50 },
        () => big,
      );

      const marked = await bundleWith({ lines: [huge] });
      const capped = await bundleWith({ lines: many }, { logLines: 5000 });

      expect(marked.text).toContain('[line too long: 70000 characters]');
      expect(marked.text).not.toContain('yyyy');
      expect(capped.bytes.byteLength).toBeLessThan(LOG_BYTES_MAX + 64 * 1024);
      expect(capped.output.sections[1]?.truncated).toBe(true);
      expect(capped.output.sections[1]?.items).toBeLessThan(many.length);
    });

    it('AC-2 hostile log lines do not hold the event loop: the build gives way between lines (I-5)', async () => {
      // A long unbroken run of letters is the slow case of the redaction patterns.
      const hostile = JSON.stringify({ msg: 'z'.repeat(2000) });
      const lines = Array.from({ length: 600 }, () => hostile);
      let worst = 0;
      let ticks = 0;
      let last = performance.now();
      const timer = setInterval(() => {
        const now = performance.now();
        worst = Math.max(worst, now - last);
        last = now;
        ticks += 1;
      }, 1);

      await bundleWith({ lines, clock: systemClock });
      // A loop that never gave way has not run its timer yet: count the wait it is still owed.
      worst = Math.max(worst, performance.now() - last);
      clearInterval(timer);

      // The build works in slices of SLICE_MS and lets the loop run between them, so the timer runs
      // once per slice: hundreds of times here, however slow the machine. A build that never gave
      // way (or gave way every hundred lines) runs it a handful of times. Counting turns is what
      // keeps this test off the load of a shared runner (a macOS runner stretched one 5 ms slice to
      // 350 ms when the milliseconds were the assertion); the gap bound only catches a build that
      // held the loop for most of its twenty seconds.
      expect(ticks).toBeGreaterThan(20);
      expect(worst).toBeLessThan(2000);
    }, 60_000);

    it('a log line nested far deeper than the stack is bounded, not a crash', async () => {
      const depth = 30_000;
      const deep = `${'['.repeat(depth)}${']'.repeat(depth)}`;

      const { document } = await bundleWith({
        lines: [deep, 'next'],
        secrets: [LAUNCH],
      });

      expect((document.logs as { lines: unknown[] }).lines).toHaveLength(2);
      expect((document.logs as { lines: unknown[] }).lines[1]).toBe('next');
    });

    it('an input beyond the contract maximum is refused before anything is built', () => {
      expect(
        diagnosticsBundle.input.safeParse({
          fileToken: FAKE_FILE_TOKEN,
          logLines: 5001,
        }).success,
      ).toBe(false);
    });
  });

  describe('bounds', () => {
    it('keeps at most PROFILES_MAX profiles and flags the cut', async () => {
      const profiles = Array.from({ length: PROFILES_MAX + 3 }, () =>
        createSampleProfile(),
      );

      const { output, document } = await bundleWith({ profiles });

      expect((document.profiles as unknown[]).length).toBe(PROFILES_MAX);
      expect(output.sections[2]).toEqual({
        id: 'profiles',
        items: PROFILES_MAX,
        truncated: true,
      });
    });

    it('keeps the newest AUDIT_ROWS_MAX audit rows and flags the cut', async () => {
      const total = AUDIT_ROWS_MAX + 7;
      const audit = Array.from({ length: total }, (_, index) =>
        createAuditRow(index + 1),
      );

      const { output, document } = await bundleWith({ audit });
      const seqs = (document.audit as { seq: number }[]).map((row) => row.seq);

      expect(seqs).toHaveLength(AUDIT_ROWS_MAX);
      expect(seqs[0]).toBe(total - AUDIT_ROWS_MAX + 1);
      expect(seqs.at(-1)).toBe(total);
      expect(output.sections[3]).toEqual({
        id: 'audit',
        items: AUDIT_ROWS_MAX,
        truncated: true,
      });
    });

    it('an empty audit chain and no profiles give empty sections, not errors', async () => {
      const { output } = await bundleWith();

      expect(output.sections.map((s) => [s.id, s.items, s.truncated])).toEqual([
        ['versions', 2, false],
        ['logs', 0, false],
        ['profiles', 0, false],
        ['audit', 0, false],
      ]);
    });
  });

  describe('the save target', () => {
    it('an unknown token is NOT_FOUND and nothing is written', async () => {
      const sink = createMemoryFileSink(['some-other-token-0001']);
      const engine = createTestExecutor();
      engine.executor.register(
        createDiagnosticsBundleAction(createOpsFakeDeps({ files: sink })),
      );

      await expect(
        engine.executor.run(
          diagnosticsBundle,
          { fileToken: FAKE_FILE_TOKEN },
          createTestContext({ idempotencyKey: 'diagnostics-unknown-token' }),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      expect(sink.written.size).toBe(0);
      expect(engine.audit.outcomes).toMatchObject([
        { result: 'error', code: 'NOT_FOUND' },
      ]);
    });

    it('a sink that fails with a path in its message gives a Problem without the path', async () => {
      const failing = {
        write: () =>
          Promise.reject(
            new Error('EACCES: open C:\\Users\\victim\\secret-dir\\b.json'),
          ),
      };
      const engine = createTestExecutor();
      engine.executor.register(
        createDiagnosticsBundleAction(createOpsFakeDeps({ files: failing })),
      );

      const error = await engine.executor
        .run(
          diagnosticsBundle,
          { fileToken: FAKE_FILE_TOKEN },
          createTestContext({ idempotencyKey: 'diagnostics-sink-fails' }),
        )
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );

      expect(error).toBeInstanceOf(AppError);
      const problem = toProblem(error);
      expect(problem.code).toBe('INTERNAL');
      expect(JSON.stringify(problem)).not.toContain('victim');
      expect(JSON.stringify(problem)).not.toContain('secret-dir');
    });

    it('a token that is not a token (a path) is refused by the contract', () => {
      for (const fileToken of [
        'C:\\Users\\x\\b.json',
        '../../etc/passwd',
        '/tmp/x',
        'short',
      ]) {
        expect(diagnosticsBundle.input.safeParse({ fileToken }).success).toBe(
          false,
        );
      }
    });
  });

  it('the bundle is written once per call, to the token it was given', async () => {
    let writes = 0;
    const tokens: string[] = [];
    const files = {
      write: (token: string) => {
        writes += 1;
        tokens.push(token);
        return Promise.resolve('written' as const);
      },
    };

    const engine = createTestExecutor();
    engine.executor.register(
      createDiagnosticsBundleAction(createOpsFakeDeps({ files })),
    );
    await engine.executor.run(
      diagnosticsBundle,
      { fileToken: FAKE_FILE_TOKEN },
      createTestContext({ idempotencyKey: 'diagnostics-write-once' }),
    );

    expect(writes).toBe(1);
    expect(tokens).toEqual([FAKE_FILE_TOKEN]);
  });
});
