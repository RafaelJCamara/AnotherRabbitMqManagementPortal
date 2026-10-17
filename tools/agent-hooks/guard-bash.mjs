// PreToolUse hook for Bash (M0-07): blocks commands agents must not run.
//
//   stdin  : { tool_name: 'Bash', tool_input: { command }, cwd }
//   exit 2 : the command is blocked; stderr says why
//   exit 0 : the command may run
//
// Blocked (docs/plan/execution-plan.md section 2.4):
//   - pnpm add / install / update of a package that is not in tools/supply-chain/deps-allowlist.json,
//     that has no exact version, or that comes from a git, tarball or local source; bulk updates;
//     `--latest`
//   - --no-verify (and `git commit -n`)
//   - git push to main or master, any force push, --all and --mirror
//   - global installs (`npm i -g`, `pnpm add -g`, `yarn global add`) and npm/yarn/bun package adds
//
// The command line is split into simple commands with a small quote-aware tokenizer. It sees
// through `bash -c "..."`, `env`, `sudo` and similar wrappers, but it is a guard-rail against
// honest mistakes and drifting agents, not a sandbox.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { BLOCK, isMain, parsePayload, readStdin, repoRoot } from './lib.mjs';

const PROTECTED_BRANCHES = new Set(['main', 'master']);
const EXACT_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SEPARATORS = new Set([';', '&', '|', '(', ')', '{', '}', '\n']);

/** Removes redirections (`> file`, `2>`, `>>file`, `< file`) so file names are not read as arguments. */
function stripRedirections(words) {
  const kept = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';
    if (/^[0-9]*[<>]+$/.test(word))
      index += 1; // operator and its target
    else if (!/^[0-9]*[<>]/.test(word)) kept.push(word);
  }
  return kept;
}

/**
 * Splits a command line into simple commands (arrays of words). Quotes group words and are
 * removed; separators inside quotes do not split.
 * @param {string} line
 * @returns {string[][]}
 */
export function tokenize(line) {
  const segments = [];
  let words = [];
  let word = '';
  let inWord = false;
  let quote;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    const command = stripRedirections(words);
    if (command.length > 0) segments.push(command);
    words = [];
  };
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? '';
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
    } else if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === '\\' && index + 1 < line.length) {
        index += 1;
        word += line[index];
      } else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === '\\' && index + 1 < line.length) {
      index += 1;
      if (line[index] !== '\n') {
        word += line[index];
        inWord = true;
      }
    } else if (char === ' ' || char === '\t' || char === '\r') {
      endWord();
    } else if (SEPARATORS.has(char)) {
      endSegment();
    } else if (char === '#' && !inWord) {
      // A comment runs to the end of the line.
      while (index + 1 < line.length && line[index + 1] !== '\n') index += 1;
    } else {
      word += char;
      inWord = true;
    }
  }
  endSegment();
  return segments;
}

const WRAPPERS = new Set([
  'env',
  'command',
  'sudo',
  'nohup',
  'time',
  'exec',
  'nice',
  'xargs',
]);
const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const WINDOWS_SHELLS = new Set(['pwsh', 'powershell']);

const exeName = (word) =>
  basename(word.replaceAll('\\', '/'))
    .toLowerCase()
    .replace(/\.(exe|cmd|cjs|ps1)$/, '');

/** Drops leading `VAR=value` words and wrapper commands, then reports a nested shell script. */
function unwrap(words) {
  let rest = words;
  for (;;) {
    const first = rest[0];
    if (first === undefined) return { words: rest };
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
      rest = rest.slice(1);
    } else if (WRAPPERS.has(exeName(first))) {
      rest = rest.slice(1);
      while (
        rest[0] !== undefined &&
        (rest[0].startsWith('-') || /^[A-Za-z_]\w*=/.test(rest[0]))
      ) {
        rest = rest.slice(1);
      }
    } else {
      break;
    }
  }
  const shell = exeName(rest[0] ?? '');
  if (POSIX_SHELLS.has(shell)) {
    const flag = rest.findIndex(
      (word, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(word),
    );
    if (flag > 0 && rest[flag + 1] !== undefined)
      return { words: rest, script: rest[flag + 1] };
  } else if (WINDOWS_SHELLS.has(shell)) {
    const flag = rest.findIndex((word) => /^-(c|command)$/i.test(word));
    if (flag > 0 && rest[flag + 1] !== undefined) {
      return { words: rest, script: rest.slice(flag + 1).join(' ') };
    }
  } else if (shell === 'cmd') {
    const flag = rest.findIndex((word) => /^\/[ck]$/i.test(word));
    if (flag > 0)
      return { words: rest, script: rest.slice(flag + 1).join(' ') };
  }
  return { words: rest };
}

