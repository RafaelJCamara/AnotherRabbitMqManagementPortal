/**
 * The parts of the browser the editor environment touches, as small interfaces. The default realm is
 * the page (`globalThis`); specs pass a fake. Nothing here imports Monaco.
 */

/** The rules of a Trusted Types policy that the environment uses. */
export interface TrustedPolicyRules {
  createHTML?: (input: string, ...args: unknown[]) => string;
  createScriptURL?: (input: string, ...args: unknown[]) => string;
}

/** What `trustedTypes.createPolicy` returns; the minted values are opaque to this library. */
export interface TrustedPolicyLike {
  createHTML(input: string, ...args: unknown[]): unknown;
  createScriptURL(input: string, ...args: unknown[]): unknown;
}

export interface TrustedTypesFactoryLike {
  createPolicy(name: string, rules: TrustedPolicyRules): TrustedPolicyLike;
}

/** The slice of `document` the `<style>` nonce hook needs. */
export interface StyleDocumentLike {
  querySelector(selector: string): { readonly content?: string } | null;
  createElement(tagName: string, ...rest: unknown[]): unknown;
}

export interface WorkerOptionsLike {
  readonly type: 'module';
  readonly name: string;
}

export type WorkerConstructorLike = new (
  url: unknown,
  options?: WorkerOptionsLike,
) => unknown;

/** What Monaco asks `MonacoEnvironment.createTrustedTypesPolicy` for. */
export interface MonacoPolicyRequest {
  createHTML?: (input: string, ...args: unknown[]) => string;
  createScriptURL?: (input: string, ...args: unknown[]) => string;
}

export interface MonacoPolicyResult {
  createHTML?: (input: string, ...args: unknown[]) => unknown;
  createScriptURL?: (input: string, ...args: unknown[]) => unknown;
}

/** The global Monaco reads while its modules are evaluated. */
export interface MonacoEnvironmentLike {
  getWorker?: (id: string, label: string) => unknown;
  createTrustedTypesPolicy?: (
    name: string,
    options?: MonacoPolicyRequest,
  ) => MonacoPolicyResult | undefined;
  [key: string]: unknown;
}

export interface EditorRealm {
  readonly trustedTypes?: TrustedTypesFactoryLike | undefined;
  readonly document: StyleDocumentLike;
  readonly location: { readonly href: string; readonly origin: string };
  readonly Worker: WorkerConstructorLike;
  MonacoEnvironment?: MonacoEnvironmentLike | undefined;
}

/** The page the code runs in. */
export function defaultRealm(): EditorRealm {
  return globalThis as unknown as EditorRealm;
}
