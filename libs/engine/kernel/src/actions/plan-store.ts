// The PlanStore (blueprint 5.1 step 8 and 6.3): plan lifecycle on top of a `PlanRepository`.
//
//   open ── approved (when approvals are required: awaiting-approval first) ── executing ── executed | failed
//     └──────────────── expired (TTL) · rejected (one reject is a veto) ────────────────┘
//
// - TTL is 5 minutes, or 24 hours while the plan awaits approval; a granted approval restarts a
//   5 minute window for the person who executes.
// - A plan is bound to its requester, its input hash and the BrokerProfile fingerprint, and
//   `digest` covers every bound field. The digest is also sealed inside the encrypted payload, so
//   a row that was edited in the database is detected even though the digest column is plain.
// - The input and the sensitive payload (message bodies) are encrypted at rest with
//   AAD `plans:payload:<id>`, and purged on expiry, rejection and execution. The digest stays.
// - Every state change is a compare-and-set on the row's version, so two concurrent callers
//   cannot both start, approve or finish the same plan.
import {
  WarningRefSchema,
  type ActionId,
  type EnvClass,
  type PlanId,
  type Risk,
  type WarningRef,
} from '@app/contracts';
import type {
  PlanApprovalRecord,
  PlanPatch,
  PlanRecord,
  PlanRepository,
  PlanState,
} from '@app/ports';
import { z } from 'zod';

import type { Clock } from '../clock/clock.ts';
import type { IdGenerator } from '../ids/ids.ts';
import { AppError } from '../problem/problem.ts';
import { decodeValue, encodeValue, hashValue, sha256Hex } from './canonical.ts';
import { GateSchema, type Gate, type PlanView } from './types.ts';

/** Field encryption for plan payloads. M0-22 (`secrets`) implements it with AES-256-GCM. */
export interface PayloadCipher {
  /** `aad` is authenticated, not secret: a ciphertext opened with another `aad` must fail. */
  encrypt(plaintext: Uint8Array, aad: string): Promise<Uint8Array>;
  /** Throws when the ciphertext or the `aad` was changed. */
  decrypt(ciphertext: Uint8Array, aad: string): Promise<Uint8Array>;
}

export interface PlanTtl {
  /** A plan nobody has to approve. Default 5 minutes. */
  interactiveMs: number;
  /** A plan waiting for approval. Default 24 hours. */
  awaitingApprovalMs: number;
  /** The window to execute once the last approval is in. Default 5 minutes. */
  afterApprovalMs: number;
}

export const DEFAULT_PLAN_TTL: PlanTtl = Object.freeze({
  interactiveMs: 5 * 60_000,
  awaitingApprovalMs: 24 * 60 * 60_000,
  afterApprovalMs: 5 * 60_000,
});

export interface PlanStoreOptions {
  repository: PlanRepository;
  cipher: PayloadCipher;
  clock: Clock;
  ids: IdGenerator;
  ttl?: Partial<PlanTtl>;
  /** Plans a principal may have open at once (I-6). Default 100. */
  maxActivePerPrincipal?: number;
  /** Largest sealed input plus payload, in bytes. Default 8 MiB. */
  maxPayloadBytes?: number;
}

export interface NewPlan {
  actionId: ActionId;
  input: unknown;
  sensitivePayload?: unknown;
  principalId: string;
  onBehalfOfId: string | null;
  profileFingerprint: string | null;
  env: EnvClass;
  risk: Risk;
  gates: readonly Gate[];
  warnings: readonly WarningRef[];
  consentsRequired: readonly string[];
  confirmationPhrase: string | null;
  approvalsRequired: number;
  preview: unknown;
}

/** What `open` returns: the plan as callers see it, plus the decrypted input. */
export interface OpenedPlan {
  view: PlanView;
  approvals: readonly PlanApprovalRecord[];
  input: unknown;
  sensitivePayload: unknown;
}

export interface PlanStore {
  create(plan: NewPlan): Promise<PlanView>;
  /** The plan, or undefined; a plan past its TTL is marked expired first. */
  view(id: PlanId): Promise<PlanView | undefined>;
  /** Decrypts and verifies the plan for execution. Throws `PLAN_STALE` when the seal does not hold. */
  open(id: PlanId): Promise<OpenedPlan>;
  approve(
    id: PlanId,
    approverId: string,
    decision: 'approve' | 'reject',
    note?: string,
  ): Promise<PlanView>;
  /** open|approved -> executing, once. Throws when the plan was used, expired or rejected. */
  start(id: PlanId): Promise<PlanView>;
  /** executing -> executed|failed, and purges the payload. */
  finish(id: PlanId, outcome: 'executed' | 'failed'): Promise<void>;
  /** Marks plans past their TTL expired and drops their payload (a scheduled sweep). */
  sweep(limit?: number): Promise<number>;
}

