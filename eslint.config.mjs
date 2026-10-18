// Workspace lint policy (M0-03): ESLint 10 flat config.
//
//   1. typescript-eslint strictTypeChecked for all TypeScript, angular-eslint for Angular code.
//   2. @nx/enforce-module-boundaries with the type/runtime/trust tags and the dependency table
//      from docs/architecture/blueprint.md section 2.2.
//   3. no-restricted-imports for the third-party confinement table (section 2.4), the banned list,
//      and node:* builtins in code that must run in a browser or in any runtime.
//
//   4. Project-specific rules from tools/eslint-rules (M0-04), registered as `@app/<rule>` and
//      scoped by path (section "Project rules" below).
//
// The policy tables below are plain data. `tools/lint-selftest` proves they bite.
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative, sep } from 'node:path';

import js from '@eslint/js';
import json from '@eslint/json';
import nx from '@nx/eslint-plugin';
import angular from 'angular-eslint';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Node loads the TypeScript plugin directly (type stripping), so there is no build step.
import appRules from './tools/eslint-rules/src/index.ts';

const root = import.meta.dirname;

// ---------------------------------------------------------------------------------------------
// Tags (blueprint 2.1). `type:net` is an addition: it names the `net-*` projects that adapters
// may import (section 2.2 row "adapter").
// ---------------------------------------------------------------------------------------------
const CONTRACTS = 'type:contracts';
const PURE = 'type:pure';
const PORT = 'type:port';
const KERNEL = 'type:kernel';
const ADAPTER = 'type:adapter';
const NET = 'type:net';
const SERVICE = 'type:service';
const TRANSPORT = 'type:transport';
const APP = 'type:app';
const UI_PLATFORM = 'type:ui-platform';
const UI_DATA = 'type:ui-data';
const UI_DESIGN = 'type:ui-design';
const UI_LIB = 'type:ui-lib';
const UI_FEATURE = 'type:ui-feature';
const SDK = 'type:sdk';

const ISOMORPHIC = 'runtime:isomorphic';
const NODE = 'runtime:node';
const BROWSER = 'runtime:browser';
const ELECTRON_MAIN = 'runtime:electron-main';
const ELECTRON_PRELOAD = 'runtime:electron-preload';

// A project may only depend on projects that carry one of the listed tags. A project's own
// imports (relative, inside the project) are always allowed, so listing a tag here lets a
// project depend on *other* projects with that tag. That is why `type:service` does not list
// itself: a service never imports another service.
const layerConstraints = [
  { sourceTag: CONTRACTS, onlyDependOnLibsWithTags: [CONTRACTS] },
  { sourceTag: PURE, onlyDependOnLibsWithTags: [CONTRACTS, PURE] },
  { sourceTag: PORT, onlyDependOnLibsWithTags: [CONTRACTS, PURE, PORT] },
  {
    sourceTag: KERNEL,
    onlyDependOnLibsWithTags: [CONTRACTS, PURE, PORT, KERNEL],
  },
  {
    sourceTag: ADAPTER,
    onlyDependOnLibsWithTags: [CONTRACTS, PURE, PORT, NET],
  },
  { sourceTag: NET, onlyDependOnLibsWithTags: [CONTRACTS, PURE, PORT, NET] },
  {
    sourceTag: SERVICE,
    onlyDependOnLibsWithTags: [CONTRACTS, PURE, PORT, KERNEL, SDK],
  },
  { sourceTag: TRANSPORT, onlyDependOnLibsWithTags: [KERNEL, CONTRACTS, PORT] },
  {
    // Composition roots (apps/engine, apps/web, ...). What an app can reach is bounded by its
    // runtime tag below, so the engine cannot import UI libraries and the web app cannot import
    // engine libraries.
    sourceTag: APP,
    onlyDependOnLibsWithTags: [
      CONTRACTS,
      PURE,
      PORT,
      KERNEL,
      ADAPTER,
      NET,
      SERVICE,
      TRANSPORT,
      UI_PLATFORM,
      UI_DATA,
      UI_DESIGN,
      UI_LIB,
      UI_FEATURE,
      SDK,
    ],
  },
  // UI layers: section 2.2 only specifies ui-feature. The lower layers are inferred so that
  // dependencies flow platform -> data -> lib/design -> feature and never back up.
  {
    sourceTag: UI_PLATFORM,
    onlyDependOnLibsWithTags: [CONTRACTS, PURE, UI_PLATFORM],
  },
  {
    sourceTag: UI_DATA,
    onlyDependOnLibsWithTags: [CONTRACTS, PURE, UI_PLATFORM, UI_DATA],
  },
  {
    sourceTag: UI_DESIGN,
    onlyDependOnLibsWithTags: [CONTRACTS, PURE, UI_DESIGN],
  },
  {
    sourceTag: UI_LIB,
    onlyDependOnLibsWithTags: [
      CONTRACTS,
      PURE,
      UI_PLATFORM,
      UI_DATA,
      UI_DESIGN,
      UI_LIB,
    ],
  },
  {
    // Never another feature: ui-feature is deliberately absent from this list.
    sourceTag: UI_FEATURE,
    onlyDependOnLibsWithTags: [
      UI_DATA,
      UI_DESIGN,
      UI_LIB,
      UI_PLATFORM,
      CONTRACTS,
      PURE,
    ],
  },
  { sourceTag: SDK, onlyDependOnLibsWithTags: [CONTRACTS, PURE, SDK] },
  // type:test projects (testkit, e2e, perf) may depend on anything; nothing but another test
  // project may depend on them, because no other constraint lists type:test.
];

