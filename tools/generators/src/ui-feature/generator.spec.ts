import { describe, expect, it } from 'vitest';

import {
  diffOf,
  expectFormatted,
  parseJson,
  workspaceTree,
} from '../shared/test-utils.ts';
import { routePath, uiFeatureGenerator } from './generator.ts';

const root = 'libs/ui/feature-demo';

describe('ui-feature', () => {
  it('creates a lazy route, a component and an i18n scope', async () => {
    const tree = workspaceTree();

    const { created } = await diffOf(tree, () =>
      uiFeatureGenerator(tree, { name: 'demo', route: '/c/:cid/demo' }),
    );

    expect(created).toMatchSnapshot();
    await expectFormatted(created);
  });

  it('tags the project type:ui-feature and runtime:browser', async () => {
    const tree = workspaceTree();

    const { created } = await diffOf(tree, () =>
      uiFeatureGenerator(tree, { name: 'feature-demo', route: '/c/:cid/demo' }),
    );

    expect(
      parseJson<{ tags: string[] }>(created[`${root}/project.json`]).tags,
    ).toEqual(['type:ui-feature', 'runtime:browser']);
  });

  it('keeps all copy in the i18n file, not in the template', async () => {
    const tree = workspaceTree();

    const { created } = await diffOf(tree, () =>
      uiFeatureGenerator(tree, { name: 'demo', route: '/c/:cid/demo' }),
    );

    expect(created[`${root}/src/lib/demo.component.html`]).toBe(
      '<section>\n  <h1>{{ titleKey }}</h1>\n</section>\n',
    );
    expect(parseJson(created[`${root}/src/i18n/en.json`])).toEqual({
      demo: { title: 'Demo' },
    });
  });

  describe('routePath', () => {
    it.each([
      ['/c/:cid/explorer', 'c/:cid/explorer'],
      ['c/:cid/explorer/', 'c/:cid/explorer'],
      ['/settings', 'settings'],
    ])('turns %s into %s', (route, expected) => {
      expect(routePath(route)).toBe(expected);
    });

    it.each(['', '/', '/a b', '/a//b', '/a?b'])('refuses "%s"', (route) => {
      expect(() => routePath(route)).toThrow('--route');
    });
  });
});