const PAYLOAD_VERSION = 1;
const MAX_NOTE = 500;
const CAS_ATTEMPTS = 5;
const LIVE: ReadonlySet<PlanState> = new Set([
  'open',
  'awaiting-approval',
  'approved',
]);

const WarningsSchema = z.array(WarningRefSchema);
const GatesSchema = z.array(GateSchema);

/** Everything a digest covers. Change it and every existing plan stops verifying. */
export interface DigestFields {
  actionId: ActionId;
  inputHash: string;
  payloadHash: string | null;
  principalId: string;
  onBehalfOfId: string | null;
  profileFingerprint: string | null;
  env: EnvClass;
  risk: Risk;
  approvalsRequired: number;
  confirmationPhrase: string | null;
  consentsRequired: readonly string[];
  gatesJson: string;
  warningsJson: string;
  previewJson: string;
}

export function computePlanDigest(fields: DigestFields): string {
  return hashValue({
    v: PAYLOAD_VERSION,
    ...fields,
    consentsRequired: [...fields.consentsRequired].sort(),
  });
}

const corrupt = (): AppError =>
  new AppError('INTERNAL', { detail: 'A stored plan could not be read.' });

const tampered = (): AppError =>
  new AppError('PLAN_STALE', {
    detail: 'The plan digest does not match; the plan was changed.',
  });

const sealedSchema = z.strictObject({
  v: z.literal(PAYLOAD_VERSION),
  digest: z.string(),
  input: z.unknown(),
  sensitive: z.unknown().optional(),
});

function toView(record: PlanRecord): PlanView {
  let gates: Gate[];
  let warnings: WarningRef[];
  let preview: unknown;
  try {
    gates = GatesSchema.parse(decodeValue(record.gatesJson));
    warnings = WarningsSchema.parse(decodeValue(record.warningsJson));
    preview = decodeValue(record.previewJson);
  } catch {
    throw corrupt();
  }
  return {
    id: record.id,
    actionId: record.actionId,
    digest: record.digest,
    principalId: record.principalId,
    ...(record.onBehalfOfId === null
      ? {}
      : { onBehalfOfId: record.onBehalfOfId }),
    ...(record.profileFingerprint === null
      ? {}
      : { profileFingerprint: record.profileFingerprint }),
    env: record.env,
    risk: record.risk,
    gates,
    warnings,
    consentsRequired: record.consentsRequired,
    ...(record.confirmationPhrase === null
      ? {}
      : { confirmationPhrase: record.confirmationPhrase }),
    approvals: {
      required: record.approvalsRequired,
      granted: record.approvals.map(({ by, at, decision }) => ({
        by,
        at,
        decision,
      })),
    },
    preview,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    state: record.state,
  };
}

type Decision = { patch: PlanPatch } | AppError;

