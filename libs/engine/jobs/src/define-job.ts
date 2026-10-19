// defineJob: the one way to give a job behaviour (I-2). Like `implementAction`, it checks that the
// declaration is complete enough to be safe and mints the only kind of object the runner accepts.
// The write-capable ports reach a job only through `JobContext.executorWrite`, which the runner
// builds, so a file that defines a job is where `tools/arch-tests` allows write ports to be named.
import type { JobDef } from './types.ts';

const minted = new WeakSet();

/** `module.verb`: lower case letters, digits and `-`, at least one dot, at most 100 characters. */
export const JOB_TYPE_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;

/** True only for an object `defineJob` returned. */
export function isDefinedJob(value: unknown): value is JobDef {
  return typeof value === 'object' && value !== null && minted.has(value);
}

export function defineJob<I, C, O>(def: JobDef<I, C, O>): JobDef<I, C, O> {
  const fail = (message: string): never => {
    throw new TypeError(`defineJob(${def.type}): ${message}`);
  };
  if (
    typeof def.type !== 'string' ||
    def.type.length > 100 ||
    !JOB_TYPE_PATTERN.test(def.type)
  ) {
    fail(
      'type must look like module.verb (lower case, at most 100 characters).',
    );
  }
  if (!Number.isSafeInteger(def.version) || def.version < 1) {
    fail('version must be a positive integer.');
  }
  if (typeof def.resumable !== 'boolean') fail('resumable must be declared.');
  if (typeof def.run !== 'function') fail('run is required.');
  // A job that does not say how to park what it holds would leave deliveries unacknowledged on
  // quit (DC-04), so there is no default.
  if (typeof def.onDrain !== 'function') fail('onDrain is required.');
  for (const schema of ['input', 'checkpoint', 'output'] as const) {
    if (typeof def[schema].safeParse !== 'function') {
      fail(`${schema} must be a zod schema.`);
    }
  }

  const impl: JobDef<I, C, O> = Object.freeze({
    type: def.type,
    version: def.version,
    input: def.input,
    checkpoint: def.checkpoint,
    output: def.output,
    resumable: def.resumable,
    run: def.run.bind(def),
    onDrain: def.onDrain.bind(def),
    ...(def.concurrencyKey === undefined
      ? {}
      : { concurrencyKey: def.concurrencyKey.bind(def) }),
    ...(def.throttle === undefined ? {} : { throttle: def.throttle.bind(def) }),
    ...(def.preflight === undefined
      ? {}
      : { preflight: def.preflight.bind(def) }),
  });
  minted.add(impl);
  return impl;
}
