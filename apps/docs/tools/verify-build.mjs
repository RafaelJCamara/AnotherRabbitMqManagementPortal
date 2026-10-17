// Post-build checks for M0-06 acceptance criteria. Fails the build when:
//  - any HTML page lacks the Broadcom attribution or the non-affiliation line;
//  - the /adr index does not list every ADR in docs/adr;
//  - a required route is missing.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../../../dist/apps/docs', import.meta.url));
const adrDir = fileURLToPath(new URL('../../../docs/adr', import.meta.url));

const ATTRIBUTION =
  'RabbitMQ is a trademark of Broadcom, Inc. in the U.S. and other countries.';
const NON_AFFILIATION =
  'This project is not affiliated with, endorsed by, or sponsored by Broadcom,';

function htmlFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return htmlFiles(path);
    return path.endsWith('.html') ? [path] : [];
  });
}

const problems = [];
const normalise = (html) => html.replace(/\s+/g, ' ');

const pages = htmlFiles(dist);
for (const page of pages) {
  const html = normalise(readFileSync(page, 'utf8'));
  if (!html.includes(ATTRIBUTION))
    problems.push(`${page}: Broadcom attribution missing`);
  if (!html.includes(NON_AFFILIATION))
    problems.push(`${page}: non-affiliation line missing`);
}

for (const route of ['adr', 'matrix', 'security/outbound-calls']) {
  if (!existsSync(join(dist, route, 'index.html')))
    problems.push(`route /${route}/ missing`);
}

const expected = readdirSync(adrDir).filter((f) =>
  /^ADR-\d{3}-.*\.md$/.test(f),
);
const indexPath = join(dist, 'adr', 'index.html');
if (existsSync(indexPath)) {
  const html = readFileSync(indexPath, 'utf8');
  const listed = new Set([...html.matchAll(/>ADR-(\d{3})</g)].map((m) => m[1]));
  for (const file of expected) {
    const id = file.slice(4, 7);
    if (!listed.has(id)) problems.push(`/adr/ does not list ADR-${id}`);
  }
  if (listed.size !== expected.length) {
    problems.push(
      `/adr/ lists ${listed.size} ADRs, docs/adr has ${expected.length}`,
    );
  }
}

if (problems.length > 0) {
  console.error(`docs verification failed:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(
  `docs verification passed: ${pages.length} pages carry the attribution; /adr/ lists ${expected.length} ADRs.`,
);
