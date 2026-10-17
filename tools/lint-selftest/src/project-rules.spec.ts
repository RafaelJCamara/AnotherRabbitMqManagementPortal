// Project rules (tools/eslint-rules, M0-04). The RuleTester specs in tools/eslint-rules prove each
// rule in isolation. These tests prove that eslint.config.mjs wires the rules to the right paths:
// each rule fails where it should and stays quiet where it is exempt.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { lintAs, lintFile } from './lint-runner';

const fixtures = 'tools/lint-selftest/fixtures';

const rulesOf = (violations: { ruleId: string }[]) =>
  violations.map(({ ruleId }) => ruleId);

describe('no-broker-version-compare (I-3)', () => {
  const comparison =
    "export const supported = (version: string) => version >= '4.3.0';\n";

  it('fails a semver comparison against 4.3.0 in libs/engine/svc-peek', async () => {
    const violations = await lintAs(
      'libs/engine/svc-peek/src/gate.ts',
      comparison,
    );

    expect(rulesOf(violations)).toEqual(['@app/no-broker-version-compare']);
  });

  it('passes the same code in libs/shared/semantics', async () => {
    expect(
      await lintAs('libs/shared/semantics/src/era.ts', comparison),
    ).toEqual([]);
  });

  it('passes the same code in libs/engine/svc-capabilities', async () => {
    expect(
      await lintAs('libs/engine/svc-capabilities/src/probe.ts', comparison),
    ).toEqual([]);
  });

  it('fails semver helpers outside the registry', async () => {
    const violations = await lintAs(
      'libs/engine/svc-tap/src/gate.ts',
      "import { gte } from 'semver';\nexport const ok = (v: string, minimum: string) => gte(v, minimum);\n",
    );

    expect(rulesOf(violations)).toContain('@app/no-broker-version-compare');
  });
});

describe('no-mode-branching (ADR-001)', () => {
  const branch = "export const isLocal = (mode: string) => mode === 'local';\n";

  it('fails a service that branches on the delivery mode', async () => {
    const violations = await lintAs(
      'libs/engine/svc-peek/src/branch.ts',
      branch,
    );

    expect(rulesOf(violations)).toEqual(['@app/no-mode-branching']);
  });

  it.each([
    'apps/engine/src/modes/desktop.ts',
    'apps/engine/src/entry/main.ts',
    'apps/engine/src/modules/peek.ts',
  ])('allows the composition code in %s', async (path) => {
    expect(await lintAs(path, branch)).toEqual([]);
  });

  it('fails other code in apps/engine', async () => {
    expect(rulesOf(await lintAs('apps/engine/src/other.ts', branch))).toEqual([
      '@app/no-mode-branching',
    ]);
  });
});

describe('bounded-buffers-only (I-6)', () => {
  const unbounded = 'export const buffer: number[] = [];\n';

  it('fails an unbounded buffer in a service', async () => {
    const violations = await lintAs(
      'libs/engine/svc-tap/src/buffer.ts',
      unbounded,
    );

    expect(rulesOf(violations)).toEqual(['@app/bounded-buffers-only']);
  });

  it('allows the bounded primitives themselves', async () => {
    expect(
      await lintAs('libs/engine/kernel/src/bounded/ring.ts', unbounded),
    ).toEqual([]);
  });

  it('allows BoundedRing', async () => {
    expect(
      await lintAs(
        'libs/engine/svc-tap/src/ring.ts',
        'declare class BoundedRing {\n  readonly dropped: number;\n}\nexport const ring = new BoundedRing();\n',
      ),
    ).toEqual([]);
  });
});

describe('explicit-zod-schemas', () => {
  it('fails z.any() in contracts', async () => {
    const violations = await lintAs(
      'libs/shared/contracts/src/any.ts',
      "import { z } from 'zod';\nexport const Any = z.any();\n",
    );

    expect(rulesOf(violations)).toContain('@app/explicit-zod-schemas');
  });

  // The rule works on names. These fixtures use the real zod, so a rename in zod, or a way to
  // build a loose schema the rule does not know, shows up here (OQ-34).
  it.each([
    ['z.any()', 'z.any()'],
    ['z.looseObject()', 'z.looseObject({ id: z.string() })'],
    ['.loose()', 'z.object({ id: z.string() }).loose()'],
    ['.passthrough()', 'z.object({ id: z.string() }).passthrough()'],
    [
      '.catchall(z.string())',
      'z.object({ id: z.string() }).catchall(z.string())',
    ],
  ])('fails %s built with the real zod', async (_name, expression) => {
    const violations = await lintAs(
      'libs/shared/contracts/src/loose.ts',
      `import { z } from 'zod';\nexport const Loose = ${expression};\n`,
    );

    expect(rulesOf(violations)).toEqual(['@app/explicit-zod-schemas']);
  });

  it('accepts the explicit schemas the contracts kit uses', async () => {
    const violations = await lintAs(
      'libs/shared/contracts/src/explicit.ts',
      [
        "import { z } from 'zod';",
        'export const Strict = z.strictObject({ id: z.string(), extra: z.unknown() });',
        'export const Closed = z.object({ id: z.string() }).catchall(z.never());',
        'export const Map = z.record(z.string(), z.number());',
        "export const Frame = z.discriminatedUnion('t', [z.strictObject({ t: z.literal('a') })]);",
        '',
      ].join('\n'),
    );

    expect(violations).toEqual([]);
  });

  it('knows the escape hatches that zod 4 really has', () => {
    const object = z.object({ id: z.string() });
    expect(typeof z.any).toBe('function');
    expect(typeof z.looseObject).toBe('function');
    for (const method of ['loose', 'passthrough', 'catchall'] as const) {
      expect(typeof object[method]).toBe('function');
    }
    // `z.object` strips unknown keys and `z.strictObject` rejects them: neither lets them through.
    expect(object.parse({ id: 'a', extra: 1 })).toEqual({ id: 'a' });
    expect(
      z.strictObject({ id: z.string() }).safeParse({ id: 'a', extra: 1 }),
    ).toMatchObject({
      success: false,
    });
    // ...whereas the flagged forms do keep them.
    expect(object.loose().parse({ id: 'a', extra: 1 })).toEqual({
      id: 'a',
      extra: 1,
    });
  });

  it('fails .passthrough() anywhere', async () => {
    const violations = await lintAs(
      'libs/engine/svc-peek/src/schema.ts',
      'declare const schema: { passthrough(): unknown };\nexport const open = schema.passthrough();\n',
    );

    expect(rulesOf(violations)).toEqual(['@app/explicit-zod-schemas']);
  });
});

