import { describe, expect, it } from 'vitest';

import { lintAs, lintFile } from './lint-runner';

const boundaries = '@nx/enforce-module-boundaries';
const restricted = 'no-restricted-imports';
const fixtures = 'tools/lint-selftest/fixtures';

const rulesOf = (violations: { ruleId: string }[]) =>
  violations.map(({ ruleId }) => ruleId);

describe('module boundaries (blueprint 2.2)', () => {
  it('fails a ui-feature that imports another ui-feature', async () => {
    const violations = await lintFile(
      `${fixtures}/ui-feature-a/src/planted-cross-feature.ts`,
    );

    expect(rulesOf(violations)).toEqual([boundaries]);
    expect(violations[0]?.message).toContain('type:ui-feature');
  });

  it('allows a ui-feature to import ui-data', async () => {
    const violations = await lintAs(
      `${fixtures}/ui-feature-a/src/virtual-control.ts`,
      "import { fixture } from '@lint-fixtures/ui-data';\nexport const used = fixture;\n",
    );

    expect(violations).toEqual([]);
  });

  it('fails a service that imports another service', async () => {
    const violations = await lintFile(
      `${fixtures}/service-a/src/planted-cross-service.ts`,
    );

    expect(rulesOf(violations)).toEqual([boundaries]);
  });

  it('fails a browser project that depends on a node project', async () => {
    const violations = await lintAs(
      `${fixtures}/ui-data/src/virtual-runtime.ts`,
      "import { fixture } from '@lint-fixtures/service-a';\nexport const used = fixture;\n",
    );

    expect(rulesOf(violations)).toContain(boundaries);
  });

  it('fails a contracts library that imports anything but zod', async () => {
    const violations = await lintFile(
      `${fixtures}/contracts-lib/src/planted-external.ts`,
    );

    expect(rulesOf(violations)).toEqual([boundaries]);
    expect(violations[0]?.message).toContain('type:contracts');
  });

  it('allows a contracts library to import zod', async () => {
    const violations = await lintFile(
      `${fixtures}/contracts-lib/src/allowed-zod.ts`,
    );

    expect(violations).toEqual([]);
  });

  it('lets a contracts library import zod, and its specs fast-check', async () => {
    const schema = "import { z } from 'zod';\nexport const Id = z.string();\n";
    expect(
      await lintAs(`${fixtures}/contracts-lib/src/virtual-id.ts`, schema),
    ).toEqual([]);

    const property =
      "import fc from 'fast-check';\nexport const arbitrary = fc.string();\n";
    expect(
      await lintAs(
        `${fixtures}/contracts-lib/src/virtual-id.spec.ts`,
        property,
      ),
    ).toEqual([]);
    // fast-check is a test tool, not a contracts dependency
    expect(
      rulesOf(
        await lintAs(`${fixtures}/contracts-lib/src/virtual-id.ts`, property),
      ),
    ).toEqual([boundaries]);
  });
});

describe('node builtins in runtime-neutral code (blueprint 2.1)', () => {
  // @nx/enforce-module-boundaries ignores node builtins, so no-restricted-imports enforces this.
  it('fails a type:pure lib that imports node:fs', async () => {
    const violations = await lintFile(
      `${fixtures}/pure-lib/src/planted-node-fs.ts`,
    );

    expect(rulesOf(violations)).toEqual([restricted]);
    expect(violations[0]?.message).toContain('Node builtins');
  });

  it.each(['fs', 'fs/promises', 'path', 'node:path'])(
    'fails a type:pure lib importing %s',
    async (name) => {
      const violations = await lintAs(
        `${fixtures}/pure-lib/src/virtual-builtin.ts`,
        `import * as mod from '${name}';\nexport const used = mod;\n`,
      );

      expect(rulesOf(violations)).toEqual([restricted]);
    },
  );

  it('fails a ui-feature that imports node:fs', async () => {
    const violations = await lintAs(
      `${fixtures}/ui-feature-a/src/virtual-builtin.ts`,
      "import { readFileSync } from 'node:fs';\nexport const used = readFileSync;\n",
    );

    expect(rulesOf(violations)).toEqual([restricted]);
  });

  it('allows node:fs in a runtime:node project', async () => {
    const violations = await lintAs(
      `${fixtures}/service-a/src/virtual-builtin.ts`,
      "import { readFileSync } from 'node:fs';\nexport const used = readFileSync;\n",
    );

    expect(violations).toEqual([]);
  });
});

