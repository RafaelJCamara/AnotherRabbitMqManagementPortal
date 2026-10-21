// Issue #277: under Trusted Types, zod's `new Function('')` probe is refused and reported. zod
// runs the probe when an object schema is built, so the switch has to come first. This file stubs
// the browser's `trustedTypes`, counts the `Function` constructions, and imports the package index
// as the app does. One spec file is one module realm, so zod's cached probe result is not shared
// with other specs.
import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  forbidDynamicCodeUnderTrustedTypes,
  hasTrustedTypes,
} from './no-dynamic-code.ts';

const probes: unknown[][] = [];
const RealFunction = globalThis.Function;
vi.stubGlobal('trustedTypes', {});
vi.stubGlobal(
  'Function',
  new Proxy(RealFunction, {
    construct(target, args: unknown[]) {
      probes.push(args);
      return Reflect.construct(target, args) as object;
    },
  }),
);
afterAll(() => {
  vi.unstubAllGlobals();
});

describe('zod under Trusted Types', () => {
  it('AC-1 (#277) importing the package index never constructs a Function, and its schemas still parse', async () => {
    const { registry } = await import('../index.ts');
    const { z } = await import('zod');

    const schema = z.object({ a: z.string(), b: z.array(z.number()) });
    const parsed = schema.parse({ a: 'x', b: [1, 2] });
    const failed = schema.safeParse({ a: 1 });

    expect(Object.keys(registry).length).toBeGreaterThan(0);
    expect(parsed).toEqual({ a: 'x', b: [1, 2] });
    expect(failed.success).toBe(false);
    expect(z.config().jitless).toBe(true);
    expect(probes).toEqual([]);
  });

  it('AC-1 (#277) only a realm with the Trusted Types API is switched, and the switch is idempotent', () => {
    expect(hasTrustedTypes({})).toBe(false);
    expect(hasTrustedTypes({ trustedTypes: {} })).toBe(true);
    expect(forbidDynamicCodeUnderTrustedTypes({})).toBe(false);
    expect(forbidDynamicCodeUnderTrustedTypes({ trustedTypes: {} })).toBe(true);
    expect(forbidDynamicCodeUnderTrustedTypes({ trustedTypes: {} })).toBe(true);
    expect(probes).toEqual([]);
  });
});