describe('UI rules (ADR-021)', () => {
  it('fails innerHTML in UI code', async () => {
    const violations = await lintAs(
      'libs/ui/payload/src/render.ts',
      'export const render = (el: HTMLElement, body: string) => {\n  el.innerHTML = body;\n};\n',
    );

    expect(rulesOf(violations)).toEqual(['@app/no-inner-html']);
  });

  it('fails [innerHTML] in a template', async () => {
    const violations = await lintAs(
      'apps/web/src/app/body.html',
      '<div [innerHTML]="body()"></div>\n',
    );

    expect(rulesOf(violations)).toEqual(['@app/no-inner-html']);
  });

  it('fails a direct fetch outside libs/ui/platform', async () => {
    const violations = await lintAs(
      'libs/ui/data/src/client.ts',
      "export const load = () => fetch('/api/v1/queues');\n",
    );

    expect(rulesOf(violations)).toEqual(['@app/no-direct-fetch']);
  });

  it('allows sockets in libs/ui/platform, which owns the transports', async () => {
    expect(
      await lintAs(
        'libs/ui/platform/src/live.ts',
        'export const open = (url: string) => new WebSocket(url);\n',
      ),
    ).toEqual([]);
  });

  it('fails raw text in a template', async () => {
    const violations = await lintAs(
      'apps/web/src/app/title.html',
      '<h1>Queues</h1>\n',
    );

    expect(rulesOf(violations)).toEqual(['@app/ui-no-raw-template-text']);
  });

  it('allows bound text in a template', async () => {
    expect(
      await lintAs(
        'libs/ui/grid/src/title.html',
        "<h1>{{ 'queues.title' | transloco }}</h1>\n",
      ),
    ).toEqual([]);
  });

  it('does not treat index.html as a template', async () => {
    expect(
      await lintAs(
        'apps/web/src/index.html',
        '<!doctype html>\n<html><head><title>Product</title></head><body><app-root></app-root></body></html>\n',
      ),
    ).toEqual([]);
  });
});

describe('honest-wording (DC-15)', () => {
  it('fails an en.json value "non-destructive peek" outside the allow-listed keys', async () => {
    const violations = await lintFile(`${fixtures}/i18n/en.json`);

    expect(rulesOf(violations)).toEqual(['@app/honest-wording']);
    expect(violations[0]?.message).toContain('non-destructive');
  });

  it.each([
    'apps/web/public/i18n/en.json',
    'libs/ui/feature-messages/src/i18n/en.json',
    'apps/web/public/locales/de.json',
  ])('lints the translation file %s', async (path) => {
    const violations = await lintAs(
      path,
      '{ "peek": { "title": "Non-destructive peek" } }\n',
    );

    expect(rulesOf(violations)).toEqual(['@app/honest-wording']);
  });

  it.each([
    '{ "messages": { "streamBrowse": { "title": "Non-destructive browse" } } }',
    '{ "peek": { "nodeAgent": { "title": "Non-destructive peek" } } }',
    '{ "peek": { "title": "Side-effect-aware peek", "hint": "Messages stay in the queue." } }',
    '{ "shell": { "lock": { "toggle": "Toggle read-only lock" } } }',
  ])('allows %s', async (json) => {
    expect(await lintAs('apps/web/public/i18n/en.json', `${json}\n`)).toEqual(
      [],
    );
  });

  it('fails "read-only" for a message read', async () => {
    const violations = await lintAs(
      'apps/web/public/i18n/en.json',
      '{ "dlq": { "title": "Read-only view" } }\n',
    );

    expect(rulesOf(violations)).toEqual(['@app/honest-wording']);
  });

  it('does not lint JSON outside the i18n folders', async () => {
    expect(
      await lintAs(
        'apps/web/public/manifest.json',
        '{ "name": "Non-destructive" }\n',
      ),
    ).toEqual([]);
  });

  it('fails a claim in UI string literals', async () => {
    const violations = await lintAs(
      'libs/ui/feature-messages/src/title.ts',
      "export const title = 'Non-destructive peek';\n",
    );

    expect(rulesOf(violations)).toEqual(['@app/honest-wording']);
  });
});
