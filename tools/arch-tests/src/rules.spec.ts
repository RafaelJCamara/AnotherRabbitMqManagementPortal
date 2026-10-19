import { describe, expect, it } from 'vitest';

import {
  checkMutationFunnel,
  checkProofMinting,
  checkRecorderIndependence,
  findActionSites,
} from './rules.ts';
import type { SourceFile } from './sources.ts';

const file = (path: string, text: string): SourceFile => ({ path, text });

const paths = (violations: { path: string }[]): string[] =>
  violations.map((violation) => violation.path);

describe('I-2 mutation funnel', () => {
  it('fails a service file that imports a write port without being an action module', () => {
    const planted = file(
      'libs/engine/svc-admin/src/internal/purge.ts',
      `import type { MgmtWritePort } from '@app/ports';
export const purge = (port: MgmtWritePort) => port.send({} as never, new AbortController().signal);`,
    );

    const violations = checkMutationFunnel([planted]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      rule: 'mutation-funnel',
      path: planted.path,
    });
    expect(violations[0]?.message).toContain('MgmtWritePort');
  });

  it('passes the same code in a file that calls implementAction', () => {
    const action = file(
      'libs/engine/svc-admin/src/actions/queues-purge.ts',
      `import { implementAction } from '@app/kernel';
import type { MgmtWritePort } from '@app/ports';
export const purge = implementAction(def, {
  execute: (input, ctx) => (ctx.writes.mgmt as MgmtWritePort).send({} as never, ctx.signal),
});`,
    );
    const job = file(
      'libs/engine/svc-dlq/src/jobs/replay.ts',
      `import type { PublishLease } from '@app/ports';
export const replay = defineJob({ run: (lease: PublishLease) => lease });`,
    );

    expect(checkMutationFunnel([action, job])).toEqual([]);
  });

  it.each([
    'PublishLease',
    'PeekLease',
    'SourceLease',
    'ObserveLease',
    'ConnectionManager',
    'ExecutorWrite',
    'MgmtWritePort',
    'ReplayJournalWritePort',
    'scheduleMgmtWrite',
  ])('treats %s as write-capable', (name) => {
    const planted = file(
      'libs/engine/svc-tap/src/helper.ts',
      `import { ${name} } from '@app/ports';\nexport const use = ${name};`,
    );

    expect(paths(checkMutationFunnel([planted]))).toEqual([planted.path]);
  });

  it('sees through an alias, a type-only import and a type annotation', () => {
    const aliased = file(
      'libs/engine/svc-a/src/a.ts',
      `import { PublishLease as P } from '@app/ports';\nexport type T = P;`,
    );
    const typeOnly = file(
      'libs/engine/svc-a/src/b.ts',
      `import type { PeekLease } from '@app/ports';\nexport type T = PeekLease;`,
    );
    const annotation = file(
      'libs/engine/svc-a/src/c.ts',
      `export function f(x: import('@app/ports').SourceLease) { return x; }`,
    );

    expect(paths(checkMutationFunnel([aliased, typeOnly, annotation]))).toEqual(
      [aliased.path, typeOnly.path, annotation.path],
    );
  });

  it('fails a file that reaches the executor writes through ctx.writes or a destructuring', () => {
    const member = file(
      'libs/engine/svc-a/src/d.ts',
      `export const f = (ctx: { writes: unknown }) => ctx.writes;`,
    );
    const destructured = file(
      'libs/engine/svc-a/src/e.ts',
      `export const f = (ctx: { writes: unknown }) => { const { writes } = ctx; return writes; };`,
    );

    expect(paths(checkMutationFunnel([member, destructured]))).toEqual([
      member.path,
      destructured.path,
    ]);
  });

  it('does not mind a variable that merely has a similar name', () => {
    const innocent = file(
      'libs/engine/svc-a/src/f.ts',
      `const writes = 3; const MyLeaseNotes = 1; export const x = writes + MyLeaseNotes;`,
    );

    expect(checkMutationFunnel([innocent])).toEqual([]);
  });

  it('fails transport, live, jobs, shared libraries and the UI; spares the plumbing', () => {
    const text = `import type { PublishLease } from '@app/ports'; export type T = PublishLease;`;
    const checked = [
      'libs/engine/transport/src/router.ts',
      'libs/engine/live/src/hub.ts',
      'libs/engine/jobs/src/envelope.ts',
      'libs/engine/jobs/src/job-modules/replay.ts',
      'libs/engine/svc-connections/src/module.ts',
      'libs/shared/replay-planner/src/plan.ts',
      'libs/ui/data/src/api.ts',
      'apps/web/src/main.ts',
    ];
    const exempt = [
      'libs/engine/ports/src/amqp091.ts',
      'libs/engine/kernel/src/actions/types.ts',
      // The job runner builds the write bundle a job body receives (M0-31).
      'libs/engine/jobs/src/runner.ts',
      'libs/engine/jobs/src/types.ts',
      // The ConnectionManager hands out the leases (M0-43).
      'libs/engine/svc-connections/src/internal/connection-manager/connection-manager.ts',
      'libs/engine/adapter-amqp091/src/leases/publish.ts',
      'libs/engine/net-dialer/src/dialer.ts',
      'libs/engine/persistence/src/x.ts',
      'apps/engine/src/compose-core.ts',
      'libs/testkit/src/fakes.ts',
      'tools/arch-tests/src/x.ts',
      'testing/broker-lab/src/x.ts',
      'libs/engine/svc-a/src/thing.spec.ts',
      'libs/engine/svc-a/src/thing.test.ts',
    ];

    expect(
      paths(checkMutationFunnel(checked.map((path) => file(path, text)))),
    ).toEqual(checked);
    expect(checkMutationFunnel(exempt.map((path) => file(path, text)))).toEqual(
      [],
    );
  });

  it('is not fooled by a comment or a string that mentions a write port', () => {
    const chatty = file(
      'libs/engine/svc-a/src/g.ts',
      `// MgmtWritePort and PublishLease are only for actions\nexport const note = 'PublishLease';`,
    );

    expect(checkMutationFunnel([chatty])).toEqual([]);
  });
});