export function createPlanStore(options: PlanStoreOptions): PlanStore {
  const { repository, cipher, clock, ids } = options;
  const ttl: PlanTtl = { ...DEFAULT_PLAN_TTL, ...options.ttl };
  const maxActive = options.maxActivePerPrincipal ?? 100;
  const maxPayload = options.maxPayloadBytes ?? 8 * 1024 * 1024;
  const aadOf = (id: PlanId): string => `plans:payload:${id}`;

  /** The row, with a plan past its TTL turned into an expired one. */
  async function fresh(id: PlanId): Promise<PlanRecord | undefined> {
    const record = await repository.get(id);
    if (
      record === undefined ||
      !LIVE.has(record.state) ||
      clock.now() < record.expiresAt
    ) {
      return record;
    }
    const expired = await repository.update(
      id,
      record.version,
      { state: 'expired', payload: null },
      clock.now(),
    );
    return expired ?? (await repository.get(id));
  }

  // An approval is sealed like the payload: whoever can edit the table but holds no key cannot add
  // one, or change one's decision, approver or digest.
  const approvalAad = (id: PlanId, by: string): string =>
    `plans:approval:${id}:${by}`;
  async function sealApproval(
    id: PlanId,
    by: string,
    decision: 'approve' | 'reject',
    digest: string,
    at: number,
  ): Promise<string> {
    const body = encodeValue({
      v: PAYLOAD_VERSION,
      id,
      by,
      decision,
      digest,
      at,
    });
    const sealed = await cipher.encrypt(
      new TextEncoder().encode(body),
      approvalAad(id, by),
    );
    return Buffer.from(sealed).toString('base64');
  }
  async function approvalHolds(
    id: PlanId,
    approval: PlanApprovalRecord,
  ): Promise<boolean> {
    try {
      const plain = await cipher.decrypt(
        new Uint8Array(Buffer.from(approval.seal, 'base64')),
        approvalAad(id, approval.by),
      );
      return (
        new TextDecoder().decode(plain) ===
        encodeValue({
          v: PAYLOAD_VERSION,
          id,
          by: approval.by,
          decision: approval.decision,
          digest: approval.digest,
          at: approval.at,
        })
      );
    } catch {
      return false;
    }
  }

  const required = async (id: PlanId): Promise<PlanRecord> => {
    const record = await fresh(id);
    if (record === undefined) {
      throw new AppError('NOT_FOUND', { detail: 'Unknown plan.' });
    }
    return record;
  };

  /** Why a plan in `state` cannot be started or decided. */
  function refusalFor(record: PlanRecord): AppError {
    switch (record.state) {
      case 'expired':
        return new AppError('PLAN_EXPIRED', {
          detail: 'The plan has expired.',
        });
      case 'rejected':
        return new AppError('APPROVAL_REQUIRED', {
          detail: 'The plan was rejected.',
        });
      case 'awaiting-approval':
        return new AppError('APPROVAL_REQUIRED', {
          detail: 'The plan is waiting for approval.',
        });
      default:
        return new AppError('PLAN_STALE', {
          detail: 'The plan was already used.',
        });
    }
  }

  /** Re-reads and retries a compare-and-set that lost a race, a few times. */
  async function change(
    id: PlanId,
    decide: (record: PlanRecord) => Promise<Decision> | Decision,
  ): Promise<PlanRecord> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const record = await required(id);
      const decision = await decide(record);
      if (decision instanceof AppError) throw decision;
      const updated = await repository.update(
        id,
        record.version,
        decision.patch,
        clock.now(),
      );
      if (updated !== undefined) return updated;
    }
    throw new AppError('PLAN_STALE', {
      detail: 'The plan is being changed by someone else; try again.',
      retryable: true,
    });
  }

  return {
    async create(plan) {
      const now = clock.now();
      if ((await repository.countActive(plan.principalId, now)) >= maxActive) {
        throw new AppError('BUDGET_EXCEEDED', {
          detail: 'Too many open plans; execute or let some expire.',
          retryable: true,
        });
      }
      const id = ids.planId();

      let inputText: string;
      let gatesJson: string;
      let warningsJson: string;
      let previewJson: string;
      let payloadHash: string | null = null;
      let inputHash: string;
      try {
        inputText = encodeValue(plan.input);
        inputHash = sha256Hex(inputText);
        if (plan.sensitivePayload !== undefined) {
          payloadHash = hashValue(plan.sensitivePayload);
        }
        gatesJson = encodeValue(plan.gates);
        warningsJson = encodeValue(plan.warnings);
        previewJson = encodeValue(plan.preview);
      } catch (cause) {
        throw new AppError('INTERNAL', {
          detail:
            'The plan holds a value that cannot be stored (use JSON values, bigint or bytes).',
          cause,
        });
      }

      const digest = computePlanDigest({
        actionId: plan.actionId,
        inputHash,
        payloadHash,
        principalId: plan.principalId,
        onBehalfOfId: plan.onBehalfOfId,
        profileFingerprint: plan.profileFingerprint,
        env: plan.env,
        risk: plan.risk,
        approvalsRequired: plan.approvalsRequired,
        confirmationPhrase: plan.confirmationPhrase,
        consentsRequired: plan.consentsRequired,
        gatesJson,
        warningsJson,
        previewJson,
      });

      const sealed = encodeValue({
        v: PAYLOAD_VERSION,
        digest,
        input: plan.input,
        sensitive: plan.sensitivePayload,
      });
      const plaintext = new TextEncoder().encode(sealed);
      if (plaintext.byteLength > maxPayload) {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'The plan payload is too large.',
          status: 413,
        });
      }
      const payload = await cipher.encrypt(plaintext, aadOf(id));

      const awaiting = plan.approvalsRequired > 0;
      const record: PlanRecord = {
        id,
        actionId: plan.actionId,
        inputHash,
        digest,
        principalId: plan.principalId,
        onBehalfOfId: plan.onBehalfOfId,
        profileFingerprint: plan.profileFingerprint,
        env: plan.env,
        risk: plan.risk,
        state: awaiting ? 'awaiting-approval' : 'open',
        approvalsRequired: plan.approvalsRequired,
        approvals: [],
        gatesJson,
        warningsJson,
        previewJson,
        consentsRequired: [...plan.consentsRequired],
        confirmationPhrase: plan.confirmationPhrase,
        payload,
        expiresAt:
          now + (awaiting ? ttl.awaitingApprovalMs : ttl.interactiveMs),
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      await repository.insert(record);
      return toView(record);
    },

    async view(id) {
      const record = await fresh(id);
      return record === undefined ? undefined : toView(record);
    },

    async open(id) {
      const record = await required(id);
      if (!LIVE.has(record.state)) throw refusalFor(record);
      if (record.payload === null) throw tampered();

      let opened: z.infer<typeof sealedSchema>;
      try {
        const plaintext = await cipher.decrypt(record.payload, aadOf(id));
        opened = sealedSchema.parse(
          decodeValue(new TextDecoder().decode(plaintext)),
        );
      } catch {
        // Wrong key, a changed row or a changed id: all the same to the caller.
        throw tampered();
      }
      let recomputed: string;
      try {
        recomputed = computePlanDigest({
          actionId: record.actionId,
          inputHash: hashValue(opened.input),
          payloadHash:
            opened.sensitive === undefined ? null : hashValue(opened.sensitive),
          principalId: record.principalId,
          onBehalfOfId: record.onBehalfOfId,
          profileFingerprint: record.profileFingerprint,
          env: record.env,
          risk: record.risk,
          approvalsRequired: record.approvalsRequired,
          confirmationPhrase: record.confirmationPhrase,
          consentsRequired: record.consentsRequired,
          gatesJson: record.gatesJson,
          warningsJson: record.warningsJson,
          previewJson: record.previewJson,
        });
      } catch {
        throw tampered();
      }
      if (
        recomputed !== record.digest ||
        opened.digest !== record.digest ||
        hashValue(opened.input) !== record.inputHash
      ) {
        throw tampered();
      }
      for (const approval of record.approvals) {
        if (!(await approvalHolds(id, approval))) throw tampered();
      }
      return {
        view: toView(record),
        approvals: record.approvals,
        input: opened.input,
        sensitivePayload: opened.sensitive,
      };
    },

    async approve(id, approverId, decision, note) {
      if (note !== undefined && note.length > MAX_NOTE) {
        throw new AppError('VALIDATION_FAILED', {
          detail: `The note is longer than ${String(MAX_NOTE)} characters.`,
        });
      }
      const updated = await change(id, async (record) => {
        if (record.state !== 'awaiting-approval') return refusalFor(record);
        if (
          approverId === record.principalId ||
          approverId === record.onBehalfOfId
        ) {
          return new AppError('FORBIDDEN_RBAC', {
            detail: 'An approver must differ from the requester.',
          });
        }
        if (record.approvals.some((entry) => entry.by === approverId)) {
          return new AppError('VALIDATION_FAILED', {
            detail: 'This approver already decided.',
            status: 409,
          });
        }
        const now = clock.now();
        const entry: PlanApprovalRecord = {
          by: approverId,
          at: now,
          decision,
          digest: record.digest,
          seal: await sealApproval(
            id,
            approverId,
            decision,
            record.digest,
            now,
          ),
          ...(note === undefined ? {} : { note }),
        };
        const approvals = [...record.approvals, entry];
        if (decision === 'reject') {
          return { patch: { state: 'rejected', approvals, payload: null } };
        }
        const granted = new Set(
          approvals
            .filter(
              (item) =>
                item.decision === 'approve' && item.digest === record.digest,
            )
            .map((item) => item.by),
        );
        return granted.size >= record.approvalsRequired
          ? {
              patch: {
                state: 'approved',
                approvals,
                expiresAt: now + ttl.afterApprovalMs,
              },
            }
          : { patch: { approvals } };
      });
      return toView(updated);
    },

    async start(id) {
      const updated = await change(id, (record) =>
        record.state === 'open' || record.state === 'approved'
          ? { patch: { state: 'executing' } }
          : refusalFor(record),
      );
      return toView(updated);
    },

    async finish(id, outcome) {
      await change(id, (record) =>
        record.state === 'executing'
          ? { patch: { state: outcome, payload: null } }
          : new AppError('PLAN_STALE', {
              detail: 'The plan is not executing.',
            }),
      );
    },

    sweep: (limit = 500) => repository.expireDue(clock.now(), limit),
  };
}
