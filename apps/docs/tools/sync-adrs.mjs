// Copies docs/adr/ADR-*.md into the Starlight content tree and generates the
// ADR index. docs/adr stays the single source of truth; the copy is gitignored.
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// ADR-027-log.md is the exclusion log for ADR-027, not an ADR.
const ADR_FILE = /^ADR-(\d{3})-(?!log\.md$).*\.md$/;

/** `ADR-007-foo.md` -> `adr-007` (stable, short URL: /adr/adr-007/). */
function slugFor(id) {
  return `adr-${id}`;
}

function field(body, name) {
  const match = body.match(new RegExp(`^- \\*\\*${name}:\\*\\*\\s*(.+)$`, 'm'));
  return match ? match[1].trim() : '';
}

/** Escape `<` that would otherwise start a raw HTML tag, outside code. */
function escapeAngles(markdown) {
  let inFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line
        .split(/(`[^`]*`)/)
        .map((part) =>
          part.startsWith('`')
            ? part
            : part.replace(/<(?=[A-Za-z/!])/g, '&lt;'),
        )
        .join('');
    })
    .join('\n');
}

/**
 * Repo-relative links do not exist on the site. ADR-to-ADR links become site
 * links; every other relative link is reduced to its text plus the repo path.
 */
function rewriteLinks(markdown) {
  return markdown.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (whole, text, target) => {
      if (/^(https?:|mailto:|#)/.test(target)) return whole;
      const adr = target.match(/(?:^|\/)ADR-(\d{3})-[^/]*\.md(#.*)?$/);
      if (adr) return `[${text}](../${slugFor(adr[1])}/${adr[2] ?? ''})`;
      const path = target
        .replace(/^(\.\.\/)+/, 'docs/')
        .replace(/^\.\//, 'docs/adr/');
      const bare = text.replace(/`/g, '');
      return bare === target || bare === path
        ? `\`${path}\``
        : `${text} (\`${path}\`)`;
    },
  );
}

function yamlString(value) {
  return JSON.stringify(value);
}

export function syncAdrs({ source, target }) {
  const files = readdirSync(source)
    .filter((f) => ADR_FILE.test(f))
    .sort();
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  const rows = [];
  for (const file of files) {
    const id = file.match(ADR_FILE)[1];
    const raw = readFileSync(join(source, file), 'utf8').replace(/\r\n/g, '\n');
    const heading = raw.match(/^# (.+)$/m);
    if (!heading) throw new Error(`${file}: missing H1 title`);
    const title = heading[1].trim();
    const body = raw.replace(heading[0], '').trim();
    const status = field(body, 'Status');
    const date = field(body, 'Date');
    const name = title.replace(/^ADR-\d{3}:\s*/, '');
    rows.push({ id, name, status, date });

    const page = [
      '---',
      `title: ${yamlString(title)}`,
      `description: ${yamlString(`Status: ${status || 'unknown'}`)}`,
      `editUrl: false`,
      '---',
      '',
      escapeAngles(rewriteLinks(body)),
      '',
    ].join('\n');
    writeFileSync(join(target, `${slugFor(id)}.md`), page);
  }

  const first = rows[0]?.id;
  const last = rows.at(-1)?.id;
  const table = rows
    .map(
      (r) =>
        `| [ADR-${r.id}](./${slugFor(r.id)}/) | ${escapeAngles(r.name).replace(/\|/g, '\\|')} | ${r.status} |`,
    )
    .join('\n');
  const index = [
    '---',
    'title: Architecture decision records',
    `description: ${yamlString(`${rows.length} ADRs, ADR-${first} to ADR-${last}`)}`,
    'editUrl: false',
    '---',
    '',
    `This index lists **${rows.length} ADRs** (ADR-${first} to ADR-${last}), generated from \`docs/adr\` at build time.`,
    '',
    'ADR-001 to ADR-028 are the decisions of the original architecture blueprint; every later ADR was added after it. The Status column shows the current state of each decision.',
    '',
    '| ADR | Title | Status |',
    '| --- | --- | --- |',
    table,
    '',
  ].join('\n');
  writeFileSync(join(target, 'index.md'), index);
  return rows;
}
