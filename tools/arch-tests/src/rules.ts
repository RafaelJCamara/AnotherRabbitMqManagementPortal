// The architecture rules. Each takes the repository's sources and returns the violations; an empty
// list is a pass. They read syntax only, so they run in milliseconds and on any file.
import { readFacts, type FileFacts } from './facts.ts';
import type { SourceFile } from './sources.ts';

export interface ArchViolation {
  rule: string;
  path: string;
  message: string;
}

const isSpec = (path: string): boolean =>
  /\.(?:spec|test)\.[mc]?ts$/.test(path);
const under = (path: string, prefixes: readonly string[]): boolean =>
  prefixes.some((prefix) => path.startsWith(prefix));

// ---------------------------------------------------------------------------------------------
// I-2: the mutation funnel
// ---------------------------------------------------------------------------------------------

/**
 * Names that give the power to change a broker or to touch a message: the write halves of the
 * ports, the role leases (a peek, a source, a publisher or an observer all touch messages), the
 * connection manager that hands them out, and the executor's bundle of them.
 */
const WRITE_SYMBOL =
  /^(?:\w*WritePort|PublishLease|PeekLease|SourceLease|ObserveLease|ConnectionManager|ExecutorWrite|scheduleMgmtWrite)$/;

/** The member through which an executed action reaches those ports (`ctx.writes`). */
const WRITE_MEMBER = 'writes';

/** Code that reads the funnel's own types (action modules are the callers it exists for). */
const FUNNEL_MARKERS: readonly string[] = ['implementAction', 'defineJob'];

/**
 * Where write-capable symbols are at home: the port definitions, the kernel that owns the
 * executor, the adapters that implement the ports, the persistence and network libraries, the
 * composition root that wires them, and test and tooling code. Everything else (services,
 * transport, live, jobs, the SDK, UI, shared libraries) may name one only in a file that also
 * calls `implementAction(...)` or `defineJob(...)`.
 */
export const FUNNEL_EXEMPT_PREFIXES: readonly string[] = [
  'libs/engine/ports/',
  'libs/engine/kernel/',
  // The job runner is plumbing like the executor: it builds `JobContext.executorWrite` and hands
  // the write ports to a running job. The rest of `jobs` is checked like any other library.
  'libs/engine/jobs/src/runner.ts',
  'libs/engine/jobs/src/types.ts',
  'libs/engine/persistence/',
  'libs/engine/adapter-',
  'libs/engine/net-',
  'apps/engine/',
  'libs/testkit/',
  'testing/',
  'tools/',
];

function mentionsWriteCapability(facts: FileFacts): string[] {
  const names = new Set<string>();
  for (const name of [...facts.importedNames, ...facts.identifiers]) {
    if (WRITE_SYMBOL.test(name)) names.add(name);
  }
  if (facts.members.has(WRITE_MEMBER)) names.add(`.${WRITE_MEMBER}`);
  return [...names].sort();
}

/**
 * I-2: a file outside the exempt locations that names a write-capable port must be an action or
 * job module, which is to say it calls `implementAction(...)` or `defineJob(...)`. Specs are
 * exempt (they build fakes).
 */
export function checkMutationFunnel(
  files: readonly SourceFile[],
): ArchViolation[] {
  const violations: ArchViolation[] = [];
  for (const file of files) {
    if (isSpec(file.path) || under(file.path, FUNNEL_EXEMPT_PREFIXES)) continue;
    const facts = readFacts(file.path, file.text);
    const names = mentionsWriteCapability(facts);
    if (names.length === 0) continue;
    if (FUNNEL_MARKERS.some((marker) => facts.calls.has(marker))) continue;
    violations.push({
      rule: 'mutation-funnel',
      path: file.path,
      message: `names ${names.join(', ')} but does not call implementAction(...) or defineJob(...); write-capable ports are reachable only from action and job modules (I-2)`,
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------------------------
// A-9: settlement proofs are minted in a few places only
// ---------------------------------------------------------------------------------------------

const MINT_FUNCTION =
  /^mint(?:ConfirmedCopy|DestructiveConsent|SafeReturn|StreamCredit)Proof$/;
const PROOF_TYPE =
  /^(?:ConfirmedCopy|DestructiveConsent|SafeReturn|StreamCredit)Proof$/;

/**
 * The publish lease mints a copy proof from a broker confirm; the stream consumer of an observe
 * lease mints the credit proof; the planners mint consent and safe-return proofs.
 */
export const PROOF_MINTING_PREFIXES: readonly string[] = [
  'libs/engine/ports/',
  'libs/engine/adapter-amqp091/',
  'libs/engine/adapter-amqp10/',
  'libs/shared/peek-planner/',
  'libs/shared/tap-planner/',
  'libs/shared/replay-planner/',
  'libs/testkit/',
  'testing/',
];

/**
 * A-9: only the locations above may import a `mint*Proof` function, and no file outside
 * `libs/engine/ports/` may forge a proof with a type assertion (`x as ConfirmedCopyProof`).
 * Specs may do both: the type tests attempt forgeries on purpose.
 */
export function checkProofMinting(
  files: readonly SourceFile[],
): ArchViolation[] {
  const violations: ArchViolation[] = [];
  for (const file of files) {
    if (isSpec(file.path)) continue;
    const inPorts = file.path.startsWith('libs/engine/ports/');
    const mayMint = under(file.path, PROOF_MINTING_PREFIXES);
    if (inPorts) continue;
    const facts = readFacts(file.path, file.text);
    const minted = [...facts.importedNames].filter((name) =>
      MINT_FUNCTION.test(name),
    );
    if (minted.length > 0 && !mayMint) {
      violations.push({
        rule: 'proof-minting',
        path: file.path,
        message: `imports ${minted.sort().join(', ')}; only the publish lease, the stream consumer and the planners mint settlement proofs (A-9)`,
      });
    }
    const forged = [...facts.assertedTypes].filter((name) =>
      PROOF_TYPE.test(name),
    );
    if (forged.length > 0 && !under(file.path, ['testing/', 'libs/testkit/'])) {
      violations.push({
        rule: 'proof-forgery',
        path: file.path,
        message: `casts a value to ${forged.sort().join(', ')}; a settlement proof comes from a mint function, never from a type assertion (A-9)`,
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------------------------
// Plan purity: every implementAction site is covered by the harness
// ---------------------------------------------------------------------------------------------

/** Where action modules live; kernel and test code define actions for their own specs. */
export function isActionModule(path: string): boolean {
  return (
    !isSpec(path) &&
    !under(path, [
      'libs/engine/kernel/',
      'libs/testkit/',
      'testing/',
      'tools/',
    ]) &&
    /^(?:libs|apps)\//.test(path)
  );
}

export interface ActionSite {
  path: string;
  calls: number;
}

/** The files of the product that call `implementAction(...)`, with how many times. */
export function findActionSites(files: readonly SourceFile[]): ActionSite[] {
  const sites: ActionSite[] = [];
  for (const file of files) {
    if (!isActionModule(file.path)) continue;
    const calls = readFacts(file.path, file.text).calls.get('implementAction');
    if (calls !== undefined) sites.push({ path: file.path, calls });
  }
  return sites;
}
