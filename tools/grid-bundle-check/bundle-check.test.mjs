import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildBundle,
  bundledPackages,
  check,
  communityModuleNames,
  enterpriseInputs,
  packageOf,
  registeredModuleNames,
} from './bundle-check.mjs';

test('AC-3 the ui-grid bundle holds no AG Grid Enterprise module', async () => {
  const built = await buildBundle();
  assert.deepEqual(enterpriseInputs(built.metafile), []);
  assert.deepEqual(await check(built), []);
  // The control: the scan sees AG Grid Community, so an empty result means something.
  const packages = bundledPackages(built.metafile);
  assert.ok(packages.includes('ag-grid-community'));
  assert.ok(!packages.some((name) => /enterprise/.test(name)));
  // The adapter registers an explicit list, every entry a Community module.
  const registered = await registeredModuleNames();
  const community = await communityModuleNames();
  assert.ok(registered.length > 0 && registered.length <= 12);
  for (const name of registered) assert.ok(community.has(name), name);
  assert.ok(!registered.includes('AllCommunityModule'));
});

test('AC-3 the scan catches Enterprise inputs wherever pnpm puts them', () => {
  const planted = [
    'node_modules/ag-grid-enterprise/dist/package/main.esm.mjs',
    'node_modules/.pnpm/ag-grid-enterprise@36.2.0/node_modules/ag-grid-enterprise/dist/x.js',
    'node_modules/@ag-grid-enterprise/set-filter/dist/index.js',
    'node_modules/.pnpm/ag-charts-enterprise@14.2.0/node_modules/ag-charts-enterprise/dist/x.js',
  ];
  const metafile = {
    inputs: Object.fromEntries([
      ['node_modules/ag-grid-community/dist/package/main.esm.mjs', {}],
      ...planted.map((path) => [path, {}]),
    ]),
  };
  assert.deepEqual(enterpriseInputs(metafile), planted);
  assert.deepEqual(
    enterpriseInputs({
      inputs: {
        'node_modules/.pnpm/ag-grid-community@36.2.0/node_modules/ag-grid-community/dist/x.js':
          {},
        'node_modules/.pnpm/ag-stack@36.2.0/node_modules/ag-stack/dist/x.js':
          {},
        'libs/ui/grid/src/index.ts': {},
      },
    }),
    [],
  );
});

test('packageOf names the package of an input, scoped or not', () => {
  assert.equal(
    packageOf(
      'node_modules/.pnpm/@angular+core@22/node_modules/@angular/core/fesm2022/core.mjs',
    ),
    '@angular/core',
  );
  assert.equal(packageOf('node_modules/rxjs/dist/esm/index.js'), 'rxjs');
  assert.equal(packageOf('libs/ui/grid/src/index.ts'), undefined);
});