describe('A-9 proof minting', () => {
  const mint = `import { mintConfirmedCopyProof } from '@app/ports';\nexport const p = mintConfirmedCopyProof;`;

  it('fails a service that imports a mint function', () => {
    const planted = file('libs/engine/svc-dlq/src/replay.ts', mint);

    const violations = checkProofMinting([planted]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ rule: 'proof-minting' });
    expect(violations[0]?.message).toContain('mintConfirmedCopyProof');
  });

  it.each([
    'mintConfirmedCopyProof',
    'mintDestructiveConsentProof',
    'mintSafeReturnProof',
    'mintStreamCreditProof',
  ])('knows %s', (name) => {
    const planted = file(
      'libs/engine/svc-a/src/x.ts',
      `import { ${name} as m } from '@app/ports';\nexport const p = m;`,
    );

    expect(paths(checkProofMinting([planted]))).toEqual([planted.path]);
  });

  it('allows the publish lease, the stream consumer and the planners', () => {
    const allowed = [
      'libs/engine/adapter-amqp091/src/leases/publish.ts',
      'libs/engine/adapter-amqp10/src/stream.ts',
      'libs/shared/peek-planner/src/plan.ts',
      'libs/shared/tap-planner/src/plan.ts',
      'libs/shared/replay-planner/src/plan.ts',
      'libs/engine/ports/src/proofs.ts',
      'libs/engine/svc-dlq/src/replay.spec.ts',
    ];

    expect(checkProofMinting(allowed.map((path) => file(path, mint)))).toEqual(
      [],
    );
  });

  it('fails a forged proof: a type assertion to a proof type', () => {
    const forged = file(
      'libs/engine/svc-dlq/src/replay.ts',
      `import type { ConfirmedCopyProof } from '@app/ports';
export const p = { kind: 'confirmed-copy', destination: 'q', confirmedAt: 1 } as ConfirmedCopyProof;`,
    );
    const angle = file(
      'libs/engine/svc-dlq/src/replay2.ts',
      `import type { SafeReturnProof } from '@app/ports';
export const p = <SafeReturnProof>(<unknown>{ kind: 'safe-return' });`,
    );

    const violations = checkProofMinting([forged, angle]);

    expect(violations.map((violation) => violation.rule)).toEqual([
      'proof-forgery',
      'proof-forgery',
    ]);
  });

  it('allows an adapter to hold a proof in a typed variable', () => {
    const fine = file(
      'libs/engine/adapter-amqp091/src/leases/peek.ts',
      `import type { AckProof } from '@app/ports';
export const ack = (p: AckProof) => p;`,
    );

    expect(checkProofMinting([fine])).toEqual([]);
  });
});

