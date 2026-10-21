// Schemas without generated code, where Trusted Types apply. By default zod probes `new Function('')`
// whenever it builds an object schema, to see whether it may compile a faster parser. Under
// `require-trusted-types-for 'script'` (S-04) that probe is a TrustedScript sink: the page is refused
// it and the browser reports a violation, even though zod catches the error (issue #277). With
// `jitless` zod skips the probe and takes its plain parser. `unsafe-eval` is never the answer.
//
// The switch must be thrown before the first object schema is built, so it is the first import of
// the package index (`no-dynamic-code-init.ts`) and, in the web app, the first import of main.ts.
import { z } from 'zod';

/** True in a browser that has the Trusted Types API (the engine's Node has none). */
export function hasTrustedTypes(scope: object = globalThis): boolean {
  return 'trustedTypes' in scope;
}

/** Switches zod's code generation off for this realm, if Trusted Types apply to it. Idempotent. */
export function forbidDynamicCodeUnderTrustedTypes(
  scope: object = globalThis,
): boolean {
  if (!hasTrustedTypes(scope)) return false;
  z.config({ jitless: true });
  return true;
}
