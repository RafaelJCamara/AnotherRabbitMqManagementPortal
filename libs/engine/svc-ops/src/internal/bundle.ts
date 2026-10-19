// The diagnostics bundle (DC-59, blueprint 13): a redacted, local JSON document that a person can
// read before they send it anywhere. Three layers keep a secret out (I-10):
//   1. an allow-list: a profile and an audit row are copied field by field, so a field that is added
//      later is not in the bundle until someone chooses it;
//   2. the secret values the engine holds are removed wherever they occur, in any string or key,
//      before the kernel's redaction, so a redaction that eats part of a secret (the `?token=...` of
//      a value that contains one) does not leave the rest of it behind;
//   3. the kernel's redaction (`scrubJson`): sensitive keys, credentialed URIs, JWTs, bearer values.
import { setImmediate as nextTurn } from 'node:timers/promises';

import type { DiagnosticsBundleOutput } from '@app/contracts';
import type { BrokerProfile } from '@app/domain-model';
import {
  REDACTED,
  encodedForms,
  scrubJson,
  sha256Hex,
  type Clock,
} from '@app/kernel';
import type { AuditRow } from '@app/ports';

import type { OpsModuleDeps } from '../deps';

export const DEFAULT_LOG_LINES = 1000;
/** Profiles in one bundle. */
export const PROFILES_MAX = 50;
/** Audit rows in one bundle (the newest). */
export const AUDIT_ROWS_MAX = 200;
/** The serialised log lines of one bundle; older lines are left out and the section says so. */
export const LOG_BYTES_MAX = 4 * 1024 * 1024;
/** A log line longer than this is replaced by a marker before it is parsed. */
export const LOG_LINE_CHARS_MAX = 65_536;

const MASK_DEPTH_MAX = 64;
/** Work this long, then let the event loop run (I-5). One scrubbed string costs a few milliseconds at worst. */
export const SLICE_MS = 5;

function createSlicer(clock: Clock): () => Promise<void> {
  let since = clock.monotonic();
  return async () => {
    if (clock.monotonic() - since < SLICE_MS) return;
    await nextTurn();
    since = clock.monotonic();
  };
}

export const OMITTED = [
  {
    id: 'receipts',
    reason: 'No receipt listing exists yet, so receipts are not collected.',
  },
  {
    id: 'incidents',
    reason: 'Incidents are not recorded yet, so none are collected.',
  },
] as const satisfies DiagnosticsBundleOutput['omitted'];

/**
 * Replaces every secret value in every string and key of `value`, and every form the kernel's
 * canary scanner would look for (JSON-escaped, percent-encoded, hex, base64), longest first so that
 * a value that contains another is not left half there.
 */