const runtimeConstraints = [
  { sourceTag: ISOMORPHIC, onlyDependOnLibsWithTags: [ISOMORPHIC] },
  { sourceTag: BROWSER, onlyDependOnLibsWithTags: [BROWSER, ISOMORPHIC] },
  { sourceTag: NODE, onlyDependOnLibsWithTags: [NODE, ISOMORPHIC] },
  {
    sourceTag: ELECTRON_MAIN,
    onlyDependOnLibsWithTags: [ELECTRON_MAIN, NODE, ISOMORPHIC],
  },
  {
    sourceTag: ELECTRON_PRELOAD,
    onlyDependOnLibsWithTags: [ELECTRON_PRELOAD, ISOMORPHIC],
  },
];

// Section 2.2: contracts depend on zod only. Spec files may also import the test runner.
const externalConstraints = [
  { sourceTag: CONTRACTS, allowedExternalImports: ['zod'] },
];
const specExternalConstraints = [
  {
    sourceTag: CONTRACTS,
    allowedExternalImports: ['zod', 'vitest', 'vitest/*', 'fast-check'],
  },
];

// trust:critical carries no dependency rule. It marks paths that need human CODEOWNERS sign-off.
const boundariesRule = (externals) => [
  'error',
  {
    enforceBuildableLibDependency: false,
    allow: [],
    depConstraints: [...layerConstraints, ...runtimeConstraints, ...externals],
  },
];

