// M0-69: the purpose registry, the Dialer that enforces it, and the docs page generated from it.
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createDialer } from './dialer.ts';
import { renderOutboundCallsPage } from './outbound-calls-page.ts';
import type { Resolver } from './policy-hook.ts';
import { PURPOSES, isRegisteredPurpose } from './purposes.ts';
import { acceptedAfterSettling, startPlainServer } from './test-support.ts';

const repo = join(import.meta.dirname, '..', '..', '..', '..');
const script = join(import.meta.dirname, 'emit-outbound-calls.ts');
const PAGE = join(
  repo,
  'apps',
  'docs',
  'src',
  'content',
  'docs',
  'security',
  'outbound-calls.md',
);

function run(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

/** A resolver that counts its calls: a refused purpose must not even resolve the name. */
function countingResolver() {
  const calls: string[] = [];
  const resolver: Resolver = (host) => {
    calls.push(host);
    return Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
  };
  return { calls, resolver };
}

describe('the purpose registry', () => {
  it('AC-1 every purpose has a unique id the Dialer accepts and every field filled in', async () => {
    const ids = PURPOSES.map((purpose) => purpose.id);
    expect(new Set(ids).size).toBe(ids.length);
    const { resolver } = countingResolver();
    const dialer = createDialer({ resolver, purposes: isRegisteredPurpose });

    for (const purpose of PURPOSES) {
      expect(
        await dialer.check({ host: 'a.test', port: 1, purpose: purpose.id }),
      ).toMatchObject({ allowed: true });
      for (const field of [
        purpose.feature,
        purpose.destination,
        purpose.trigger,
        purpose.default,
      ]) {
        expect(field.trim().length).toBeGreaterThan(10);
      }
    }
  });

  it('AC-1 only exact ids are registered: no case folding, no prefix, no pattern', () => {
    expect(isRegisteredPurpose('amqp')).toBe(true);
    for (const id of ['AMQP', 'amqp ', 'amq', 'amqp2', '', '*', 'amqp|oidc']) {
      expect(isRegisteredPurpose(id)).toBe(false);
    }
  });

  it('AC-1 anything that phones home is off by default and says who configures the destination', () => {
    for (const id of ['update-check', 'otlp-export', 'diagnostics-upload']) {
      const purpose = PURPOSES.find((entry) => entry.id === id);
      expect(purpose?.default).toMatch(/^Off/);
    }
    for (const purpose of PURPOSES) {
      expect(purpose.default).toMatch(/^(Never until|Off)/);
    }
  });

  it('AC-1 every purpose literal in the source of the product is on the registry', () => {
    const found = new Map<string, string>();
    const unreadable: string[] = [];
    const skip =
      /\.(spec|it|test|fixture)\.ts$|[\\/](testing|node_modules|dist)[\\/]/;
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (/[\\/](node_modules|dist|\.nx|\.angular)$/.test(path)) continue;
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts') && !skip.test(path)) {
          // Code only: a comment may say "purpose: `x`" while explaining something else.
          const text = readFileSync(path, 'utf8')
            .split('\n')
            .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
            .join('\n');
          for (const match of text.matchAll(
            // `purpose: 'x'` in a target, and a constant such as `DIAL_PURPOSE = 'x'`.
            /\b(?:purpose:|\w*PURPOSE\w*\s*=)\s*(['"`])([^'"`]*)\1/g,
          )) {
            if (match[1] === '`') unreadable.push(relative(repo, path));
            else found.set(match[2] ?? '', relative(repo, path));
          }
        }
      }
    };
    // The libraries (testkit and the registry's own spec excluded) and the apps.
    walk(join(repo, 'libs'));
    walk(join(repo, 'apps'));

    const missing = [...found].filter(([id]) => !isRegisteredPurpose(id));
    expect(unreadable).toEqual([]);
    expect(missing).toEqual([]);
    // The scan is not vacuous: the one dialer call in the tree is seen.
    expect([...found.keys()]).toContain('amqp');
  });
});

describe('a Dialer given the registry', () => {
  it('AC-1 refuses an unregistered purpose before it resolves anything or opens a socket', async () => {
    const server = await startPlainServer();
    const { calls, resolver } = countingResolver();
    const dialer = createDialer({ resolver, purposes: isRegisteredPurpose });

    try {
      await expect(
        dialer.connect(
          { host: '127.0.0.1', port: server.port, purpose: 'telemetry' },
          { kind: 'direct' },
        ),
      ).rejects.toMatchObject({ code: 'EGRESS_DENIED' });

      expect(calls).toEqual([]);
      expect(await acceptedAfterSettling(server)).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('AC-1 check answers not allowed, with the purpose in the reason and nothing resolved', async () => {
    const { calls, resolver } = countingResolver();
    const dialer = createDialer({ resolver, purposes: isRegisteredPurpose });

    const answer = await dialer.check({
      host: 'a.test',
      port: 1,
      purpose: 'telemetry',
    });

    expect(answer).toEqual({
      allowed: false,
      reason: 'the purpose "telemetry" is not in the outbound-calls registry',
      resolved: [],
    });
    expect(calls).toEqual([]);
  });

  it('AC-1 dials a registered purpose, and a Dialer without the registry is unchanged', async () => {
    const server = await startPlainServer();
    try {
      const strict = createDialer({ purposes: isRegisteredPurpose });
      const open = createDialer();
      const target = (purpose: string) => ({
        host: '127.0.0.1',
        port: server.port,
        purpose,
      });

      (await strict.connect(target('amqp'), { kind: 'direct' })).destroy();
      (await open.connect(target('anything'), { kind: 'direct' })).destroy();

      expect(await acceptedAfterSettling(server)).toBe(2);
    } finally {
      await server.close();
    }
  });
});

describe('the outbound-calls page', () => {
  it('AC-1 the committed page is the one the registry renders', () => {
    expect(readFileSync(PAGE, 'utf8')).toBe(renderOutboundCallsPage(PURPOSES));
    expect(run('--check').status).toBe(0);
  });

  it('AC-1 --check fails on a hand-edited or a missing page, and writing repairs it', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'outbound-')), 'page.md');
    expect(run('--check', `--out=${out}`).status).toBe(1);

    expect(run(`--out=${out}`).status).toBe(0);
    expect(run('--check', `--out=${out}`).status).toBe(0);

    writeFileSync(out, readFileSync(out, 'utf8').replace('amqp', 'quietly'));
    const stale = run('--check', `--out=${out}`);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toMatch(/outbound-calls/);
  });

  it('AC-1 lists every purpose with its destination, trigger and default, and escapes a pipe', () => {
    const page = renderOutboundCallsPage([
      {
        id: 'x',
        feature: 'a | b',
        destination: 'd',
        trigger: 't',
        default: 'Off',
        status: 'planned',
      },
    ]);

    expect(page).toContain(
      '| `x` | a \\| b | d | t | Off | Registered, not built |',
    );
    for (const purpose of PURPOSES) {
      expect(readFileSync(PAGE, 'utf8')).toContain(`\`${purpose.id}\``);
      expect(readFileSync(PAGE, 'utf8')).toContain(purpose.destination);
    }
    expect(renderOutboundCallsPage([])).toContain(
      'No outbound call is registered.',
    );
  });
});
