import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { emitOpenApi } from './emit/openapi.ts';
import { defineAction } from './kit/define-action.ts';
import { defineTopic } from './kit/define-topic.ts';
import { checkRegistry, type Registry } from './kit/invariants.ts';
import {
  containsWriteOnly,
  hasSecretField,
  SECRET_MAX_CHARS,
  SecretStatusSchema,
  secretInput,
} from './secret.ts';

const Cid = z.string().min(1);

/** A connection-save command: the password goes in, and only its status comes out. */
function saveCredentials(over: Record<string, unknown> = {}) {
  return defineAction({
    id: 'connections.save-credentials',
    kind: 'command',
    summary: 'Save the credentials of a connection',
    input: z.strictObject({
      cid: Cid,
      user: z.string(),
      password: secretInput(),
    }),
    output: z.strictObject({ password: SecretStatusSchema }),
    permission: 'connections.write',
    risk: 'medium',
    planning: 'none',
    audit: 'attempt+outcome',
    target: () => ({}),
    http: { method: 'PUT', path: '/connections/{cid}/credentials' },
    since: '1.0',
    ...over,
  });
}

const registryOf = (
  actions: Registry['actions'],
  topics: Registry['topics'] = [],
): Registry => ({ actions, topics });

const violations = (r: Registry) =>
  checkRegistry(r).filter((v) => v.rule === 'secret-write-only');

describe('write-only secret fields (I-10)', () => {
  it('AC-1 secret: a secret in a PUT body and only its status in the output is sound', () => {
    expect(checkRegistry(registryOf([saveCredentials()]))).toEqual([]);
  });

  it('marks the field writeOnly in the schema and bounds it', () => {
    const schema = z.toJSONSchema(secretInput(), { io: 'input' });
    expect(schema).toMatchObject({
      type: 'string',
      writeOnly: true,
      format: 'password',
      minLength: 1,
      maxLength: SECRET_MAX_CHARS,
    });
    expect(secretInput().safeParse('').success).toBe(false);
    expect(
      secretInput().safeParse('x'.repeat(SECRET_MAX_CHARS + 1)).success,
    ).toBe(false);
    expect(secretInput().safeParse('x'.repeat(SECRET_MAX_CHARS)).success).toBe(
      true,
    );
  });

  it('AC-1 secret: an output that returns the secret is rejected', () => {
    const leaky = saveCredentials({
      output: z.strictObject({ password: secretInput() }),
    });
    expect(violations(registryOf([leaky]))).toHaveLength(1);
  });

  it('AC-1 secret: a secret nested deep in an output, in an array or a union, is still found', () => {
    const outputs = [
      z.strictObject({ a: z.strictObject({ b: z.array(secretInput()) }) }),
      z.strictObject({ a: z.union([z.string(), secretInput()]) }),
      z.strictObject({ a: secretInput().optional() }),
      z.strictObject({ a: secretInput().nullable() }),
      z.strictObject({ a: z.record(z.string(), secretInput()) }),
      z.strictObject({ a: secretInput().default('x') }),
    ];
    for (const [index, output] of outputs.entries()) {
      expect(
        violations(registryOf([saveCredentials({ output })])),
        `output shape ${String(index)}`,
      ).toHaveLength(1);
    }
  });

  it('AC-1 secret: a secret in the path or in a GET query would end up in a URL and is rejected', () => {
    const inPath = saveCredentials({
      input: z.strictObject({ cid: secretInput(), password: secretInput() }),
    });
    expect(violations(registryOf([inPath])).length).toBeGreaterThan(0);

    const inQuery = defineAction({
      id: 'connections.check',
      kind: 'query',
      summary: 'Check a password',
      input: z.strictObject({ cid: Cid, password: secretInput() }),
      output: z.strictObject({ ok: z.boolean() }),
      permission: 'connections.read',
      risk: 'none',
      planning: 'none',
      audit: 'none',
      target: () => ({}),
      http: { method: 'GET', path: '/connections/{cid}/check' },
      since: '1.0',
    });
    expect(violations(registryOf([inQuery]))).toHaveLength(1);
  });

  it('AC-1 secret: a secret in the params or an item of a topic is rejected', () => {
    const topic = (params: z.ZodType, item: z.ZodType) =>
      defineTopic({
        id: 'connections.state',
        params,
        item,
        qos: 'latest',
        flow: 'snapshot-delta',
        permission: 'connections.read',
        key: () => 'k',
        ring: { items: 10, bytes: 1000 },
      });
    const fine = topic(
      z.strictObject({ cid: Cid }),
      z.strictObject({ up: z.boolean() }),
    );
    expect(violations(registryOf([], [fine]))).toEqual([]);
    for (const bad of [
      topic(z.strictObject({ token: secretInput() }), z.strictObject({})),
      topic(z.strictObject({}), z.strictObject({ token: secretInput() })),
    ]) {
      expect(violations(registryOf([], [bad]))).toHaveLength(1);
    }
  });

  it('the committed registry has no secret in an output, a topic or a URL', () => {
    // The registry holds no secret field yet; this keeps the rule honest once one is added.
    expect(violations(registryOf([]))).toEqual([]);
  });

  it('AC-1 secret: the emitted OpenAPI marks the request body field writeOnly and keeps it out of responses', () => {
    const document = JSON.stringify(
      emitOpenApi(registryOf([saveCredentials()])),
    );
    const parsed = JSON.parse(document) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const operation = parsed.paths['/connections/{cid}/credentials']?.put;
    const body = JSON.stringify(operation?.requestBody);
    const responses = JSON.stringify(operation?.responses);
    expect(body).toContain('"writeOnly":true');
    expect(responses).not.toContain('writeOnly');
  });

  it('containsWriteOnly and hasSecretField', () => {
    expect(containsWriteOnly({ a: [{ b: { writeOnly: true } }] })).toBe(true);
    expect(containsWriteOnly({ a: { writeOnly: false } })).toBe(false);
    expect(containsWriteOnly(null)).toBe(false);
    expect(containsWriteOnly('writeOnly')).toBe(false);
    expect(hasSecretField(z.strictObject({ p: secretInput() }), 'input')).toBe(
      true,
    );
    expect(hasSecretField(z.strictObject({ p: z.string() }), 'input')).toBe(
      false,
    );
    // A schema zod cannot express in JSON Schema does not make the check throw.
    expect(hasSecretField(z.strictObject({ at: z.date() }), 'output')).toBe(
      false,
    );
  });

  it('SecretStatus says whether a secret is set and nothing else', () => {
    expect(
      SecretStatusSchema.safeParse({ isSet: true, updatedAt: 5 }).success,
    ).toBe(true);
    expect(
      SecretStatusSchema.safeParse({ isSet: false, updatedAt: null }).success,
    ).toBe(true);
    expect(
      SecretStatusSchema.safeParse({
        isSet: true,
        updatedAt: 5,
        value: 'hunter2',
      }).success,
    ).toBe(false);
  });
});