// ---------------------------------------------------------------------------------------------
// Third-party confinement (blueprint 2.4). Each entry lists the import specifiers and the only
// locations that may use them. A location is a path relative to the workspace root; globs are
// allowed. A trailing `*` on a specifier means "any package starting with this prefix".
// ---------------------------------------------------------------------------------------------
const confinement = [
  {
    names: ['amqplib', '@cloudamqp/amqp-client'],
    only: ['libs/engine/adapter-amqp091', 'apps/conformance'],
  },
  {
    names: ['rhea'],
    only: ['libs/engine/adapter-amqp10', 'testing/oracle-amqp10'],
  },
  {
    names: ['undici'],
    only: [
      'libs/engine/adapter-mgmt-http',
      'libs/engine/adapter-prometheus',
      'libs/engine/net-dialer',
      'libs/engine/svc-alerts/src/**/notify',
    ],
  },
  {
    names: ['node:sqlite', 'better-sqlite3', 'pg', 'kysely'],
    only: ['libs/engine/persistence'],
  },
  { names: ['ssh2', 'socks'], only: ['libs/engine/net-dialer'] },
  {
    // I-9: every outbound socket goes through the Dialer and the TrustStore (M0-26). Anything else
    // that needs `net` or `tls` is a listener or a local pipe of its own, or test and tooling code.
    // OQ-183 lists why each location is here.
    names: ['net', 'node:net', 'tls', 'node:tls'],
    only: [
      'libs/engine/net-dialer',
      'libs/engine/net-truststore',
      'libs/engine/adapter-amqp091',
      'libs/engine/adapter-amqp10',
      'libs/engine/adapter-mgmt-http',
      'libs/engine/adapter-prometheus',
      'libs/engine/adapter-stream',
      'libs/engine/adapter-k8s',
      'libs/engine/transport',
      'apps/engine',
      'apps/cli',
      'apps/desktop',
      'apps/conformance',
      'libs/testkit',
      'testing',
      'tools',
    ],
  },
  {
    names: ['@kubernetes/client-node'],
    only: ['libs/engine/adapter-k8s', 'libs/engine/net-dialer'],
  },
  {
    names: ['openid-client'],
    only: ['libs/engine/svc-identity/src/**/oidc', 'libs/engine/svc-access'],
  },
  { names: ['pino', 'pino-*'], only: ['libs/engine/kernel'] },
  { names: ['quickjs-emscripten'], only: ['libs/engine/plugin-host'] },
  { names: ['fastify', 'ws'], only: ['libs/engine/transport', 'apps/engine'] },
  { names: ['electron'], only: ['apps/desktop'] },
  // `spikes/csp` is the throwaway S-04 harness (M0-20, OQ-230): it loads the three heavy UI
  // libraries from a scratch install, never from the workspace catalog.
  { names: ['ag-grid-*'], only: ['libs/ui/grid', 'spikes/csp'] },
  {
    names: ['cytoscape', 'elkjs', 'dagre'],
    only: ['libs/ui/graph', 'spikes/csp'],
  },
  {
    names: ['@foblex/flow'],
    only: ['libs/ui/graph/flow', 'libs/ui/graph/src/flow'],
  },
  { names: ['monaco-editor'], only: ['libs/ui/editor', 'spikes/csp'] },
  { names: ['uplot', 'echarts', 'ngx-echarts'], only: ['libs/ui/charts'] },
  { names: ['rabbitmq-amqp-js-client'], only: ['testing/oracle-amqp10'] },
];

// Banned everywhere (blueprint 2.4). Version-only bans (typescript@7, primeng>=22 as a version)
// and git/tarball sources are dependency-level and belong to the supply-chain gates (M0-02).
const banned = [
  '@types/amqplib',
  '@nestjs/*',
  'nestjs-zod',
  '@nx/nest',
  'orval',
  'primeng',
  '@primeui/*',
  'ag-grid-enterprise',
  'apexcharts',
  'ngx-monaco-editor-v2',
];

// Node builtins (`node:fs`, and bare `fs`, `path`, ...) are not allowed in code that runs in a
// browser, in a sandboxed preload, or in any runtime (isomorphic, contracts, pure, UI).
const nodeBuiltins = [
  'node:*',
  ...builtinModules.filter(
    (name) => !name.startsWith('_') && !name.startsWith('node:'),
  ),
];
const runtimesWithoutNode = new Set([ISOMORPHIC, BROWSER, ELECTRON_PRELOAD]);

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
// `pkg` matches `pkg` and `pkg/sub/path`; `prefix-*` and `@scope/*` match by prefix.
const specifierRegex = (name) =>
  name.endsWith('*')
    ? `^${escapeRegExp(name.slice(0, -1))}`
    : `^${escapeRegExp(name)}(?:/|$)`;

const toRestriction = (names, message) => ({
  regex: names.map(specifierRegex).join('|'),
  message,
});

const restrictionRule = ({ confined, nodeBanned }) => [
  'error',
  {
    patterns: [
      ...confined.map(({ names, only }) =>
        toRestriction(
          names,
          `${names.join(', ')} may only be imported from ${only.join(', ')} (blueprint 2.4, third-party confinement).`,
        ),
      ),
      toRestriction(
        banned,
        'Banned dependency (blueprint 2.4, banned everywhere).',
      ),
      ...(nodeBanned
        ? [
            toRestriction(
              nodeBuiltins,
              'Node builtins are not allowed in isomorphic, contracts, pure, browser or preload code (blueprint 2.1).',
            ),
          ]
        : []),
    ],
  },
];

