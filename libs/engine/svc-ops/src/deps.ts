import type { BrokerProfile } from '@app/domain-model';
import type { Clock } from '@app/kernel';
import type { AuditRepository } from '@app/ports';

/** The newest log lines the engine still holds, and what it had to let go. */
export interface LogTail {
  /** At most `maxLines` of the newest lines, oldest first. */
  tail(maxLines: number): {
    readonly lines: readonly string[];
    /** Lines held right now, so a caller can tell that `lines` is not all of them. */
    readonly held: number;
    /** Lines evicted since the engine started (the ring is bounded, I-6). */
    readonly dropped: number;
  };
}

/**
 * Where a bundle goes. The token is the one `PlatformBridge.pickSaveTarget` returned; only the
 * host side knows the path (blueprint 3.3), so this module never sees one. An unknown or spent
 * token is answered, not thrown, so that no path can leak through an error message.
 */
export interface FileTokenSink {
  write(
    fileToken: string,
    data: Uint8Array,
  ): Promise<'written' | 'unknown-token'>;
}

/** What a diagnostics bundle is made from. Everything read here is scrubbed before it is written. */
export interface DiagnosticsSources {
  /** Product, runtime and schema versions (strings only). */
  versions(): Readonly<Record<string, string>>;
  readonly logs: LogTail;
  /** The probed profile of each known broker, at most `limit`. */
  profiles(limit: number): Promise<readonly BrokerProfile[]>;
  /** The audit chain: only its head and a window are read. */
  readonly audit: Pick<AuditRepository, 'head' | 'window'>;
  /**
   * Secret values the engine holds right now (a launch token, a carrier secret). Each is removed
   * from the bundle wherever it appears, in any string or key, whether or not it looks like a
   * secret. Any non-empty value counts, however short.
   */
  secretValues(): readonly string[];
}

/** The ports this module needs, injected by the composition root. */
export interface OpsModuleDeps {
  readonly diagnostics: DiagnosticsSources;
  readonly files: FileTokenSink;
  /** The engine's clock: the creation time, and the time slices that keep the event loop free. */
  readonly clock: Clock;
}
