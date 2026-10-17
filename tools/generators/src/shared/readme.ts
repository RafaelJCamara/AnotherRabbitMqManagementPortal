// The README every project carries (blueprint section 2.4, "Uniform service shape"): purpose,
// public API, invariants and proof commands.

export interface ReadmeSpec {
  name: string;
  /** What the project is for, as one or two sentences. */
  purpose: string;
  tags: readonly string[];
  /** What the project exports, one entry per line. */
  publicApi: readonly string[];
  /** Rules that must keep holding; each one should have a test or a lint rule behind it. */
  invariants: readonly string[];
  /** Commands that prove the project works; the default set is always listed first. */
  proof?: readonly string[];
}

const bullets = (items: readonly string[]): string =>
  items.map((item) => `- ${item}`).join('\n');

export function renderReadme(spec: ReadmeSpec): string {
  const proof = [
    `pnpm nx run-many -t lint typecheck test -p ${spec.name}`,
    ...(spec.proof ?? []),
  ];
  return `# ${spec.name}

${spec.purpose}

Tags: ${spec.tags.map((tag) => `\`${tag}\``).join(', ')}.

## Public API

${bullets(spec.publicApi)}

## Invariants

${bullets(spec.invariants)}

## Proof commands

\`\`\`sh
${proof.join('\n')}
\`\`\`
`;
}
