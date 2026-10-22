// The connection switcher's question (M1-42, R4): does the address the person is on exist on the other
// connection? The switcher carries an address over only when the answer is yes, and otherwise opens the
// explorer of the other connection with a notice. The answer is `false` only when the other connection's
// inventory is live and complete and does not hold the object. When the feature cannot know (the inventory is
// loading or partial, the connection was never probed, a read failed, the deadline passed) it answers `true`:
// the address is carried over and the page there says what it knows. An address that is not an entity address
// keeps the switcher's own default (no).
import {
  lookupEntity,
  parseEntityPath,
  type ExplorerData,
} from '@app/explorer-model';

/** How long the question may take before "I cannot know" (and so "carry it over"). */
export const ADDRESS_EXISTS_DEADLINE_MS = 5_000;

export interface AddressExistsOptions {
  readonly deadlineMs?: number;
  /** Runs a callback later and returns how to cancel it; a spec drives its own clock. */
  readonly after?: (callback: () => void, ms: number) => () => void;
}

const later = (callback: () => void, ms: number): (() => void) => {
  const handle = setTimeout(callback, ms);
  return () => {
    clearTimeout(handle);
  };
};

/** `address` is the part under `/c/<cid>`, with its query: `/queues/<key>/routing?x=1`. */
export async function addressExists(
  data: ExplorerData,
  cid: string,
  address: string,
  options: AddressExistsOptions = {},
): Promise<boolean> {
  const parsed = parseEntityPath(address);
  if (parsed === null) return false;
  const controller = new AbortController();
  const cancel = (options.after ?? later)(() => {
    controller.abort();
  }, options.deadlineMs ?? ADDRESS_EXISTS_DEADLINE_MS);
  try {
    const answer = await lookupEntity(
      data,
      { cid, kind: parsed.ref.kind, key: parsed.ref.key },
      controller.signal,
    );
    return answer !== 'absent';
  } finally {
    cancel();
  }
}