describe('plan purity: finding the action sites', () => {
  it('counts implementAction calls in action modules, not in kernel, specs or tools', () => {
    const sites = findActionSites([
      file(
        'libs/engine/svc-a/src/actions/one.ts',
        `export const a = implementAction(d, {});`,
      ),
      file(
        'libs/engine/svc-a/src/actions/two.ts',
        `export const a = implementAction(d, {}); export const b = kernel.implementAction(e, {});`,
      ),
      file('libs/engine/svc-a/src/actions/none.ts', `export const a = 1;`),
      file(
        'libs/engine/svc-a/src/actions/one.spec.ts',
        `implementAction(d, {});`,
      ),
      file(
        'libs/engine/kernel/src/actions/test-actions.ts',
        `implementAction(d, {});`,
      ),
      file('tools/arch-tests/src/x.ts', `implementAction(d, {});`),
      file(
        'apps/engine/src/modules/core.ts',
        `export const a = implementAction(d, {});`,
      ),
    ]);

    expect(sites).toEqual([
      { path: 'libs/engine/svc-a/src/actions/one.ts', calls: 1 },
      { path: 'libs/engine/svc-a/src/actions/two.ts', calls: 2 },
      { path: 'apps/engine/src/modules/core.ts', calls: 1 },
    ]);
  });
});

describe('I-14 the evidence recorder is independent of the registry', () => {
  const planted = (path: string, specifier: string) =>
    file(
      path,
      `import { registryData } from '${specifier}';\nexport const x = registryData;`,
    );

  it('AC-2 fails a recorder file that imports @app/semantics, however it is spelled', () => {
    const files = [
      planted('apps/conformance/src/record/record.ts', '@app/semantics'),
      planted(
        'apps/conformance/src/record/write.ts',
        '@app/semantics/registry',
      ),
      planted('apps/conformance/src/driver/amqp091-raw.ts', '@app/semantics'),
      planted('apps/conformance/src/dsl.ts', '@app/semantics'),
      planted(
        'apps/conformance/src/scenarios/cf-smoke-01.ts',
        '@app/semantics',
      ),
      file(
        'apps/conformance/src/record/evidence.ts',
        `export const lazy = () => import('@app/semantics');`,
      ),
      file(
        'apps/conformance/src/record/cli.ts',
        `export { registryData } from '@app/semantics';`,
      ),
      file(
        'apps/conformance/src/record/secrets.ts',
        `export type R = import('@app/semantics').Registry;`,
      ),
      file(
        'apps/conformance/src/record/provenance.ts',
        `const r = require('@app/semantics');\nexport default r;`,
      ),
    ];

    const violations = checkRecorderIndependence(files);

    expect(paths(violations)).toEqual(files.map((entry) => entry.path));
    expect(violations[0]).toMatchObject({ rule: 'recorder-independence' });
  });

  it('fails a relative import into the registry or another project, and any other workspace package', () => {
    const files = [
      planted(
        'apps/conformance/src/record/a.ts',
        '../../../../libs/shared/semantics/src/index.ts',
      ),
      planted(
        'apps/conformance/src/driver/b.ts',
        '../../../../libs/testkit/src/index.ts',
      ),
      planted('apps/conformance/src/record/c.ts', '@app/testkit'),
    ];

    expect(paths(checkRecorderIndependence(files))).toEqual(
      files.map((entry) => entry.path),
    );
  });

  it('passes imports inside the recorder, packages from node_modules and specs', () => {
    const files = [
      file(
        'apps/conformance/src/record/record.ts',
        `import { z } from 'zod';\nimport { a } from '../driver/amqp091-raw.ts';\nimport { b } from './evidence.ts';\nimport 'node:fs';\nexport const x = [z, a, b];`,
      ),
      planted('apps/conformance/src/record/record.spec.ts', '@app/semantics'),
      // The cells compare the registry with evidence: they are outside the recorder.
      planted(
        'apps/conformance/src/cells/registry-links.spec.ts',
        '@app/semantics',
      ),
      planted('libs/shared/semantics/src/audit.ts', '@app/semantics'),
    ];

    expect(checkRecorderIndependence(files)).toEqual([]);
  });
});
