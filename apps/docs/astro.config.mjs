import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightOpenAPI, { openAPISidebarGroups } from 'starlight-openapi';
import { syncAdrs } from './tools/sync-adrs.mjs';

const adrSource = fileURLToPath(new URL('../../docs/adr', import.meta.url));
const adrTarget = fileURLToPath(
  new URL('./src/content/docs/adr', import.meta.url),
);

// The ADRs stay in /docs/adr; this copies them into the (gitignored) content
// tree before every build or dev session so the site never forks them.
const adrSync = {
  name: 'sync-adrs',
  hooks: {
    'astro:config:setup': () => {
      syncAdrs({ source: adrSource, target: adrTarget });
    },
  },
};

export default defineConfig({
  outDir: '../../dist/apps/docs',
  integrations: [
    adrSync,
    starlight({
      title: '<Product> for RabbitMQ®',
      description:
        'Documentation for <Product>, an open-source workbench and control plane for RabbitMQ.',
      // The repository and product name are private until ADR-029 is accepted.
      head: [
        {
          tag: 'meta',
          attrs: { name: 'robots', content: 'noindex, nofollow' },
        },
      ],
      components: { Footer: './src/components/Footer.astro' },
      plugins: [
        starlightOpenAPI([
          {
            base: 'api',
            label: 'Engine API',
            // The committed output of @app/contracts (nx run contracts:api-docs), not a hand-written file.
            schema: '../../docs/api/openapi.v1.json',
          },
        ]),
      ],
      sidebar: [
        { label: 'Overview', link: '/' },
        { label: 'Architecture decisions', link: '/adr/' },
        {
          label: 'All ADRs',
          collapsed: true,
          items: [{ autogenerate: { directory: 'adr' } }],
        },
        { label: 'Conformance matrix', link: '/matrix/' },
        {
          label: 'Security',
          items: [
            { label: 'Outbound calls', link: '/security/outbound-calls/' },
          ],
        },
        ...openAPISidebarGroups,
      ],
    }),
  ],
});
