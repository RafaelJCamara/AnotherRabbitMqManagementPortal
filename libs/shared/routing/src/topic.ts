// Topic exchange matching (M1-02, R2). The routing key is split at `.`, and the EMPTY key has zero
// words (so `a.` has the words `a` and `""`, and `.` has two empty words). In the binding key a
// whole word `*` is exactly one word (an empty word counts) and a whole word `#` is zero or more
// words; any other word, including `a*`, is literal. Every routing key of the message (CC and BCC
// included) is matched on its own.
// RS@v4.3.6:deps/rabbit/src/rabbit_db_topic_exchange.erl split_topic_key_binary/1 L61-73 and the
// trie walk L114-145; RS@v3.13.7 split_topic_key_binary/1 L205 and split_topic_key/1 L185-195.
//
// The broker walks a trie; this is the same relation as a dynamic programme over (pattern word,
// key word), O(pattern words x key words), so no key can make it exponential (R5).
import type { KeyedKey } from './cc-bcc.ts';
import type { MatchRule, TopologyBinding } from './types.ts';

export function splitTopicKey(key: string): string[] {
  return key === '' ? [] : key.split('.');
}

/** The number of whole `#` words of a binding key (the broker's validator counts these). */
export function countHashWords(bindingKey: string): number {
  let count = 0;
  for (const word of splitTopicKey(bindingKey)) if (word === '#') count += 1;
  return count;
}

/** Whether the pattern's words match the key's words. */
export function topicWordsMatch(
  pattern: readonly string[],
  key: readonly string[],
): boolean {
  const n = key.length;
  // next[j]: the pattern words after the current one match the key words from j on.
  let next: boolean[] = new Array<boolean>(n + 1).fill(false);
  next[n] = true;
  for (let i = pattern.length - 1; i >= 0; i -= 1) {
    const word = pattern[i];
    const current: boolean[] = new Array<boolean>(n + 1).fill(false);
    if (word === '#') {
      current[n] = next[n] === true;
      for (let j = n - 1; j >= 0; j -= 1) {
        current[j] = next[j] === true || current[j + 1] === true;
      }
    } else {
      for (let j = 0; j < n; j += 1) {
        current[j] = (word === '*' || word === key[j]) && next[j + 1] === true;
      }
    }
    next = current;
  }
  return next[0] === true;
}

export function topicMatches(pattern: string, key: string): boolean {
  return topicWordsMatch(splitTopicKey(pattern), splitTopicKey(key));
}

export interface TopicOutcome {
  readonly rule: Extract<MatchRule, { kind: 'topic' }> | null;
  /** The pattern or a key had more words than the limit; it was treated as not matching. */
  readonly tooLong: boolean;
}

/**
 * The rule by which the binding's key matches one of the message's keys, or null. A pattern or key
 * with more than `maxWords` words is not matched and is reported as `tooLong` (counted by the
 * caller, I-13).
 */
export function topicRule(
  binding: Pick<TopologyBinding, 'routingKey'>,
  keys: readonly KeyedKey[],
  maxWords: number,
): TopicOutcome {
  const pattern = splitTopicKey(binding.routingKey);
  if (pattern.length > maxWords) return { rule: null, tooLong: true };
  let tooLong = false;
  for (const { key, source } of keys) {
    const words = splitTopicKey(key);
    if (words.length > maxWords) {
      tooLong = true;
      continue;
    }
    if (topicWordsMatch(pattern, words)) {
      return {
        rule: {
          kind: 'topic',
          pattern: binding.routingKey,
          routingKey: key,
          keySource: source,
        },
        tooLong,
      };
    }
  }
  return { rule: null, tooLong };
}