export function maskSecretValues(
  value: unknown,
  secrets: readonly string[],
): unknown {
  const ordered = [
    ...new Set(
      secrets
        .filter((secret) => secret !== '')
        .flatMap((secret) => [
          // The value itself, however short: the forms below drop texts under four characters.
          secret,
          ...encodedForms(secret).flatMap((form) =>
            form.fold ? [form.text, form.text.toUpperCase()] : [form.text],
          ),
        ]),
    ),
  ].sort((a, b) => b.length - a.length);
  const maskText = (text: string): string =>
    ordered.reduce(
      (current, secret) => current.split(secret).join(REDACTED),
      text,
    );
  const walk = (node: unknown, depth: number): unknown => {
    if (typeof node === 'string') return maskText(node);
    if (node === null || typeof node !== 'object') return node;
    if (depth >= MASK_DEPTH_MAX) return REDACTED;
    if (Array.isArray(node)) {
      return (node as unknown[]).map((item) => walk(item, depth + 1));
    }
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(node)) {
      out[maskText(key)] = walk(entry, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}

/** The few facts of a probed broker that help a person debug; nothing else is copied. */
export function summariseProfile(
  profile: BrokerProfile,
): Record<string, unknown> {
  return {
    connectionId: profile.connectionId,
    probedAt: profile.probedAt,
    semanticsVersion: profile.semanticsVersion,
    product: profile.product,
    provider: profile.provider,
    version: {
      min: profile.versions.min,
      mixed: profile.versions.mixed,
      build: profile.versions.build,
    },
    era: { value: profile.era.value, conservative: profile.era.conservative },
    verification: profile.verification,
    nodes: {
      count: profile.nodes.length,
      running: profile.nodes.filter((node) => node.running).length,
    },
    tls: {
      verified: profile.tls.verified,
      insecureOverride: profile.tls.insecureOverride,
    },
    limits: profile.limits,
    restrictions: profile.restrictions,
    featureFlags: profile.featureFlags,
  };
}

/** One audit row without who, what it was aimed at, or its detail: a trail of what ran and how it ended. */
export function summariseAudit(row: AuditRow): Record<string, unknown> {
  return {
    seq: row.seq,
    at: row.at,
    phase: row.phase,
    actionId: row.actionId,
    kind: row.kind,
    surface: row.surface,
    env: row.env,
    risk: row.risk,
    result: row.result,
    code: row.code,
    correlationId: row.correlationId,
    receiptId: row.receiptId,
    jobId: row.jobId,
  };
}

/** A log line as data: JSON when it is JSON, text when it is not, a marker when it is huge. */
function parseLogLine(line: string): unknown {
  if (line.length > LOG_LINE_CHARS_MAX) {
    return `[line too long: ${String(line.length)} characters]`;
  }
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return line;
  }
}

export interface BuiltBundle {
  readonly data: Uint8Array;
  readonly sha256: string;
  readonly sections: DiagnosticsBundleOutput['sections'];
  readonly omitted: DiagnosticsBundleOutput['omitted'];
}

export async function buildBundle(
  deps: OpsModuleDeps,
  options: { logLines?: number | undefined },
): Promise<BuiltBundle> {
  const { diagnostics } = deps;
  const secrets = diagnostics.secretValues();
  const clean = (value: unknown): unknown =>
    scrubJson(maskSecretValues(value, secrets));

  const slice = createSlicer(deps.clock);
  const logRequest = options.logLines ?? DEFAULT_LOG_LINES;
  const tail = diagnostics.logs.tail(logRequest);
  // Newest first until the byte budget is spent, then back to the order they were written in.
  const lines: unknown[] = [];
  let logBytes = 0;
  let cutByBytes = false;
  for (const line of [...tail.lines].reverse()) {
    await slice();
    const entry = clean(parseLogLine(line));
    logBytes += JSON.stringify(entry).length;
    if (logBytes > LOG_BYTES_MAX) {
      cutByBytes = true;
      break;
    }
    lines.push(entry);
  }
  lines.reverse();
  const logsTruncated =
    cutByBytes || tail.lines.length < tail.held || tail.dropped > 0;

  const profiles = await diagnostics.profiles(PROFILES_MAX + 1);
  const shownProfiles = profiles.slice(0, PROFILES_MAX).map(summariseProfile);

  const head = await diagnostics.audit.head();
  const from = Math.max(0, (head?.seq ?? 0) - AUDIT_ROWS_MAX);
  const rows = await diagnostics.audit.window(from, AUDIT_ROWS_MAX);
  const shownRows = rows.map(summariseAudit);

  const versions = diagnostics.versions();
  // The log lines were cleaned one by one above; everything else is cleaned here, once.
  const document = {
    format: 'diagnostics-bundle',
    schemaVersion: 1,
    createdAt: new Date(deps.clock.now()).toISOString(),
    versions: clean(versions),
    logs: { lines, held: tail.held, dropped: tail.dropped },
    profiles: clean(shownProfiles),
    audit: clean(shownRows),
    omitted: OMITTED,
  };
  const data = Buffer.from(JSON.stringify(document, null, 2), 'utf8');

  return {
    data,
    sha256: sha256Hex(data),
    sections: [
      {
        id: 'versions',
        items: Object.keys(versions).length,
        truncated: false,
      },
      { id: 'logs', items: lines.length, truncated: logsTruncated },
      {
        id: 'profiles',
        items: shownProfiles.length,
        truncated: profiles.length > PROFILES_MAX,
      },
      {
        id: 'audit',
        items: shownRows.length,
        truncated: from > 0,
      },
    ],
    omitted: OMITTED,
  };
}
