import {
  defaultRealm,
  type EditorRealm,
  type MonacoEnvironmentLike,
} from './realm';
import { installStyleNonce } from './style-nonce';
import {
  checkWorkerUrl,
  ensureHtmlPolicy,
  ensureWorkerPolicy,
  monacoPolicyHook,
  workerPathFor,
  type PolicyCache,
} from './trusted-types';

interface RealmState {
  readonly policies: PolicyCache;
  nonceHook?: () => void;
  installed: boolean;
}

const REALMS = new WeakMap<object, RealmState>();

/**
 * Puts the three pieces Monaco needs in place, before any Monaco module is evaluated (Monaco reads
 * `MonacoEnvironment` and creates its policies in static initialisers, S-04):
 *
 *  1. the Trusted Types policies `app-worker-url` and `app-monaco-html` (none when the page has no
 *     Trusted Types),
 *  2. `MonacoEnvironment` with `getWorker` and `createTrustedTypesPolicy`,
 *  3. the nonce on every `<style>` element Monaco creates.
 *
 * Idempotent per realm, and safe to call again after a failure: a policy that was created is reused,
 * never created a second time. The CSP is not touched: no `blob:` worker, no `unsafe-eval`.
 */
export function installEditorEnvironment(
  realm: EditorRealm = defaultRealm(),
): void {
  let state = REALMS.get(realm);
  if (state === undefined) {
    state = { policies: {}, installed: false };
    REALMS.set(realm, state);
  }
  if (state.installed) return;

  const factory = realm.trustedTypes;
  const worker =
    factory === undefined
      ? undefined
      : ensureWorkerPolicy(factory, realm.location, state.policies);
  const html =
    factory === undefined
      ? undefined
      : ensureHtmlPolicy(factory, state.policies);

  const environment: MonacoEnvironmentLike = {
    ...realm.MonacoEnvironment,
    getWorker: (_id, label) => {
      const path = workerPathFor(label);
      const url =
        worker === undefined
          ? checkWorkerUrl(path, realm.location)
          : worker.createScriptURL(path);
      return new realm.Worker(url, { type: 'module', name: label });
    },
  };
  if (worker !== undefined && html !== undefined) {
    environment.createTrustedTypesPolicy = monacoPolicyHook(worker, html);
  }
  realm.MonacoEnvironment = environment;
  state.nonceHook ??= installStyleNonce(realm.document);
  state.installed = true;
}
