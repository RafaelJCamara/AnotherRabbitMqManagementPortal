// The peek planner (M1-12, R1..R12 of docs/specs/M1-12.md). `planPeek` turns the registry, the
// preflight, the broker profile and the principal into a plan, or into a rejection with a closed
// code. It is pure and total: no I/O, no clock (`nowMs` is an input), no randomness, the input is
// never mutated, every list is sorted. It compares no broker version: every era-dependent fact is
// a registry lookup (settle cells, the doom rule, caps, warnings).
//
// The order of the checks below IS the contract (R2): the first rejection wins.
import { FeatureIdSchema, type WarningRef } from '@app/contracts';
import { SemanticsGapError, type SettleEffect } from '@app/semantics';
import { computeCaps } from './caps.ts';
import { assessDlxHazard } from './dlx-hazard.ts';
import { planDisposition, queueNameOf } from './disposition.ts';
import { holdBudget, timeoutStyle } from './hold-budget.ts';
import {
  doomedOperator,
  estimateLimit,
  readLimit,
  resolveCell,
  visibleLimits,
  type CellResolution,
  type LimitView,
} from './limit.ts';
import { chooseMethod, HTTP_FALLBACK_MAX } from './method.ts';
import { isHumanInteractive } from './principal.ts';
import {
  HONEST_LABEL_KEY,
  reject,
  type PeekRejection,
  type ReasonCode,
} from './rejections.ts';
import type {
  PeekFacts,
  PeekPlanDraft,
  PeekPlanPreview,
  PeekRequest,
  PlannerRegistry,
} from './types.ts';
import { consentIds, sortWarnings, warningRef } from './warnings.ts';

/** The feature id of the peek action; a profile may switch it off (R2, step 2). */
export const PEEK_FEATURE = 'messages.peek';

/** The share of a drop-head queue's length limit at which W-DROPHEAD asks for consent. */
const DROP_HEAD_SHARE = 0.9;

const isBadNumber = (value: number | undefined): boolean =>
  value !== undefined && !(Number.isFinite(value) && value >= 0);

function validate(
  req: PeekRequest,
  facts: PeekFacts,
): { reasons: ReasonCode[]; queueName: string | undefined } {
  const reasons: ReasonCode[] = [];
  const queueName = queueNameOf(req.queue);
  if (queueName === undefined) reasons.push('queue-key-invalid');
  if (!Number.isSafeInteger(req.count) || req.count < 1) {
    reasons.push('count-invalid');
  }
  if (
    req.maxBytes !== undefined &&
    (!Number.isSafeInteger(req.maxBytes) || req.maxBytes < 1)
  ) {
    reasons.push('max-bytes-invalid');
  }
  const queue = facts.preflight.queue;
  if (
    [
      queue.ttlMs,
      queue.consumerTimeoutMs,
      queue.avgBytes,
      queue.ready,
      queue.maxLength,
      facts.preflight.takenAt,
      facts.nowMs,
    ].some(isBadNumber)
  ) {
    reasons.push('preflight-number-invalid');
  }
  return { reasons, queueName };
}

/** Warnings for a rejection: a registry id without an entry is left out, never an error. */
function bestEffort(
  registry: PlannerRegistry,
  ids: readonly string[],
): WarningRef[] {
  const found: WarningRef[] = [];
  for (const id of ids) {
    try {
      found.push(warningRef(registry, id));
    } catch (error) {
      if (!(error instanceof SemanticsGapError)) throw error;
    }
  }
  return sortWarnings(found);
}

const gapRejection = (): PeekRejection =>
  reject('SEMANTICS_GAP', ['semantics-gap']);

