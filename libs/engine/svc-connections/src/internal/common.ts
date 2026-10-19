// What every action of this service shares: plans for commands that depend on nothing they read,
// visibility, and sealing and opening the secrets of a profile.
import { AppError, type PlanDraft } from '@app/kernel';
import type {
  ConnectionRecord,
  ConnectionStore,
  CredentialChange,
  CredentialProtocol,
  FieldSealer,
} from '@app/ports';

import type { Resolved } from './endpoints';

/** A plan with no gates, warnings or consents: a draft of what the command will do. */
export function plainPlan<P>(preview: P): () => Promise<PlanDraft<P>> {
  return () =>
    Promise.resolve({
      preview,
      gates: [],
      warnings: [],
      consentsRequired: [],
    });
}

/** The TOCTOU re-check of a command that depends on nothing it read. */
export const alwaysValid = (): Promise<'valid'> => Promise.resolve('valid');

/** A profile is visible to its owner, and to everyone when it is shared with the team. */
export function isVisible(
  record: ConnectionRecord,
  principalId: string,
): boolean {
  return record.visibility === 'team' || record.ownerId === principalId;
}

/**
 * The profile, or NOT_FOUND. A profile someone else keeps private is reported exactly like one that
 * does not exist, so ids cannot be probed.
 */
export async function loadVisible(
  store: ConnectionStore,
  cid: string,
  principalId: string,
): Promise<ConnectionRecord> {
  const record = await store.get(cid);
  if (record === undefined || !isVisible(record, principalId)) {
    throw new AppError('NOT_FOUND', { detail: 'There is no such connection.' });
  }
  return record;
}

/** Only the owner changes a profile; anyone who cannot see it gets NOT_FOUND first. */
export async function loadEditable(
  store: ConnectionStore,
  cid: string,
  principalId: string,
): Promise<ConnectionRecord> {
  const record = await loadVisible(store, cid, principalId);
  if (record.ownerId !== principalId) {
    throw new AppError('FORBIDDEN_RBAC', {
      detail: 'Only the owner of a connection can change or delete it.',
    });
  }
  return record;
}

const TABLE = 'credentials';
const COLUMN = 'ciphertext';

/** The place a secret lives in: part of its authenticated data, so a copy elsewhere does not open. */
const rowId = (cid: string, protocol: CredentialProtocol): string =>
  `${cid}:${protocol}`;

export async function sealSecret(
  sealer: FieldSealer,
  cid: string,
  protocol: CredentialProtocol,
  secret: string,
): Promise<Uint8Array> {
  const plaintext = Buffer.from(secret, 'utf8');
  try {
    return await sealer.seal(TABLE, COLUMN, rowId(cid, protocol), plaintext);
  } catch {
    // The vault is locked or sealing failed: nothing was stored. The cause names no secret, but it
    // is not ours to describe either.
    throw new AppError('GATE_BLOCKED', {
      detail:
        'The credential vault is locked, so a secret cannot be stored. Unlock it and try again.',
    });
  } finally {
    plaintext.fill(0);
  }
}

/** The secret, or undefined when it cannot be opened (a locked vault, a changed or moved row). */
export async function openSecret(
  sealer: FieldSealer,
  cid: string,
  protocol: CredentialProtocol,
  sealed: Uint8Array,
): Promise<string | undefined> {
  try {
    const plaintext = await sealer.open(
      TABLE,
      COLUMN,
      rowId(cid, protocol),
      sealed,
    );
    const text = Buffer.from(plaintext).toString('utf8');
    plaintext.fill(0);
    return text;
  } catch {
    return undefined;
  }
}

/** Seals what a save puts, and names what it removes; a secret that is kept is not touched. */
export async function toCredentialChange(
  sealer: FieldSealer,
  cid: string,
  secrets: Resolved['secrets'],
): Promise<CredentialChange> {
  const put: Partial<Record<CredentialProtocol, Uint8Array>> = {};
  const remove: CredentialProtocol[] = [];
  for (const protocol of ['http', 'amqp'] as const) {
    const change = secrets[protocol];
    if (change === 'remove') remove.push(protocol);
    else if (change !== 'keep') {
      put[protocol] = await sealSecret(sealer, cid, protocol, change.put);
    }
  }
  return { put, remove };
}
