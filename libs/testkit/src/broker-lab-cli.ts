// Command line of the broker-lab project (testing/broker-lab/project.json):
//
//   node libs/testkit/src/broker-lab-cli.ts build                       static manifest, no Docker
//   node libs/testkit/src/broker-lab-cli.ts images [--versions=a,b]     docker build per version
//   node libs/testkit/src/broker-lab-cli.ts verify [--versions=a,b] [--variants=plain,tls,oauth] [--nodes=1,3]
//
// Node strips the types, so no build step is needed (erasable syntax only).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { startBroker, type BrokerHandle } from './broker-lab.ts';
import { buildImageArgs, type Variant } from './lab/args.ts';
import { dockerCli } from './lab/docker.ts';
import { verifyBroker } from './lab/verify.ts';
import {
  LAB_DIR,
  findBroker,
  imageTag,
  loadBrokerVersions,
} from './lab/versions.ts';

const VARIANTS: readonly Variant[] = ['plain', 'tls', 'oauth'];

/** Reads `--name=a,b` options. Unknown options are an error, so a typo does not pass silently. */
export function parseOptions(
  argv: readonly string[],
  known: readonly string[],
): Map<string, string[]> {
  const options = new Map<string, string[]>();
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(argument);
    if (!match?.[1] || match[2] === undefined || !known.includes(match[1])) {
      throw new Error(
        `Unknown argument "${argument}". Options: ${known.map((name) => `--${name}=a,b`).join(' ')}`,
      );
    }
    options.set(
      match[1],
      match[2].split(',').filter((part) => part !== ''),
    );
  }
  return options;
}

function selectVersions(options: Map<string, string[]>): string[] {
  const all = loadBrokerVersions().map((broker) => broker.version);
  const wanted = options.get('versions') ?? all;
  for (const version of wanted) findBroker(version); // throws with the known list
  return wanted;
}

function selectVariants(options: Map<string, string[]>): Variant[] {
  const wanted = options.get('variants') ?? ['plain'];
  return wanted.map((variant) => {
    if (!VARIANTS.includes(variant as Variant)) {
      throw new Error(
        `Unknown variant "${variant}". Use ${VARIANTS.join(', ')}.`,
      );
    }
    return variant as Variant;
  });
}

function selectNodes(options: Map<string, string[]>): (1 | 3)[] {
  return (options.get('nodes') ?? ['1']).map((entry) => {
    if (entry !== '1' && entry !== '3') {
      throw new Error(`--nodes must be 1 or 3, got "${entry}"`);
    }
    return entry === '3' ? 3 : 1;
  });
}

/** Writes dist/testing/broker-lab/images.json: what `images` would build, from versions.json. */
function build(): void {
  const brokers = loadBrokerVersions();
  const out = join(LAB_DIR, '..', '..', 'dist', 'testing', 'broker-lab');
  mkdirSync(out, { recursive: true });
  const manifest = brokers.map((broker) => ({
    tag: imageTag(broker.version),
    version: broker.version,
    baseImage: `rabbitmq:${broker.version}-management@${broker.digest}`,
  }));
  writeFileSync(
    join(out, 'images.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(
    `broker-lab: ${String(manifest.length)} images pinned (${manifest.map((image) => image.version).join(', ')}); run "nx run broker-lab:images" to build them.`,
  );
}

async function images(versions: string[]): Promise<void> {
  for (const version of versions) {
    console.log(`broker-lab: building ${imageTag(version)}`);
    await dockerCli(buildImageArgs(findBroker(version), LAB_DIR));
  }
}

async function verify(
  versions: string[],
  variants: Variant[],
  nodes: (1 | 3)[],
): Promise<boolean> {
  let allOk = true;
  for (const version of versions) {
    for (const count of nodes) {
      for (const variant of count === 3 ? ['plain' as const] : variants) {
        const label = `${version} ${variant} x${String(count)}`;
        const started = Date.now();
        let handle: BrokerHandle | undefined;
        try {
          handle = await startBroker({ version, variant, nodes: count });
          const checks = await verifyBroker(handle);
          for (const check of checks) {
            console.log(
              `  ${check.ok ? 'PASS' : 'FAIL'} ${label}: ${check.name} - ${check.detail}`,
            );
          }
          const ok = checks.every((check) => check.ok);
          allOk &&= ok;
          console.log(
            `${ok ? 'OK  ' : 'FAIL'} ${label} (${String(Math.round((Date.now() - started) / 1000))} s, image ${handle.digest})`,
          );
        } catch (error) {
          allOk = false;
          console.log(
            `FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          await handle?.stop();
        }
      }
    }
  }
  return allOk;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'build':
      parseOptions(rest, []);
      build();
      return 0;
    case 'images': {
      await images(selectVersions(parseOptions(rest, ['versions'])));
      return 0;
    }
    case 'verify': {
      const options = parseOptions(rest, ['versions', 'variants', 'nodes']);
      const ok = await verify(
        selectVersions(options),
        selectVariants(options),
        selectNodes(options),
      );
      return ok ? 0 : 1;
    }
    default:
      console.error(
        'Usage: broker-lab-cli.ts build | images | verify [options]',
      );
      return 2;
  }
}

// Run only as a script, not when a spec imports parseOptions.
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