export function planPeek(
  req: PeekRequest,
  facts: PeekFacts,
): PeekPlanDraft | PeekRejection {
  const { profile, preflight, principal, registry, nowMs } = facts;
  const era = profile.era.value;
  const queue = preflight.queue;
  const quorum = queue.type === 'quorum';
  const human = isHumanInteractive(principal);

  // 1. The request and the numbers of the preflight.
  const checked = validate(req, facts);
  const { queueName } = checked;
  const [firstInvalid, ...otherInvalid] = checked.reasons;
  if (firstInvalid !== undefined || queueName === undefined) {
    return reject('INVALID_REQUEST', [
      firstInvalid ?? 'queue-key-invalid',
      ...otherInvalid,
    ]);
  }

  // 2. The profile switches peeking off.
  const gate = profile.gates[FeatureIdSchema.parse(PEEK_FEATURE)];
  if (gate !== undefined && !gate.enabled) {
    return reject('GATE', ['gate-disabled']);
  }

  // 3. A stream is read by offset, never with basic.get.
  if (queue.type === 'stream') {
    return reject('STREAM_QUEUE', ['queue-is-stream'], {
      warnings: bestEffort(registry, ['W-STREAM']),
    });
  }

  // 4. An exclusive queue of another connection: 405 for everyone.
  if (queue.exclusiveOwnedByOther) {
    return reject('EXCLUSIVE', ['exclusive-owned-by-other'], {
      warnings: bestEffort(registry, ['W-EXCLUSIVE']),
    });
  }

  // 5. A build that is not verified: only a person may plan on it (the caps are conservative).
  if (profile.verification !== 'verified' && !human) {
    return reject('UNVERIFIED_BROKER', ['unverified-broker']);
  }

  // 6. A quorum queue must be known to have its quorum; absent is "not checked".
  if (quorum && queue.quorumOk !== true) {
    return reject('NO_QUORUM', ['quorum-unhealthy']);
  }

  // 7. basic.get is refused on a single-active-consumer quorum queue with an active consumer.
  if (quorum && queue.singleActiveConsumer && queue.hasActiveConsumer) {
    return reject('SAC_ACTIVE', ['sac-active-consumer']);
  }

  // 8. The settle row for this queue's limit state. A classic queue has no cells (OQ-1429).
  const own = readLimit(queue);
  const gaps: string[] = [];
  let nack: CellResolution | null = null;
  let nackEffect: SettleEffect | null = null;
  if (quorum) {
    nack = resolveCell(registry, {
      era,
      queueType: 'quorum',
      protocol: 'amqp091',
      action: 'amqp091.nack_requeue',
      limitState: own.state,
      delayedRetry: queue.delayedRetry?.type,
    });
    nackEffect = nack?.cell.effect ?? null;
    if (nack === null || nackEffect === null) return gapRejection();
    if (nack.gap !== null) gaps.push(nack.gap);
  }

  // 9. The return destroys the message (3.13 with a limit of -1).
  if (nackEffect?.destructive === true) {
    return reject('LIMIT_MINUS1_313', ['limit-minus1-destructive']);
  }

  // 10. The dead-letter hazard (W-OVERLIMIT, A-2).
  const hazard = assessDlxHazard({
    registry,
    era,
    queue,
    limit: own,
    preflight,
  });
  const verdict = hazard.verdict;
  if (verdict.kind === 'blocked') {
    return reject('OVERLIMIT_DLQ', verdict.reasons, {
      warnings: bestEffort(registry, ['W-OVERLIMIT']),
      fix: {
        kind: 'delivery-limit-policy',
        queue: queueName,
        limit: -1,
        minimumFinite: verdict.minimumFinite,
      },
    });
  }
  const limit: LimitView =
    verdict.kind === 'unknown' && own.basis === 'finite'
      ? {
          basis: 'finite-unknown',
          state: own.state,
          reasons: [...own.reasons, 'dlx-evidence-unverified'],
        }
      : own;
  if (hazard.gap !== null) gaps.push(hazard.gap);

  // The consumer timeout cell decides which hold formula applies.
  let timeout: CellResolution | null = null;
  if (quorum) {
    timeout = resolveCell(registry, {
      era,
      queueType: 'quorum',
      protocol: 'amqp091',
      action: 'consumer_timeout',
      limitState: own.state,
      delayedRetryMatters: false,
    });
    if (timeout === null) gaps.push('consumer_timeout');
    else if (timeout.gap !== null) gaps.push(timeout.gap);
  }

  // 11. A substituted row is not enough for a run nobody watches.
  if (gaps.length > 0 && !human) return gapRejection();

  // 12. The hold budget.
  const hold = holdBudget({
    ttlMs: queue.ttlMs,
    consumerTimeoutMs: queue.consumerTimeoutMs,
    style: timeoutStyle(timeout?.cell ?? null),
    rttMs: preflight.rttMs,
  });
  if (!hold.ok) return reject('BUDGET_TOO_SMALL', [hold.reason]);

  // 13. The method (A-3 for the HTTP fallback).
  const chosen = chooseMethod({
    registry,
    era,
    preflight,
    limit,
    prefer: req.prefer,
  });
  if (!chosen.ok) return reject('METHOD_UNAVAILABLE', chosen.reasons);
  const method = chosen.method;

  // 14. The caps: the registry's, the method's, the hold budget's and the size of a message.
  const caps = computeCaps({
    registry,
    era,
    queueType: queue.type,
    admin: profile.identity.isAdmin,
    verification: profile.verification,
    requested: req.count,
    maxBytes: req.maxBytes,
    avgBytes: queue.avgBytes,
    holdCount: hold.maxCount,
    methodMax: method === 'http.get_fallback' ? HTTP_FALLBACK_MAX : undefined,
  });
  if (!caps.ok) {
    return caps.reason === 'semantics-gap'
      ? gapRejection()
      : reject('BUDGET_TOO_SMALL', [caps.reason]);
  }

  // 15. The disposition (DC-09): mandatory for a finite or unknown limit.
  const disposition = planDisposition({
    registry,
    era,
    queueType: queue.type,
    queueName,
    limit,
    unknownReason: limit.reasons.some(
      (reason) =>
        reason === 'own-limit-unknown' || reason === 'limit-incoherent',
    )
      ? 'limit-unknown'
      : 'dlx-evidence-unverified',
    requested: req.disposition,
    profile,
    preflight,
    principal,
    nowMs,
  });
  if (!disposition.ok) return disposition.rejection;

  // The plan. Warnings first, from the cells and the facts (R10).
  const ids = new Set<string>(['W-CRASH', 'W-HOLD', 'W-REDELIVERED']);
  if (nackEffect !== null) {
    if (nackEffect.countsTowardLimit === 'yes' && nackEffect.deltaAC === 1) {
      ids.add('W-BUDGET');
    }
    if (nackEffect.deltaDC === 1 && nackEffect.deltaAC === 0) ids.add('W-313');
    if (nackEffect.position === 'tail') ids.add('W-TAIL');
    if (nackEffect.position === 'delayed') ids.add('W-DELAY');
  }
  if (nack?.delayedRetryUnread === true) ids.add('W-DELAY');
  if (queue.ttlMs !== undefined) ids.add('W-TTL');
  if (
    queue.overflow === 'drop-head' &&
    queue.maxLength !== undefined &&
    (queue.ready === undefined ||
      queue.ready + caps.count >= DROP_HEAD_SHARE * queue.maxLength)
  ) {
    ids.add('W-DROPHEAD');
  }
  if (queue.singleActiveConsumer) {
    ids.add(quorum ? 'W-SAC-QQ' : 'W-SAC-CQ');
  }
  if (queue.limitDisagreement !== undefined) ids.add('W-UPGRADED');
  if (profile.versions.mixed) ids.add('W-MIXED');
  if (limit.reasons.includes('dlx-evidence-unverified')) {
    ids.add('W-DLX-UNVERIFIED');
  }
  if (
    limit.reasons.includes('own-limit-unknown') ||
    limit.reasons.includes('limit-incoherent')
  ) {
    ids.add('W-LIMIT-UNKNOWN');
  }
  if (gaps.length > 0) ids.add('W-SEMANTICS-GAP');
  if (profile.verification !== 'verified') ids.add('W-BROKER-UNVERIFIED');

  const warnings: WarningRef[] = [];
  for (const id of ids) {
    try {
      warnings.push(warningRef(registry, id));
    } catch (error) {
      // A warning the registry should define is missing: the plan would be silent about a hazard.
      if (error instanceof SemanticsGapError) return gapRejection();
      throw error;
    }
  }
  const sorted = sortWarnings(warnings);

  const estimated = limit.basis === 'finite-unknown';
  const guardValue = estimated
    ? estimateLimit(visibleLimits(preflight))
    : limit.value;
  const preview: PeekPlanPreview = {
    era,
    verification: profile.verification,
    semanticsVersion: registry.version,
    confidence:
      profile.verification === 'verified'
        ? 'code-derived'
        : 'unverified-version',
    queueType: quorum ? 'quorum' : 'classic',
    method,
    limit: {
      basis: limit.basis,
      ...(guardValue === undefined ? {} : { value: guardValue }),
      estimated,
      reasons: [...limit.reasons],
    },
    caps: {
      requested: caps.requested,
      count: caps.count,
      bytes: caps.bytes,
      limitedBy: caps.limitedBy,
    },
    hold: {
      targetMs: hold.targetMs,
      hardAbortMs: hold.hardAbortMs,
      derivedFrom: [...hold.derivedFrom],
    },
    guard: {
      counter: 'x-delivery-count',
      doomedWhen: doomedOperator(registry, era),
      limit:
        guardValue === undefined
          ? { kind: 'unlimited' }
          : { kind: 'finite', value: guardValue },
      estimated,
      stopAtFirstDoomed: true,
    },
    disposition: disposition.disposition,
    expected:
      nack === null || nackEffect === null
        ? []
        : [{ cell: nack.cell.id, effect: { ...nackEffect } }],
    effects: quorum ? 'registry' : 'not-in-registry',
    evidence: {
      dlx:
        verdict.kind === 'unknown'
          ? 'unknown'
          : verdict.kind === 'safe'
            ? 'safe'
            : 'not-applicable',
      heldDeath: hazard.heldDeath,
    },
    gaps: [...new Set(gaps)].sort(),
    honestLabelKey: HONEST_LABEL_KEY,
  };
  return {
    preview,
    gates: [],
    warnings: sorted,
    consentsRequired: consentIds(sorted, disposition.consents),
  };
}

/** The planner as the interface of core-interfaces.md names it. */
export const peekPlanner = { plan: planPeek } as const;
