// How many keys one `explorer.window` subscription may name (M0-54, R3, Q-6). The hub closes the
// whole connection when a client frame is over 64 KiB (code 1009), and a real key for a 255-character
// vhost and name is 682 characters, so 500 such keys would be about 340 KB. The keys of one `sub`
// therefore stay inside a byte budget as well as a count; what does not fit is counted and said.
import { SUB_KEYS_MAX } from './inventory-model';

/** The key text of one subscription, in bytes (each key counted as its length plus 3 for quotes and comma). */
export const SUB_KEYS_BYTES_MAX = 48 * 1024;
/** The contract's own bound on one key; a longer one cannot be a row key and is never sent. */
export const SUB_KEY_LENGTH_MAX = 1024;

export interface FittedKeys {
  /** The ids that fit, in the order they were given (screen order). */
  readonly keys: string[];
  /** The ids left out: the earliest ids on screen are kept. */
  readonly unfollowed: number;
}

/** Keeps the earliest ids that fit the byte budget and the key count; counts the rest. */
export function fitKeys(ids: readonly string[]): FittedKeys {
  const keys: string[] = [];
  let bytes = 0;
  for (const id of ids) {
    if (id.length > SUB_KEY_LENGTH_MAX) continue; // not a row key: counted as left out, never sent
    const cost = id.length + 3;
    if (keys.length >= SUB_KEYS_MAX || bytes + cost > SUB_KEYS_BYTES_MAX) {
      // Everything after the first key that does not fit is left out too: a screen is read top down.
      break;
    }
    keys.push(id);
    bytes += cost;
  }
  return { keys, unfollowed: ids.length - keys.length };
}
