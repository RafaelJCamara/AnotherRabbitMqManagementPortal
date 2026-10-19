// The KeyWrap port and the shapes around it (blueprint 6.4, ADR-014). A wrap protects a data key
// (DEK) with something that lives elsewhere than the database: a KEK file, a passphrase, the OS
// keyring, or the desktop main process. The vault asks a wrap to `wrap` a fresh DEK and stores only
// what comes back; it asks again to `unwrap` at start. The vault never writes a DEK anywhere
// itself, and what a wrap returns for storage is sealed (no DEK is stored unwrapped).
import type { DataKeyWrapKind } from '@app/ports';

export type WrapKind = DataKeyWrapKind;

/** What a stored wrap is bound to; wraps put it in the authenticated data of the wrap itself. */
export interface WrapBinding {
  /** What the key is for (`main`). A lowercase identifier. */
  readonly purpose: string;
  /** The id of the data key: 32 lowercase hex characters. */
  readonly dekId: string;
}

/** Input a person or the desktop main process supplies; a wrap uses what it needs and ignores the rest. */
export interface WrapInput {
  /** The master password or UI passphrase. Used by the `passphrase` wrap. */
  readonly passphrase?: string;
  /** A 32-byte data key delivered by the desktop main process (`ctl:init`). Used by `ctl-delivered`. */
  readonly dek?: Uint8Array;
}

export type WrapParamValue = string | number;

/** What a wrap hands back for storage: non-secret parameters plus the sealed bytes. */
export interface WrappedKey {
  readonly params: Readonly<Record<string, WrapParamValue>>;
  readonly bytes: Uint8Array;
}

export type WrapStatus =
  | { readonly state: 'ready' }
  /** Usable once the person (or main) supplies this. */
  | { readonly state: 'needs-input'; readonly input: 'passphrase' | 'dek' }
  /** Cannot protect a key on this machine; `reason` is a stable, secret-free token. */
  | { readonly state: 'unavailable'; readonly reason: string };

export interface KeyWrap {
  readonly kind: WrapKind;
  /**
   * `engine`: the vault generates the DEK and has the wrap seal it. `delivered`: the DEK comes from
   * outside (`input.dek`), and the wrap only records that it was seen (a key check value).
   */
  readonly origin: 'engine' | 'delivered';
  status(input?: WrapInput): Promise<WrapStatus>;
  /** Seals `dek`. Rejects with a `SecretsError` when the wrap is not usable with `input`. */
  wrap(
    dek: Uint8Array,
    binding: WrapBinding,
    input?: WrapInput,
  ): Promise<WrappedKey>;
  /** Returns the DEK. Rejects with `UNWRAP_FAILED` (or a more specific code) when it does not open. */
  unwrap(
    wrapped: WrappedKey,
    binding: WrapBinding,
    input?: WrapInput,
  ): Promise<Uint8Array>;
}

/** The data keys a cipher may use: the one to seal with and any (retired ones included) to open with. */
export interface KeyRing {
  /** The key new data is sealed under. Throws `VAULT_LOCKED` when there is none. */
  current(): { readonly id: string; readonly key: Uint8Array };
  /** The key with this id, or undefined. */
  byId(id: string): Uint8Array | undefined;
}
