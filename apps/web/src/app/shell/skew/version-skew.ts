import { Injectable, computed, inject, linkedSignal } from '@angular/core';
import { LiveClient } from '@app/ui-data';

/**
 * Whether this page is older than the engine it talks to (blueprint 3.7, AC-14). The page's
 * version is the first engine version the live session reported; the engine is newer (or at
 * least different) when a later session reports another one, or when it says `goaway` with
 * `version-mismatch`. Local builds report the same version on both sides, so nothing shows
 * there (OQ-532: the options for a build-time constant are still open).
 */
@Injectable({ providedIn: 'root' })
export class VersionSkew {
  readonly #live = inject(LiveClient);

  /** The first version seen; later ones never replace it. */
  readonly loadedVersion = linkedSignal<string | undefined, string | undefined>(
    {
      source: this.#live.engineVersion,
      computation: (current, previous) => previous?.value ?? current,
    },
  );

  readonly mismatch = computed(() => {
    if (this.#live.goaway()?.reason === 'version-mismatch') return true;
    const loaded = this.loadedVersion();
    const now = this.#live.engineVersion();
    return loaded !== undefined && now !== undefined && loaded !== now;
  });
}