describe('third-party confinement (blueprint 2.4)', () => {
  const amqplib =
    "import { connect } from 'amqplib';\nexport const used = connect;\n";

  it('fails amqplib imported outside adapter-amqp091 and apps/conformance', async () => {
    const violations = await lintFile(
      `${fixtures}/service-a/src/planted-amqplib.ts`,
    );

    expect(rulesOf(violations)).toEqual([restricted]);
    expect(violations[0]?.message).toContain('libs/engine/adapter-amqp091');
    expect(violations[0]?.message).toContain('apps/conformance');
  });

  it.each([
    'libs/engine/adapter-amqp10/src/index.ts',
    'libs/engine/svc-peek/src/module.ts',
    'apps/engine/src/main.ts',
    'tools/supply-chain/src/index.ts',
  ])('fails amqplib in %s', async (path) => {
    expect(rulesOf(await lintAs(path, amqplib))).toEqual([restricted]);
  });

  it.each([
    'libs/engine/adapter-amqp091/src/index.ts',
    'libs/engine/adapter-amqp091/src/internal/channel.ts',
    'apps/conformance/src/main.ts',
  ])('allows amqplib in %s', async (path) => {
    expect(await lintAs(path, amqplib)).toEqual([]);
  });

  it('fails type-only and subpath imports too', async () => {
    const violations = await lintAs(
      'libs/engine/svc-peek/src/types.ts',
      "import type { Channel } from 'amqplib/lib/channel';\nexport type Used = Channel;\n",
    );

    expect(rulesOf(violations)).toEqual([restricted]);
  });

  it('keeps each package to its own locations', async () => {
    const undici =
      "import { request } from 'undici';\nexport const used = request;\n";

    expect(await lintAs('libs/engine/net-dialer/src/index.ts', undici)).toEqual(
      [],
    );
    expect(
      await lintAs('libs/engine/adapter-mgmt-http/src/index.ts', undici),
    ).toEqual([]);
    expect(
      rulesOf(await lintAs('libs/engine/svc-peek/src/index.ts', undici)),
    ).toEqual([restricted]);
    // net-dialer may use undici, but not amqplib.
    expect(
      rulesOf(await lintAs('libs/engine/net-dialer/src/index.ts', amqplib)),
    ).toEqual([restricted]);
  });

  it('lets a nested location use its own package only', async () => {
    const flow =
      "import { Flow } from '@foblex/flow';\nexport const used = Flow;\n";
    const cytoscape =
      "import cytoscape from 'cytoscape';\nexport const used = cytoscape;\n";

    expect(await lintAs('libs/ui/graph/src/flow/graph-flow.ts', flow)).toEqual(
      [],
    );
    expect(await lintAs('libs/ui/graph/src/index.ts', cytoscape)).toEqual([]);
    expect(rulesOf(await lintAs('libs/ui/graph/src/index.ts', flow))).toEqual([
      restricted,
    ]);
  });
});

describe('banned imports (blueprint 2.4)', () => {
  it('fails a banned package everywhere', async () => {
    const violations = await lintFile(
      `${fixtures}/ui-feature-b/src/planted-banned.ts`,
    );

    expect(rulesOf(violations)).toEqual([restricted]);
    expect(violations[0]?.message).toContain('Banned dependency');
  });

  it.each([
    ['libs/ui/grid/src/index.ts', 'ag-grid-enterprise'],
    ['apps/engine/src/main.ts', '@nestjs/common'],
    ['libs/shared/contracts/src/index.ts', 'nestjs-zod'],
    ['libs/ui/charts/src/index.ts', 'apexcharts'],
  ])('fails %s importing %s', async (path, name) => {
    const violations = await lintAs(
      path,
      `import * as mod from '${name}';\nexport const used = mod;\n`,
    );

    expect(rulesOf(violations)).toContain(restricted);
  });

  it('keeps rabbitmq-amqp-js-client to the oracle project', async () => {
    const code =
      "import * as mod from 'rabbitmq-amqp-js-client';\nexport const used = mod;\n";

    expect(await lintAs('testing/oracle-amqp10/src/index.ts', code)).toEqual(
      [],
    );
    expect(
      rulesOf(await lintAs('libs/engine/adapter-amqp10/src/index.ts', code)),
    ).toEqual([restricted]);
  });
});