/** Splits words after the subcommand into flags and positionals, skipping flag values. */
function splitArguments(words, valueFlags) {
  const flags = [];
  const positionals = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';
    if (word === '--') {
      positionals.push(...words.slice(index + 1));
      break;
    }
    if (word.startsWith('-') && word.length > 1) {
      flags.push(word);
      if (valueFlags.has(word)) index += 1;
    } else {
      positionals.push(word);
    }
  }
  return { flags, positionals };
}

const hasShortFlag = (flags, letter) =>
  flags.some((flag) => /^-[a-zA-Z]+$/.test(flag) && flag.includes(letter));

// --------------------------------------------------------------------------------------------
// git
// --------------------------------------------------------------------------------------------

const GIT_GLOBAL_VALUE_FLAGS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
]);
const COMMIT_VALUE_FLAGS = new Set([
  '-m',
  '-F',
  '-C',
  '-c',
  '-t',
  '--message',
  '--file',
  '--author',
  '--date',
  '--template',
  '--reuse-message',
  '--reedit-message',
  '--cleanup',
  '--fixup',
  '--squash',
]);
const PUSH_VALUE_FLAGS = new Set([
  '-o',
  '--push-option',
  '--receive-pack',
  '--exec',
  '--repo',
]);

function checkGit(words, deps) {
  let index = 1;
  while (index < words.length && (words[index] ?? '').startsWith('-')) {
    index += GIT_GLOBAL_VALUE_FLAGS.has(words[index] ?? '') ? 2 : 1;
  }
  const sub = words[index];
  const rest = words.slice(index + 1);
  const reasons = [];

  if (rest.includes('--no-verify')) {
    reasons.push(
      '`--no-verify` skips the hooks; fix the failure instead of bypassing it',
    );
  }
  if (sub === 'commit') {
    const { flags } = splitArguments(rest, COMMIT_VALUE_FLAGS);
    if (hasShortFlag(flags, 'n')) {
      reasons.push(
        '`git commit -n` is `--no-verify`; fix the failure instead of bypassing the hooks',
      );
    }
  }
  if (sub === 'push') {
    const { flags, positionals } = splitArguments(rest, PUSH_VALUE_FLAGS);
    if (
      flags.some((flag) =>
        /^--force(?:-with-lease|-if-includes)?(?:=|$)/.test(flag),
      ) ||
      hasShortFlag(flags, 'f') ||
      positionals.some((spec) => spec.startsWith('+'))
    ) {
      reasons.push('force-pushing is not allowed');
    }
    if (flags.includes('--all') || flags.includes('--mirror')) {
      reasons.push(
        '`git push --all` and `--mirror` push main; push the work branch by name',
      );
    }
    const refspecs = positionals.slice(1);
    const branch = () => deps.currentBranch();
    const targets =
      refspecs.length === 0
        ? [branch()]
        : refspecs.map((spec) => {
            const dest = spec.replace(/^\+/, '').split(':').at(-1) ?? '';
            const name = dest.replace(/^refs\/heads\//, '');
            return name === 'HEAD' ? branch() : name;
          });
    if (
      targets.some((name) => name !== undefined && PROTECTED_BRANCHES.has(name))
    ) {
      reasons.push(
        'pushing to main is not allowed; push a work branch and open a PR',
      );
    }
  }
  return reasons;
}

// --------------------------------------------------------------------------------------------
// package managers
// --------------------------------------------------------------------------------------------

const PNPM_GLOBAL_VALUE_FLAGS = new Set([
  '-C',
  '--dir',
  '--filter',
  '-F',
  '--filter-prod',
  '--test-pattern',
]);
const PNPM_VALUE_FLAGS = new Set([
  ...PNPM_GLOBAL_VALUE_FLAGS,
  '--registry',
  '--tag',
  '--reporter',
  '--loglevel',
  '--save-prefix',
  '--network-concurrency',
  '--store-dir',
  '--virtual-store-dir',
  '--lockfile-dir',
]);
const ADD_COMMANDS = new Set(['add', 'install', 'i']);
const UPDATE_COMMANDS = new Set(['update', 'up', 'upgrade']);
const NPM_ADD_COMMANDS = new Set(['install', 'i', 'in', 'ins', 'add']);

/** Splits `name@version`, keeping the scope's leading `@`. */
export function parseSpec(spec) {
  const at = spec.indexOf('@', 1);
  return at < 0
    ? { name: spec }
    : { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

function checkSpec(spec, allowed) {
  const { name, version } = parseSpec(spec);
  if (
    /^(?:\.|\/|~)/.test(spec) ||
    (!spec.startsWith('@') && /^[a-z+]+:/i.test(spec))
  ) {
    return `${spec}: git, tarball and local-path dependencies are banned (DC-24)`;
  }
  if (version?.startsWith('workspace:') === true) return undefined;
  if (allowed === undefined) {
    return `${spec}: the allow-list tools/supply-chain/deps-allowlist.json could not be read`;
  }
  if (!allowed.has(name)) {
    return `${name} is not in tools/supply-chain/deps-allowlist.json; a new package needs an allow-list entry, an ADR-027 log line and owner approval`;
  }
  if (
    version === undefined ||
    !(EXACT_VERSION.test(version) || /^catalog:/.test(version))
  ) {
    return `${spec}: dependencies need an exact version (name@x.y.z) or name@catalog:`;
  }
  return undefined;
}

function checkPnpm(words, deps) {
  let index = 1;
  while (index < words.length && (words[index] ?? '').startsWith('-')) {
    index += PNPM_GLOBAL_VALUE_FLAGS.has(words[index] ?? '') ? 2 : 1;
  }
  const sub = words[index];
  const { flags, positionals } = splitArguments(
    words.slice(index + 1),
    PNPM_VALUE_FLAGS,
  );
  const reasons = [];
  const isAdd = ADD_COMMANDS.has(sub ?? '');
  const isUpdate = UPDATE_COMMANDS.has(sub ?? '');
  if (!isAdd && !isUpdate) return reasons;

  if (flags.includes('--global') || hasShortFlag(flags, 'g')) {
    reasons.push('global installs are not allowed');
  }
  if (isUpdate) {
    if (flags.includes('--latest') || hasShortFlag(flags, 'L')) {
      reasons.push(
        'never run `pnpm update --latest`; bumps go through Renovate or the security lane',
      );
    } else if (positionals.length === 0) {
      reasons.push(
        'bulk `pnpm update` is not allowed; bumps go through Renovate or the security lane',
      );
    }
  }
  if (positionals.length > 0) {
    const allowed = deps.allowlist();
    for (const spec of positionals) {
      const reason = checkSpec(spec, allowed);
      if (reason !== undefined) reasons.push(reason);
    }
  }
  return reasons;
}

function checkOtherPackageManager(manager, words) {
  const sub = words[1] ?? '';
  const { flags, positionals } = splitArguments(
    words.slice(2),
    new Set(['--prefix', '--registry']),
  );
  const global =
    flags.includes('--global') ||
    hasShortFlag(flags, 'g') ||
    (manager === 'yarn' && sub === 'global');
  if (global) return ['global installs are not allowed'];
  if (NPM_ADD_COMMANDS.has(sub) && positionals.length > 0) {
    return [
      `${manager} ${sub} adds packages outside the pnpm workspace rules; use pnpm with the allow-list`,
    ];
  }
  return [];
}

// --------------------------------------------------------------------------------------------

/**
 * Returns the reasons a command is blocked (empty when it is fine).
 * @param {string} command
 * @param {{ allowlist: () => Set<string> | undefined, currentBranch: () => string | undefined }} deps
 * @param {number} [depth]
 * @returns {string[]}
 */
export function check(command, deps, depth = 0) {
  const reasons = [];
  for (const segment of tokenize(command)) {
    const { words, script } = unwrap(segment);
    if (script !== undefined && depth < 3)
      reasons.push(...check(script, deps, depth + 1));
    const tool = exeName(words[0] ?? '');
    if (tool === 'git') reasons.push(...checkGit(words, deps));
    else if (tool === 'pnpm') reasons.push(...checkPnpm(words, deps));
    else if (tool === 'npm' || tool === 'yarn' || tool === 'bun') {
      reasons.push(...checkOtherPackageManager(tool, words));
    }
  }
  return [...new Set(reasons)];
}

function realDeps(root, cwd) {
  return {
    allowlist() {
      try {
        const file = resolve(
          root,
          'tools',
          'supply-chain',
          'deps-allowlist.json',
        );
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        return new Set(Object.keys(parsed.packages ?? {}));
      } catch {
        return undefined;
      }
    },
    currentBranch() {
      try {
        const out = execFileSync('git', ['branch', '--show-current'], {
          cwd: cwd ?? root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 5000,
        });
        return out.trim() || undefined;
      } catch {
        return undefined;
      }
    },
  };
}

async function main() {
  const { payload, error } = parsePayload(await readStdin());
  if (error !== undefined) {
    process.stderr.write(`guard-bash: ${error}\n`);
    process.exit(BLOCK);
  }
  const command = payload.tool_input?.command;
  if (typeof command !== 'string' || command === '') return;
  const reasons = check(command, realDeps(repoRoot(), payload.cwd));
  if (reasons.length > 0) {
    process.stderr.write(
      `guard-bash: blocked.\n${reasons.map((reason) => `- ${reason}`).join('\n')}\nSee AGENTS.md (forbidden actions, dependency policy). If you are stuck, open a draft PR labelled "blocked" that lists the question.\n`,
    );
    process.exit(BLOCK);
  }
}

if (isMain(import.meta.url)) await main();