// ---------------------------------------------------------------------------------------------
// Zones: every project root plus every confinement location. Sorted by length so a nested zone
// (libs/ui/graph/flow inside libs/ui/graph) overrides its parent. In each zone the rule lists the
// confined packages that are NOT allowed there; node builtins depend on the owning project's tags.
// ---------------------------------------------------------------------------------------------
const scanRoots = ['apps', 'libs', 'tools', 'testing', 'packaging'];
const skipDirs = new Set([
  'node_modules',
  'dist',
  'coverage',
  'tmp',
  '.angular',
  '.nx',
]);

function findProjects(dir, found = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !skipDirs.has(entry.name)) {
      findProjects(join(dir, entry.name), found);
    } else if (entry.name === 'project.json') {
      const config = JSON.parse(readFileSync(join(dir, entry.name), 'utf8'));
      found.push({
        root: relative(root, dir).split(sep).join('/'),
        tags: config.tags ?? [],
      });
    }
  }
  return found;
}

const projects = scanRoots.flatMap((name) => findProjects(join(root, name)));

const covers = (location, zone) =>
  zone === location || zone.startsWith(`${location}/`);
const owningProject = (zone) =>
  projects
    .filter((project) => covers(project.root, zone))
    .sort((a, b) => b.root.length - a.root.length)[0];

const zones = [
  ...new Set([
    ...projects.map((project) => project.root),
    ...confinement.flatMap(({ only }) => only),
  ]),
].sort((a, b) => a.length - b.length || a.localeCompare(b));

const sourceFiles = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'];
const zoneBlocks = zones.map((zone) => {
  const tags = owningProject(zone)?.tags ?? [];
  return {
    name: `confinement/${zone}`,
    files: [`${zone}/**/*.{${sourceFiles.join(',')}}`],
    rules: {
      'no-restricted-imports': restrictionRule({
        confined: confinement.filter(
          ({ only }) => !only.some((location) => covers(location, zone)),
        ),
        nodeBanned: tags.some((tag) => runtimesWithoutNode.has(tag)),
      }),
    },
  };
});

// ---------------------------------------------------------------------------------------------
// Project rules (tools/eslint-rules, M0-04). Each entry names the invariant it guards, where it
// applies, and where it deliberately does not. Paths are relative to the workspace root.
// ---------------------------------------------------------------------------------------------
const tsFiles = ['**/*.ts', '**/*.mts', '**/*.cts'];
const tsIn = (...dirs) => dirs.map((dir) => `${dir}/**/*.{ts,mts,cts}`);
const specs = ['**/*.spec.ts', '**/*.test.ts'];
const appPlugin = { '@app': appRules };

