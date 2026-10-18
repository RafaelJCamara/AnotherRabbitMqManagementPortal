// Builds the spike page with the esbuild that @angular/build already ships (no new bundler).
//
//   dist/spikes-csp/index.html, probe.js     static shell (index.html carries {{NONCE}})
//   dist/spikes-csp/main.js, main.css, ...   AG Grid Community + Monaco + ELK client, split chunks
//   dist/spikes-csp/workers/*.js             Monaco ESM workers (editor, json)
//   dist/spikes-csp/assets/elk-worker.min.js elkjs worker copied byte for byte (DC-51)
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { depsModules, distDir, spikeRoot } from './paths.mjs';

// esbuild is a dependency of @angular/build; resolve it from there, not from the workspace root.
const angularBuild = createRequire(import.meta.url).resolve('@angular/build');
const esbuild = createRequire(angularBuild)('esbuild');

rmSync(distDir, { recursive: true, force: true });
mkdirSync(join(distDir, 'assets'), { recursive: true });

const common = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  // CSP_SPIKE_MINIFY=0 keeps stack frames readable when reading violation sources.
  minify: process.env['CSP_SPIKE_MINIFY'] !== '0',
  sourcemap: false,
  nodePaths: [depsModules],
  loader: { '.ttf': 'file' },
  assetNames: 'assets/[name]-[hash]',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
  absWorkingDir: spikeRoot,
};

// The page: AG Grid + Monaco + ELK client, with code splitting like the real Angular build.
await esbuild.build({
  ...common,
  entryPoints: {
    bootstrap: join(spikeRoot, 'src', 'bootstrap.js'),
    main: join(spikeRoot, 'src', 'main.js'),
  },
  outdir: distDir,
  splitting: true,
});

// Monaco's ESM workers are separate entry points (no splitting: a worker is one file).
await esbuild.build({
  ...common,
  entryPoints: {
    'workers/editor.worker': join(
      depsModules,
      'monaco-editor',
      'esm',
      'vs',
      'editor',
      'editor.worker.js',
    ),
    'workers/json.worker': join(
      depsModules,
      'monaco-editor',
      'esm',
      'vs',
      'language',
      'json',
      'json.worker.js',
    ),
  },
  outdir: distDir,
});

copyFileSync(join(spikeRoot, 'src', 'index.html'), join(distDir, 'index.html'));
copyFileSync(join(spikeRoot, 'src', 'probe.js'), join(distDir, 'probe.js'));

// elkjs ships its worker as a finished file. It is copied, never re-bundled or re-minified.
const elkSource = join(depsModules, 'elkjs', 'lib', 'elk-worker.min.js');
const elkTarget = join(distDir, 'assets', 'elk-worker.min.js');
copyFileSync(elkSource, elkTarget);
const sha = (file) =>
  createHash('sha256').update(readFileSync(file)).digest('hex');
if (sha(elkSource) !== sha(elkTarget)) {
  throw new Error('elk-worker.min.js was modified by the build');
}
console.log(
  `spikes-csp: built ${distDir} (elk-worker.min.js ${sha(elkTarget)})`,
);
