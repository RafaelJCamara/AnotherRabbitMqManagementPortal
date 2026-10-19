// Fakes for the ports of this module, shared by its specs, by the architecture manifest
// (tools/arch-tests) and by the HTTP specs (libs/testkit). Give each port in deps.ts a fake here.
import { BrokerProfileSchema, type BrokerProfile } from '@app/domain-model';
import { createManualClock, type Clock } from '@app/kernel';
import type { AuditRepository, AuditRow } from '@app/ports';

import type { DiagnosticsSources, FileTokenSink, OpsModuleDeps } from './deps';

/** The token the fakes accept by default. */
export const FAKE_FILE_TOKEN = 'fake-save-target-0001';

/** A save target in memory: only registered tokens are known, and each one is good once. */
export interface MemoryFileSink extends FileTokenSink {
  /** What was written, by token. */
  readonly written: ReadonlyMap<string, Uint8Array>;
}

export function createMemoryFileSink(
  tokens: readonly string[] = [FAKE_FILE_TOKEN],
): MemoryFileSink {
  const open = new Set(tokens);
  const written = new Map<string, Uint8Array>();
  return {
    written,
    write: (fileToken, data) => {
      if (!open.delete(fileToken)) return Promise.resolve('unknown-token');
      written.set(fileToken, Uint8Array.from(data));
      return Promise.resolve('written');
    },
  };
}

/** A probed profile with the fields of the schema and nothing planted in them. */
export function createSampleProfile(
  overrides: Partial<BrokerProfile> = {},
): BrokerProfile {
  return BrokerProfileSchema.parse({
    schemaVersion: 1,
    connectionId: 'c1',
    probedAt: 1_700_000_000_000,
    fingerprint: 'fp-1',
    semanticsVersion: 'sem-test',
    product: 'rabbitmq',
    provider: 'self-hosted',
    versions: {
      min: { major: 4, minor: 3, patch: 6, raw: '4.3.6' },
      perNode: { 'rabbit@n0': { major: 4, minor: 3, patch: 6, raw: '4.3.6' } },
      mixed: false,
      build: 'oss',
    },
    era: { value: '4.3', reasons: [], conservative: false },
    verification: 'verified',
    lbFronted: { value: false, evidence: [] },
    nodes: [{ name: 'rabbit@n0', running: true }],
    identity: {
      user: 'guest',
      tags: ['administrator'],
      isAdmin: true,
      canMonitor: true,
      isPolicymaker: true,
    },
    featureFlags: { 'quorum-queue': 'enabled' },
    deprecatedFeaturesUsed: [],
    stats: { disabled: false, queueTotals: true },
    classicEnabled: true,
    exchangeTypes: ['direct'],
    extensions: [],
    restrictions: {
      operatorPolicyChanges: 'allowed',
      qqReplicaOps: 'allowed',
      definitionsExport: 'full',
    },
    limits: { connectionMax: 100, preAuthFrameMax: 4096 },
    prometheus: {
      endpoints: [],
      perObjectAllowed: true,
      queueFilter: true,
      minIntervalSec: 15,
    },
    streams: {
      supported: true,
      paths: ['amqp091'],
      streamProtocolReachable: 'unknown',
    },
    firehose: { available: 'none' },
    auth: { httpChainSeparate: 'unknown' },
    tls: { verified: true, insecureOverride: false },
    managedObjects: [],
    hazards: [],
    gates: {},
    ...overrides,
  });
}

export interface FakeSourceOptions {
  readonly versions?: Readonly<Record<string, string>>;
  readonly lines?: readonly string[];
  /** Lines the log ring reports as evicted. */
  readonly logDropped?: number;
  readonly profiles?: readonly BrokerProfile[];
  readonly audit?: readonly AuditRow[];
  readonly secrets?: readonly string[];
}

/** An audit row with the members a bundle reads; the rest is fixed. */
export function createAuditRow(seq: number, fields: Partial<AuditRow> = {}) {
  const row: AuditRow = {
    seq,
    at: 1_700_000_000_000 + seq,
    phase: 'attempt',
    correlationId: `corr-${String(seq)}`,
    actionId: 'settings.put',
    kind: 'command',
    actorId: 'ui-user',
    surface: 'ui',
    onBehalfOfId: null,
    actorJson: '{"id":"ui-user"}',
    targetJson: '{}',
    env: 'prod',
    risk: 'none',
    planId: null,
    planDigest: null,
    approvedByJson: '[]',
    attemptSeq: null,
    result: null,
    code: null,
    jobId: null,
    receiptId: null,
    detailJson: '{}',
    prevHash: 'p',
    hash: 'h',
    ...fields,
  };
  return row;
}

export function createFakeSources(
  options: FakeSourceOptions = {},
): DiagnosticsSources {
  const lines = options.lines ?? [];
  const rows = options.audit ?? [];
  const audit: Pick<AuditRepository, 'head' | 'window'> = {
    head: () => {
      const last = rows.at(-1);
      return Promise.resolve(
        last === undefined ? undefined : { seq: last.seq, hash: last.hash },
      );
    },
    window: (afterSeq, limit) =>
      Promise.resolve(rows.filter((row) => row.seq > afterSeq).slice(0, limit)),
  };
  return {
    versions: () => options.versions ?? { engine: '0.0.0-test', node: '24' },
    logs: {
      tail: (maxLines) => ({
        lines: maxLines === 0 ? [] : lines.slice(-maxLines),
        held: lines.length,
        dropped: options.logDropped ?? 0,
      }),
    },
    profiles: (limit) =>
      Promise.resolve((options.profiles ?? []).slice(0, limit)),
    audit,
    secretValues: () => options.secrets ?? [],
  };
}

export interface FakeDepsOptions extends FakeSourceOptions {
  readonly files?: FileTokenSink;
  readonly clock?: Clock;
}

export function createOpsFakeDeps(
  options: FakeDepsOptions = {},
): OpsModuleDeps {
  return {
    diagnostics: createFakeSources(options),
    files: options.files ?? createMemoryFileSink(),
    clock: options.clock ?? createManualClock(1_700_000_000_000),
  };
}
