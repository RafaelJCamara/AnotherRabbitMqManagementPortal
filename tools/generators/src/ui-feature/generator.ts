// A type:ui-feature library: a lazy route the web shell mounts, a standalone component, and the
// i18n scope that holds its copy. It depends on ui-data, ui-design, ui-lib, ui-platform,
// contracts and pure, and never on another feature (blueprint 2.2).
//
// Not generated yet, because the pieces they extend do not exist: the dev gallery entry (web
// shell, M0-51), the Playwright + axe spec (apps/e2e-web) and the Transloco scope registration.
// See docs/open-questions.md.
import type { Tree } from '@nx/devkit';

import {
  resolveRoot,
  resolveRuntime,
  scaffoldLibrary,
} from '../shared/library.ts';
import { assertKebab, nameVariants, quote, stem } from '../shared/names.ts';
import { Writer } from '../shared/writer.ts';
import type { UiFeatureOptions } from './schema.ts';

const ROUTE = /^\/?[A-Za-z0-9:_-]+(?:\/[A-Za-z0-9:_-]+)*$/;

/** `/c/:cid/queues/` becomes `c/:cid/queues`: Angular route paths have no leading slash. */
export function routePath(route: string): string {
  if (!ROUTE.test(route.replace(/\/+$/, ''))) {
    throw new Error(
      `--route "${route}" must be a path such as /c/:cid/explorer: segments of letters, digits, - and _, or :params.`,
    );
  }
  return route.replace(/^\/+/, '').replace(/\/+$/, '');
}

export function uiFeatureFiles(
  feature: string,
  pascal: string,
  camel: string,
  path: string,
): Record<string, string> {
  return {
    'src/index.ts': `export { ${camel}Route } from './lib/${feature}.route';
`,
    [`src/lib/${feature}.route.ts`]: `import type { Route } from '@angular/router';

/**
 * Mounted by the web shell. The feature code is lazy: it loads when the route is first visited,
 * so a feature never adds to the initial bundle.
 */
export const ${camel}Route: Route = {
  path: ${quote(path)},
  loadChildren: () => import('./${feature}.routes').then((m) => m.${camel}Routes),
};
`,
    [`src/lib/${feature}.routes.ts`]: `import type { Routes } from '@angular/router';

export const ${camel}Routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./${feature}.component').then((m) => m.${pascal}Component),
  },
];
`,
    [`src/lib/${feature}.component.ts`]: `import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-${feature}',
  templateUrl: './${feature}.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ${pascal}Component {
  /** Copy comes from the i18n scope (src/i18n/en.json), never from the template. */
  protected readonly titleKey = '${feature}.title';
}
`,
    [`src/lib/${feature}.component.html`]: `<section>
  <h1>{{ titleKey }}</h1>
</section>
`,
    'src/i18n/en.json': `${JSON.stringify({ [feature]: { title: pascal } }, null, 2)}\n`,
    [`src/lib/${feature}.route.spec.ts`]: `import { describe, expect, it } from 'vitest';

import { ${camel}Route } from './${feature}.route';

describe('${camel}Route', () => {
  it('mounts at ${path}', () => {
    expect(${camel}Route.path).toBe(${quote(path)});
  });

  it('lazy-loads its child routes', () => {
    expect(${camel}Route.loadChildren).toBeTypeOf('function');
  });
});
`,
  };
}

export async function uiFeatureGenerator(
  tree: Tree,
  options: UiFeatureOptions,
): Promise<void> {
  const writer = new Writer(tree);
  assertKebab(options.name, 'feature name');
  const feature = stem(options.name, 'feature');
  const project = `feature-${feature}`;
  const { pascal, camel } = nameVariants(feature);
  const path = routePath(options.route);

  scaffoldLibrary(writer, {
    name: project,
    type: 'ui-feature',
    runtime: resolveRuntime('ui-feature', undefined),
    root: resolveRoot('ui-feature', project, options.directory),
    trustCritical: false,
    importPath: `@app/${project}`,
    projectType: 'library',
    readme: {
      purpose:
        options.description ??
        `The ${feature} feature of the web UI: say in one or two sentences what the user can do here.`,
      publicApi: [
        `\`${camel}Route\`: the lazy route the web shell mounts at \`/${path}\`.`,
      ],
      invariants: [
        'Depends on ui-data, ui-design, ui-lib, ui-platform, contracts and pure; never on another feature (blueprint 2.2).',
        'All copy lives in `src/i18n/*.json`; templates contain bindings only (`@app/ui-no-raw-template-text`, `@app/honest-wording`).',
        'Talks to the engine through EngineApi and the LiveChannel, never `fetch` or sockets (`@app/no-direct-fetch`).',
        'Renders untrusted text through bindings, never `innerHTML` (`@app/no-inner-html`).',
      ],
    },
    files: uiFeatureFiles(feature, pascal, camel, path),
  });

  await writer.flush();
}

export default uiFeatureGenerator;
