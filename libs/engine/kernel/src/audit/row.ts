// What an audit row holds and how it is hashed (blueprint 5.1 step 10 and 12, 6.2, T9).
//
// A row is built from an explicit allow-list of the executor's facts: who acted (a snapshot of the
// principal and whoever it acted for), what, on which target, in which environment, at what risk,
// under which plan. It never holds an input, a sensitive payload or a message body, and every string
// that does go in is passed through the logger's redaction and clipped, so a secret that leaks into a
// display name or a queue name does not reach the chain (I-10). A row is closed by its hash:
//
//   hash = sha256("app.audit.v1\n" || canonical JSON of every other column, including prevHash)
//
// `seq` is part of the hash, so rows cannot be renumbered or reordered; `prevHash` is the hash of the
// row before, so a row cannot be removed from the middle.
import type { AuditRow, Principal } from '@app/ports';

import { encodeValue, sha256Hex } from '../actions/canonical.ts';
import type { AuditEntry, AuditOutcome } from '../actions/hooks.ts';
import { scrubJson, scrubText } from '../log/scrub.ts';

/** The `prevHash` of the first row. */
export const AUDIT_GENESIS_HASH = '0'.repeat(64);

const DOMAIN = 'app.audit.v1\n';
const MAX_TEXT = 256;
const MAX_ROLES = 32;
const MAX_APPROVERS = 20;
const MAX_CHAIN = 4;

/** The members the chain assigns: everything else comes from the executor's facts. */
export type AuditRowBody = Omit<AuditRow, 'seq' | 'prevHash' | 'hash'>;

export function hashAuditRow(row: Readonly<Record<string, unknown>>): string {
  return sha256Hex(DOMAIN + encodeValue(row));
}

/** Redacts every string in a JSON value (and masks sensitive keys), then clips what is left. */
function clean(value: unknown): unknown {
  return scrubJson(value, MAX_TEXT);
}

function actorOf(principal: Principal, depth = 0): Record<string, unknown> {
  return {
    kind: principal.kind,
    id: principal.id,
    display: principal.display,
    roles: principal.roles.slice(0, MAX_ROLES),
    surface: principal.surface,
    unattended: principal.unattended,
    ...(principal.onBehalfOf === undefined || depth >= MAX_CHAIN
      ? {}
      : { onBehalfOf: actorOf(principal.onBehalfOf, depth + 1) }),
  };
}

function text(value: string, max = MAX_TEXT): string {
  return scrubText(value, max);
}

function bodyOf(entry: AuditEntry): AuditRowBody {
  const { principal } = entry;
  return {
    at: entry.at,
    phase: 'attempt',
    correlationId: text(entry.correlationId, 128),
    actionId: text(entry.actionId, 128),
    kind: entry.kind,
    actorId: text(principal.id),
    surface: principal.surface,
    onBehalfOfId:
      principal.onBehalfOf === undefined ? null : text(principal.onBehalfOf.id),
    actorJson: encodeValue(clean(actorOf(principal))),
    targetJson: encodeValue(clean(entry.target)),
    env: entry.env,
    risk: entry.risk,
    planId: entry.planId === undefined ? null : text(entry.planId, 128),
    planDigest:
      entry.planDigest === undefined ? null : text(entry.planDigest, 128),
    approvedByJson: encodeValue(
      clean((entry.approvedBy ?? []).slice(0, MAX_APPROVERS)),
    ),
    attemptSeq: null,
    result: null,
    code: null,
    jobId: null,
    receiptId: null,
    detailJson: '{}',
  };
}

/** The body of the attempt row for `entry`. */
export function attemptBody(entry: AuditEntry): AuditRowBody {
  return bodyOf(entry);
}

/** The body of the outcome row for `entry`. */
export function outcomeBody(entry: AuditOutcome): AuditRowBody {
  const detail: Record<string, unknown> = {};
  if (entry.receiptFailed === true) detail.receiptFailed = true;
  return {
    ...bodyOf(entry),
    phase: 'outcome',
    attemptSeq: entry.attemptSeq ?? null,
    result: entry.result,
    code: entry.code ?? null,
    jobId: entry.jobId === undefined ? null : text(entry.jobId, 128),
    receiptId:
      entry.receiptId === undefined ? null : text(entry.receiptId, 128),
    detailJson: encodeValue(detail),
  };
}

/** A body with the chain's members added and the hash computed. */
export function sealRow(
  body: AuditRowBody,
  seq: number,
  prevHash: string,
): AuditRow {
  const open = { ...body, seq, prevHash };
  return { ...open, hash: hashAuditRow(open) };
}