const projectRules = [
  {
    // I-3 / DC-01: broker versions are data. Only the registry and the capability probe may
    // compare them.
    name: 'app/broker-versions',
    files: tsIn('libs', 'apps'),
    ignores: ['libs/shared/semantics/**', 'libs/engine/svc-capabilities/**'],
    plugins: appPlugin,
    rules: { '@app/no-broker-version-compare': 'error' },
  },
  {
    // ADR-001: services never ask which delivery mode they run in. Composition code may.
    name: 'app/delivery-mode',
    files: tsIn('libs/engine', 'apps/engine'),
    ignores: [
      'apps/engine/src/entry/**',
      'apps/engine/src/modes/**',
      'apps/engine/src/modules/**',
    ],
    plugins: appPlugin,
    rules: { '@app/no-mode-branching': 'error' },
  },
  {
    // I-6: engine buffers are BoundedRing or BoundedQueue. The primitives themselves are exempt.
    name: 'app/bounded-buffers',
    files: tsIn('libs/engine', 'apps/engine'),
    ignores: ['libs/engine/kernel/src/bounded/**', ...specs],
    plugins: appPlugin,
    rules: { '@app/bounded-buffers-only': 'error' },
  },
  {
    // Contracts are explicit (ADR-003). Applies wherever zod schemas are written or imported.
    name: 'app/zod-schemas',
    files: tsIn('libs', 'apps'),
    plugins: appPlugin,
    rules: { '@app/explicit-zod-schemas': 'error' },
  },
  {
    // ADR-021: no innerHTML anywhere, in TypeScript or in Angular templates.
    name: 'app/no-inner-html',
    files: [...tsIn('libs', 'apps'), 'apps/web/**/*.html', 'libs/ui/**/*.html'],
    plugins: appPlugin,
    rules: { '@app/no-inner-html': 'error' },
  },
  {
    // UI traffic goes through EngineApi/HttpClient and the LiveChannel. libs/ui/platform owns the
    // transports (HttpBackend, LiveChannel), so it is the one place that may open sockets.
    name: 'app/no-direct-fetch',
    files: tsIn('apps/web', 'libs/ui'),
    ignores: ['libs/ui/platform/**'],
    plugins: appPlugin,
    rules: { '@app/no-direct-fetch': 'error' },
  },
  {
    // DC-15: UI strings that make claims about message reads. i18n JSON is covered below.
    name: 'app/honest-wording-code',
    files: tsIn('apps/web', 'libs/ui'),
    ignores: specs,
    plugins: appPlugin,
    rules: { '@app/honest-wording': 'error' },
  },
  {
    // UI copy lives in the i18n files. index.html is the document shell, not an Angular template.
    name: 'app/ui-templates',
    files: ['apps/web/**/*.html', 'libs/ui/**/*.html'],
    ignores: ['**/index.html'],
    plugins: appPlugin,
    rules: { '@app/ui-no-raw-template-text': 'error' },
  },
  {
    // DC-15 over the translation files (Transloco). Every locale is checked.
    name: 'app/i18n-json',
    files: ['**/i18n/**/*.json', '**/locales/**/*.json'],
    plugins: { json, ...appPlugin },
    language: 'json/json',
    rules: { '@app/honest-wording': 'error' },
  },
];

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

export default defineConfig(
  {
    name: 'ignores',
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/tmp/**',
      '.nx/**',
      '.angular/**',
      // Planted violations: linted only by tools/lint-selftest, which disables ignore patterns.
      'tools/lint-selftest/fixtures/**',
    ],
  },

  {
    name: 'js',
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },

  {
    name: 'typescript',
    files: tsFiles,
    extends: [
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: root },
    },
  },

  {
    // Plain JavaScript (this file, tool scripts) has no tsconfig, so no type information.
    name: 'javascript-untyped',
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  {
    name: 'angular-typescript',
    files: ['apps/web/**/*.ts', 'libs/ui/**/*.ts'],
    extends: [angular.configs.tsRecommended],
    processor: angular.processInlineTemplates,
    rules: {
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'app', style: 'camelCase' },
      ],
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'app', style: 'kebab-case' },
      ],
    },
  },
  {
    name: 'angular-templates',
    files: ['apps/web/**/*.html', 'libs/ui/**/*.html'],
    extends: [
      angular.configs.templateRecommended,
      angular.configs.templateAccessibility,
    ],
  },

  {
    name: 'module-boundaries',
    files: [...tsFiles, '**/*.{js,mjs,cjs}'],
    plugins: { '@nx': nx },
    rules: {
      '@nx/enforce-module-boundaries': boundariesRule(externalConstraints),
    },
  },
  {
    name: 'module-boundaries/specs',
    files: ['**/*.spec.ts', '**/*.test.ts', '**/vitest.config.mts'],
    rules: {
      '@nx/enforce-module-boundaries': boundariesRule(specExternalConstraints),
    },
  },

  {
    name: 'confinement/baseline',
    files: [...tsFiles, '**/*.{js,mjs,cjs}'],
    rules: {
      'no-restricted-imports': restrictionRule({
        confined: confinement,
        nodeBanned: false,
      }),
    },
  },
  ...zoneBlocks,

  ...projectRules,

  {
    // Planted violations used by tools/lint-selftest. They are real files that must fail lint, so
    // they carry no type information and tools/lint-selftest loads them with `ignore: false`.
    name: 'lint-selftest-fixtures',
    files: ['tools/lint-selftest/fixtures/**'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { parserOptions: { projectService: false } },
  },

  // Must stay last: turns off every formatting rule that would fight Prettier.
  { name: 'prettier', ...prettier },
);
