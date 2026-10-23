// The bounds of the normaliser (I-6). A message header table is limited by the frame size, but the
// input here is whatever a client library or a stored capture hands over, so every loop and every
// string has its own limit, and what is cut is counted and reported (I-13).
export const LIMITS = {
  /** Death records read from one array; the rest is counted in `truncation.entriesDropped`. */
  maxEntries: 128,
  /** Routing keys read from one record. */
  maxRoutingKeys: 32,
  /** Characters kept of one queue, exchange, reason or routing-key text (names are at most 255 bytes). */
  maxTextChars: 512,
  /** Characters kept over the whole history; once spent, further texts are empty and counted. */
  maxTotalChars: 65_536,
  /** The last instant a timestamp may name (9999-12-31T23:59:59.999Z); beyond it the unit is wrong. */
  maxTimeMs: 253_402_300_799_999,
} as const;
