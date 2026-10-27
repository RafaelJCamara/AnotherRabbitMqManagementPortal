// The drafts of the studio, one per connection, in memory only (R7, OQ-1518). A draft survives leaving the page
// and coming back; it does not survive a reload, and it is never written to storage, the address, a tab label or
// a log: headers and properties are typed in clear and can hold a secret.
import { Injectable, signal, type WritableSignal } from '@angular/core';

import { emptyDraft, type PublishDraft } from './draft';
import { DRAFT_STORE_MAX } from './limits';

@Injectable({ providedIn: 'root' })
export class DraftStore {
  readonly #drafts = new Map<string, WritableSignal<PublishDraft>>();

  /** The draft of a connection; a connection never seen has an empty one. The oldest draft goes past the bound. */
  draft(cid: string): WritableSignal<PublishDraft> {
    const known = this.#drafts.get(cid);
    if (known !== undefined) {
      this.#drafts.delete(cid); // most recently used last
      this.#drafts.set(cid, known);
      return known;
    }
    const fresh = signal(emptyDraft());
    this.#drafts.set(cid, fresh);
    for (const oldest of this.#drafts.keys()) {
      if (this.#drafts.size <= DRAFT_STORE_MAX) break;
      this.#drafts.delete(oldest);
    }
    return fresh;
  }
}
