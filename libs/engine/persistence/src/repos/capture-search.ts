// User text for the capture index (M1-09). A person types words; the index has a query syntax
// (operators, quotes, column filters, NEAR) that must never be reachable from that text: a stray
// quote would be a syntax error, and an operator would change what is searched. So the text is cut
// into words (letters and digits, in any script), at most `MAX_TERMS` of them, and each word becomes
// a quoted term; a word that ends with `*` in the text is a prefix. All terms must match (AND).

/** The most words one query uses; the rest are ignored. */
export const MAX_TERMS = 16;
/** The longest word kept (longer words are cut). */
export const MAX_TERM_CHARS = 64;

export interface SearchTerm {
  /** Lower-case letters and digits only. */
  readonly word: string;
  readonly prefix: boolean;
}

/** The words of a query; empty when the text holds no letter or digit. */
export function searchTerms(text: string): readonly SearchTerm[] {
  const found = text.slice(0, 2048).match(/[\p{L}\p{N}]+\*?/gu) ?? [];
  const terms: SearchTerm[] = [];
  for (const raw of found) {
    if (terms.length >= MAX_TERMS) break;
    const prefix = raw.endsWith('*');
    const word = (prefix ? raw.slice(0, -1) : raw)
      .toLowerCase()
      .slice(0, MAX_TERM_CHARS);
    terms.push({ word, prefix });
  }
  return terms;
}

/** An FTS5 `MATCH` expression: every term quoted, prefixes with a star after the quote. */
export function toFtsMatch(terms: readonly SearchTerm[]): string {
  return terms.map((t) => `"${t.word}"${t.prefix ? '*' : ''}`).join(' AND ');
}

/** A Postgres `to_tsquery('simple', ...)` expression: quoted lexemes, `:*` for a prefix. */
export function toTsQuery(terms: readonly SearchTerm[]): string {
  return terms.map((t) => `'${t.word}'${t.prefix ? ':*' : ''}`).join(' & ');
}
