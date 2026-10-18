/* global window, document, location, getComputedStyle */
// S-04 harness page: AG Grid Community (infinite row model), Monaco (ESM workers) and the
// unmodified elkjs worker, all started under whatever CSP the server sent. Every step records
// ok/detail into `window.__spike.steps`; CSP and Trusted Types violations are recorded by probe.js.
//
// Query switches (`?grid-nonce=0`, `?nonce-patch=0`, `?worker-policy=0`, `?probe=expr`) remove one
// piece of the recommended library configuration so the driver can prove that piece is needed.
import './main.css';
import {
  AllCommunityModule,
  ModuleRegistry,
  createGrid,
} from 'ag-grid-community';
import * as monaco from 'monaco-editor/editor/editor.main.js';
import ELK from 'elkjs/lib/elk-api.js';
import { createWorker } from './trusted-types.js';

const spike = window.__spike;
const params = new URLSearchParams(location.search);
const nonce = document.querySelector('meta[name="csp-nonce"]')?.content ?? '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, what, timeoutMs = 8000) {
  const started = performance.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (performance.now() - started > timeoutMs)
      throw new Error(`timeout waiting for ${what}`);
    await sleep(25);
  }
}

async function step(name, run) {
  try {
    spike.steps[name] = { ok: true, detail: await run() };
  } catch (error) {
    spike.steps[name] = {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Counts <style> elements and how many carry a nonce (the attribute is hidden; `.nonce` is not). */
function styleReport() {
  const styles = [...document.querySelectorAll('style')];
  return {
    styleElements: styles.length,
    withNonce: styles.filter((style) => style.nonce !== '').length,
  };
}

async function gridStep() {
  ModuleRegistry.registerModules([AllCommunityModule]);
  const host = document.getElementById('grid');
  const columnDefs = [{ field: 'id' }, { field: 'name' }, { field: 'size' }];
  if (params.get('probe') === 'expr') {
    // String expressions make AG Grid call `new Function`: this is the unsafe-eval probe.
    columnDefs.push({ headerName: 'double', valueGetter: 'data.size * 2' });
  }
  createGrid(host, {
    ...(params.get('grid-nonce') === '0' ? {} : { styleNonce: nonce }),
    rowModelType: 'infinite',
    columnDefs,
    datasource: {
      getRows(request) {
        const rows = [];
        for (let i = request.startRow; i < request.endRow; i++) {
          rows.push({ id: i, name: `queue-${String(i)}`, size: i * 3 });
        }
        request.successCallback(rows, 5000);
      },
    },
  });
  const cells = await waitFor(
    () => host.querySelectorAll('.ag-cell').length,
    'AG Grid cells',
  );
  const root = host.querySelector('.ag-root-wrapper');
  const headerHeight =
    host.querySelector('.ag-header')?.getBoundingClientRect().height ?? 0;
  const detail = { cells, headerHeight, ...styleReport() };
  // Without its injected stylesheet the grid has no flex layout and a collapsed header.
  if (
    root === null ||
    getComputedStyle(root).display !== 'flex' ||
    headerHeight < 10
  ) {
    throw new Error(
      `AG Grid rendered without its stylesheet ${JSON.stringify(detail)}`,
    );
  }
  return detail;
}

async function monacoStep() {
  const host = document.getElementById('editor');
  const editor = monaco.editor.create(host, {
    value: '{\n  "queue": "orders",\n  "durable": true\n}\n',
    language: 'json',
    automaticLayout: true,
  });
  const model = editor.getModel();
  await waitFor(
    () => host.querySelector('.view-lines .view-line') !== null,
    'Monaco view lines',
  );
  // Visual checks: absolute line positions (inline style attributes) and token colours (<style>).
  await sleep(300);
  const tops = [...host.querySelectorAll('.view-line')].map((line) =>
    Math.round(line.getBoundingClientRect().top),
  );
  const colours = new Set(
    [...host.querySelectorAll('.view-line span span')].map(
      (span) => getComputedStyle(span).color,
    ),
  );
  const colorized = await monaco.editor.colorize('{"a": 1}', 'json', {});
  // The worker answers with markers once the JSON is wrong: proves the JSON worker runs.
  model.setValue('{\n  "queue": "orders",\n}\n');
  const markers = await waitFor(() => {
    const found = monaco.editor.getModelMarkers({ resource: model.uri });
    return found.length > 0 ? found : undefined;
  }, 'JSON worker diagnostics');
  // Open the suggest widget: widget DOM, list styles and a second round trip to the worker.
  editor.focus();
  editor.setPosition({ lineNumber: 2, column: 3 });
  editor.trigger('spike', 'editor.action.triggerSuggest', {});
  const suggestWidget = await waitFor(
    () => host.querySelector('.suggest-widget.visible') !== null,
    'Monaco suggest widget',
  ).then(
    () => true,
    () => false,
  );
  // Hover with Markdown contents: Monaco sanitises it with its bundled DOMPurify, which creates
  // its own Trusted Types policy ('dompurify') the first time it runs.
  monaco.languages.registerHoverProvider('json', {
    provideHover: () => ({ contents: [{ value: '**queue** hover text' }] }),
  });
  editor.setPosition({ lineNumber: 2, column: 5 });
  editor.trigger('spike', 'editor.action.showHover', {});
  const hover = await waitFor(
    () =>
      document
        .querySelector('.monaco-hover-content')
        ?.textContent.includes('hover text'),
    'Monaco hover',
  ).then(
    () => true,
    () => false,
  );
  const detail = {
    distinctLineTops: new Set(tops).size,
    lines: tops.length,
    tokenColours: colours.size,
    markers: markers.length,
    colorizedLength: colorized.length,
    suggestWidget,
    hover,
    ...styleReport(),
  };
  if (detail.distinctLineTops < detail.lines || detail.tokenColours < 2) {
    throw new Error(`Monaco rendered unstyled ${JSON.stringify(detail)}`);
  }
  return detail;
}

async function elkStep() {
  const elk = new ELK({
    workerUrl: '/assets/elk-worker.min.js',
    // elk-api.js builds `new Worker(string)`, which is a Trusted Types sink; hand it a factory.
    workerFactory: (url) => createWorker(url),
  });
  const result = await elk.layout({
    id: 'root',
    layoutOptions: { 'elk.algorithm': 'layered' },
    children: [
      { id: 'exchange', width: 70, height: 30 },
      { id: 'queue-a', width: 70, height: 30 },
      { id: 'queue-b', width: 70, height: 30 },
    ],
    edges: [
      { id: 'e1', sources: ['exchange'], targets: ['queue-a'] },
      { id: 'e2', sources: ['exchange'], targets: ['queue-b'] },
    ],
  });
  const svg = document.getElementById('graph');
  const ns = 'http://www.w3.org/2000/svg';
  for (const node of result.children ?? []) {
    if (typeof node.x !== 'number' || typeof node.y !== 'number') {
      throw new Error(`ELK returned no position for ${node.id}`);
    }
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', String(node.x));
    rect.setAttribute('y', String(node.y));
    rect.setAttribute('width', String(node.width));
    rect.setAttribute('height', String(node.height));
    svg.append(rect);
  }
  elk.terminateWorker();
  return { nodes: result.children?.length ?? 0 };
}

await step('grid', gridStep);
await step('monaco', monacoStep);
await step('elk', elkStep);
await sleep(300); // late, asynchronous violations
spike.styles = styleReport();
spike.done = true;
